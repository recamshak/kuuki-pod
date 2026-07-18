/*
 * kuuki-pod firmware — application entry point.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Boots the board and starts sampling: the SCD40 is logged into the in-RAM
 * Buffer at each Sample tick (ticket 05). The BLE GATT service that Syncs the
 * Buffer lands in a later ticket. The correctness-critical logic (the Buffer
 * collect() query, the Measurement→Sample scaling) is developed off-board as
 * pure modules under tests/, run on the host via native_sim.
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "buffer.h"
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

	int err = sampler_start(&sample_buffer);
	if (err) {
		LOG_ERR("Sampler failed to start (%d)", err);
	}

	return 0;
}
