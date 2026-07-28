/*
 * kuuki-pod firmware — application entry point.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Boots the board, brings up BLE, and starts sampling: the Pod advertises its
 * open GATT service (Pod ID + Live reading, ticket 06) and logs the SCD40 into
 * the in-RAM Buffer at each Sample tick (ticket 05). The correctness-critical
 * logic (the Buffer snapshot, the Sync collect() query, the Measurement→Sample
 * scaling, the Live reading packing) is developed off-board as pure modules
 * under tests/, run on the host via native_sim. The Sample interval and the
 * Buffer's size are project parameters this layer owns (app_config.h, ticket
 * 14b) and passes down.
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
 */
static struct sample sample_storage[KUUKI_BUFFER_CAPACITY];
static struct buffer sample_buffer;

/*
 * Serialises Buffer access between the two threads that share it: the sampler
 * writes it at each Sample tick, a Sync reads it via collect() (ticket 07). The
 * application owns the lock and hands it to both so the Buffer module itself
 * stays pure (no Zephyr primitives).
 */
static K_MUTEX_DEFINE(buffer_lock);

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

	err = ble_start(&sample_buffer, &buffer_lock);
	if (err) {
		LOG_ERR("BLE failed to start (%d)", err);
	}

	err = sampler_start(&sample_buffer, &buffer_lock,
			    CONFIG_KUUKI_SAMPLE_INTERVAL_SEC);
	if (err) {
		LOG_ERR("Sampler failed to start (%d)", err);
	}

	return 0;
}
