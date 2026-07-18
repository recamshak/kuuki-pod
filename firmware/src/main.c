/*
 * kuuki-pod firmware — application entry point.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Boots the board, brings up BLE, and starts sampling: the Pod advertises its
 * open GATT service (Pod ID + Live reading, ticket 06) and logs the SCD40 into
 * the in-RAM Buffer at each Sample tick (ticket 05). The Sync characteristics
 * that stream the Buffer land in a later ticket. The correctness-critical logic
 * (the Buffer collect() query, the Measurement→Sample scaling, the Live reading
 * packing) is developed off-board as pure modules under tests/, run on the host
 * via native_sim.
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "ble.h"
#include "buffer.h"
#include "pod_id.h"
#include "sampler.h"

LOG_MODULE_REGISTER(kuuki_pod, LOG_LEVEL_INF);

/*
 * The Pod's single long-lived Buffer. Static (not on a stack): it spans ~30
 * days of Samples and is ~28 KB. Sampling fills it; a later ticket's Sync reads
 * it. RAM-only by design — a reset costs at most the unsynced tail (CONTEXT.md).
 */
static struct buffer sample_buffer;

int main(void)
{
	LOG_INF("kuuki-pod booting");

	buffer_init(&sample_buffer);

	/* Mint-or-load the Pod ID before BLE: the GATT service serves it. A
	 * failure here would advertise an unstable identity, so bail out. */
	int err = pod_id_init();
	if (err) {
		LOG_ERR("Pod ID init failed (%d); not advertising", err);
		return 0;
	}

	err = ble_start();
	if (err) {
		LOG_ERR("BLE failed to start (%d)", err);
	}

	err = sampler_start(&sample_buffer);
	if (err) {
		LOG_ERR("Sampler failed to start (%d)", err);
	}

	return 0;
}
