/*
 * Sample tick loop — implementation.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * See sampler.h for the contract. This is the hardware-facing seam (I²C, the
 * sensor subsystem, timing); the correctness-critical scaling and Buffer logic
 * it calls into (measurement_to_sample(), buffer_put()) and the Live reading
 * packing (live_encode(), via ble_live_update()) are the pure, tested modules.
 * Kept deliberately thin so nothing subtle lives on the untested side.
 */

#include <stdlib.h>

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/sensor.h>
#include <zephyr/logging/log.h>

#include "ble.h"
#include "buffer.h"
#include "measurement.h"
#include "sampler.h"

LOG_MODULE_REGISTER(sampler, LOG_LEVEL_INF);

/* The single SCD40 on the I²C bus, resolved from the devicetree at build time. */
static const struct device *const scd40 = DEVICE_DT_GET_ONE(sensirion_scd40);

/*
 * The SCD40 in low-power periodic mode yields its first Measurement ~30 s after
 * start-up and a fresh one every ~30 s thereafter. Wait past that first latency
 * before the first read so the first Live reading and Sample reflect a real
 * Measurement rather than the driver's power-on zero. This is only a promptness
 * aid — the CO₂ == 0 guard in read_measurement() is what actually guarantees no
 * bogus reading is published or stored.
 */
#define SCD40_FIRST_MEASUREMENT_SEC 30

/*
 * How often the sampler wakes to grab a fresh Measurement. Matches the SCD40's
 * ~30 s low-power periodic cadence: each wake refreshes the Live reading, so a
 * client that connects between Sample ticks still sees a near-current reading.
 */
#define MEASUREMENT_INTERVAL_SEC 30

#define SAMPLER_STACK_SIZE 2048
#define SAMPLER_PRIORITY   7

static K_THREAD_STACK_DEFINE(sampler_stack, SAMPLER_STACK_SIZE);
static struct k_thread sampler_thread;

/* The application's long-lived Buffer, borrowed for the sampler's lifetime. */
static struct buffer *target;

/* Serialises Buffer writes here against the Sync reader (ticket 07). */
static struct k_mutex *buffer_lock;

/*
 * Read the SCD40's latest Measurement into *out. Returns true on a fresh, real
 * Measurement; false (nothing written) when the fetch fails or the sensor has
 * not produced a real Measurement yet, so the caller skips this wake.
 */
static bool read_measurement(struct sample *out)
{
	struct sensor_value co2, temp, humidity;
	int err;

	err = sensor_sample_fetch(scd40);
	if (err) {
		LOG_WRN("SCD40 sample fetch failed (%d); skipping", err);
		return false;
	}

	sensor_channel_get(scd40, SENSOR_CHAN_CO2, &co2);

	/* Until its first Measurement is ready the SCD40 driver reports success
	 * from sample_fetch without refreshing its data, so channel_get hands
	 * back the power-on zero (or, transiently, the previous reading). A real
	 * room is never 0 ppm CO₂, so treat 0 as "no fresh Measurement yet" and
	 * skip rather than publish or store a bogus reading. */
	if (co2.val1 <= 0) {
		LOG_DBG("No fresh Measurement yet; skipping");
		return false;
	}

	sensor_channel_get(scd40, SENSOR_CHAN_AMBIENT_TEMP, &temp);
	sensor_channel_get(scd40, SENSOR_CHAN_HUMIDITY, &humidity);

	uint32_t capture_uptime = (uint32_t)(k_uptime_get() / 1000);
	*out = measurement_to_sample(capture_uptime, &co2, &temp, &humidity);
	return true;
}

static void sampler_run(void *p1, void *p2, void *p3)
{
	ARG_UNUSED(p1);
	ARG_UNUSED(p2);
	ARG_UNUSED(p3);

	/* Let the sensor produce its first Measurement before the first read. */
	k_sleep(K_SECONDS(SCD40_FIRST_MEASUREMENT_SEC));

	/* INT64_MIN forces the first real Measurement to promote to a Sample; the
	 * next promotion is a full Sample interval later. Capture uptime (not a
	 * wake count) gates promotion, so a skipped wake never shifts the tick. */
	int64_t last_sample_uptime = INT64_MIN;

	for (;;) {
		struct sample s;

		if (read_measurement(&s)) {
			/* Refresh the Live reading on every Measurement, so a
			 * client sees "right now" without awaiting a Sample tick. */
			ble_live_update(&s);

			if (last_sample_uptime == INT64_MIN ||
			    (int64_t)s.capture_uptime - last_sample_uptime >=
				    SAMPLE_INTERVAL_SEC) {
				/* Hold buffer_lock so a concurrent Sync's
				 * collect() never reads a half-written ring. */
				k_mutex_lock(buffer_lock, K_FOREVER);
				buffer_put(target, &s);
				k_mutex_unlock(buffer_lock);
				last_sample_uptime = s.capture_uptime;

				LOG_INF("Sample @%us: CO2 %u ppm, temp %d.%02d C, "
					"humidity %u.%02u %%",
					s.capture_uptime, s.co2, s.temp / 100,
					abs(s.temp % 100), s.humidity / 100,
					s.humidity % 100);
			}
		}

		k_sleep(K_SECONDS(MEASUREMENT_INTERVAL_SEC));
	}
}

int sampler_start(struct buffer *buf, struct k_mutex *buf_lock)
{
	if (!device_is_ready(scd40)) {
		LOG_ERR("SCD40 not ready; sampling disabled");
		return -ENODEV;
	}

	target = buf;
	buffer_lock = buf_lock;
	k_thread_create(&sampler_thread, sampler_stack, SAMPLER_STACK_SIZE,
			sampler_run, NULL, NULL, NULL, SAMPLER_PRIORITY, 0,
			K_NO_WAIT);
	k_thread_name_set(&sampler_thread, "sampler");

	LOG_INF("Sampler started: Measurement every %d s, Sample every %d s",
		MEASUREMENT_INTERVAL_SEC, SAMPLE_INTERVAL_SEC);
	return 0;
}
