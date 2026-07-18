/*
 * Sample tick loop — implementation.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * See sampler.h for the contract. This is the hardware-facing seam (I²C, the
 * sensor subsystem, timing); the correctness-critical scaling and Buffer logic
 * it calls into (measurement_to_sample(), buffer_put()) are the pure, tested
 * modules. Kept deliberately thin so nothing subtle lives on the untested side.
 */

#include <stdlib.h>

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/sensor.h>
#include <zephyr/logging/log.h>

#include "buffer.h"
#include "measurement.h"
#include "sampler.h"

LOG_MODULE_REGISTER(sampler, LOG_LEVEL_INF);

/* The single SCD40 on the I²C bus, resolved from the devicetree at build time. */
static const struct device *const scd40 = DEVICE_DT_GET_ONE(sensirion_scd40);

/*
 * The SCD40 in low-power periodic mode yields its first Measurement ~30 s after
 * start-up and a fresh one every ~30 s thereafter. Wait past that first latency
 * before the first Sample tick so the first stored Sample is a real Measurement
 * rather than the driver's power-on zero. This is only a promptness aid — the
 * CO₂ == 0 guard in sample_tick() is what actually guarantees no bogus Sample.
 */
#define SCD40_FIRST_MEASUREMENT_SEC 30

#define SAMPLER_STACK_SIZE 2048
#define SAMPLER_PRIORITY   7

static K_THREAD_STACK_DEFINE(sampler_stack, SAMPLER_STACK_SIZE);
static struct k_thread sampler_thread;

/* The application's long-lived Buffer, borrowed for the sampler's lifetime. */
static struct buffer *target;

/* Read the SCD40's latest Measurement and store it as one Sample. */
static void sample_tick(void)
{
	struct sensor_value co2, temp, humidity;
	int err;

	err = sensor_sample_fetch(scd40);
	if (err) {
		LOG_WRN("SCD40 sample fetch failed (%d); skipping tick", err);
		return;
	}

	sensor_channel_get(scd40, SENSOR_CHAN_CO2, &co2);

	/* Until its first Measurement is ready the SCD40 driver reports success
	 * from sample_fetch without refreshing its data, so channel_get hands
	 * back the power-on zero (or, transiently, the previous reading). A real
	 * room is never 0 ppm CO₂, so treat 0 as "no fresh Measurement yet" and
	 * skip this tick rather than store a bogus Sample. */
	if (co2.val1 <= 0) {
		LOG_DBG("No fresh Measurement yet; skipping Sample tick");
		return;
	}

	sensor_channel_get(scd40, SENSOR_CHAN_AMBIENT_TEMP, &temp);
	sensor_channel_get(scd40, SENSOR_CHAN_HUMIDITY, &humidity);

	uint32_t capture_uptime = (uint32_t)(k_uptime_get() / 1000);
	struct sample s =
		measurement_to_sample(capture_uptime, &co2, &temp, &humidity);
	buffer_put(target, &s);

	LOG_INF("Sample @%us: CO2 %u ppm, temp %d.%02d C, humidity %u.%02u %%",
		s.capture_uptime, s.co2, s.temp / 100, abs(s.temp % 100),
		s.humidity / 100, s.humidity % 100);
}

static void sampler_run(void *p1, void *p2, void *p3)
{
	ARG_UNUSED(p1);
	ARG_UNUSED(p2);
	ARG_UNUSED(p3);

	/* Let the sensor produce its first Measurement before the first tick. */
	k_sleep(K_SECONDS(SCD40_FIRST_MEASUREMENT_SEC));

	for (;;) {
		sample_tick();
		k_sleep(K_SECONDS(SAMPLE_INTERVAL_SEC));
	}
}

int sampler_start(struct buffer *buf)
{
	if (!device_is_ready(scd40)) {
		LOG_ERR("SCD40 not ready; sampling disabled");
		return -ENODEV;
	}

	target = buf;
	k_thread_create(&sampler_thread, sampler_stack, SAMPLER_STACK_SIZE,
			sampler_run, NULL, NULL, NULL, SAMPLER_PRIORITY, 0,
			K_NO_WAIT);
	k_thread_name_set(&sampler_thread, "sampler");

	LOG_INF("Sampler started: one Sample every %d s", SAMPLE_INTERVAL_SEC);
	return 0;
}
