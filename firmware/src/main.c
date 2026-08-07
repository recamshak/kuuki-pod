/*
 * kuuki-pod firmware — application entry point.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Boots the board, brings up BLE, and starts sampling: the Pod advertises its
 * open GATT service (Pod ID + Live reading, ticket 06) and logs the SCD40 into
 * the in-RAM Buffer at each Sample tick (ticket 05). The correctness-critical
 * logic (the Buffer's frozen iteration, the Sync record selection, the
 * Measurement→Sample scaling, the Live reading packing) is developed off-board
 * as pure modules under tests/, run on the host via native_sim. The Sample
 * interval and the Buffer's size are project parameters this layer owns
 * (app_config.h, ticket 14b) and passes down.
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "app_config.h"
#include "ble.h"
#include "buffer.h"
#include "pod_id.h"
#include "sampler.h"

LOG_MODULE_REGISTER(kuuki_pod, LOG_LEVEL_INF);

/*
 * The Pod's single long-lived Buffer and the storage it rings over. The
 * application owns the array — its size is the retention decision (~30 days at
 * the configured Sample interval, ~34 KB), which is why it is derived here from
 * the project parameters and handed to the ring rather than baked into it.
 * Static (not on a stack): sampling fills it and Sync reads it for the lifetime
 * of the Pod. RAM-only by design — a reset costs at most the unsynced tail
 * (CONTEXT.md).
 *
 * It is the Retention target *plus* the Buffer's runway: the runway's slots are
 * reserved for the lock-free Sync reader (ADR-0005) and are not retention, so
 * paying 48 bytes for them keeps the ~30-day promise intact.
 */
static struct sample sample_storage[KUUKI_RETENTION_SAMPLES + BUFFER_RUNWAY];
static struct buffer sample_buffer;

/* The Buffer's precondition, checked where the ring is actually sized. It holds
 * transitively today (the Kconfig range forbids a zero-Sample retention target),
 * but a ring no longer than the runway has no live Samples at all and no runtime
 * check would catch it (ADR-0005). */
BUILD_ASSERT(ARRAY_SIZE(sample_storage) > BUFFER_RUNWAY,
	     "The Buffer's storage must be longer than its runway");

int main(void)
{
	LOG_INF("kuuki-pod booting");

	buffer_init(&sample_buffer, sample_storage, ARRAY_SIZE(sample_storage));

	/* Mint-or-load the Pod ID before BLE: the GATT service serves it. A
	 * failure here would advertise an unstable identity, so bail out. */
	int err = pod_id_init();
	if (err) {
		LOG_ERR("Pod ID init failed (%d); not advertising", err);
		return 0;
	}

	err = ble_start(&sample_buffer);
	if (err) {
		LOG_ERR("BLE failed to start (%d)", err);
	}

	err = sampler_start(&sample_buffer, CONFIG_KUUKI_SAMPLE_INTERVAL_SEC);
	if (err) {
		LOG_ERR("Sampler failed to start (%d)", err);
	}

	return 0;
}
