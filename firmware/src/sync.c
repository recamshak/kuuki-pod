/*
 * Sync record selection + data encoding + notification sizing — implementation.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * See sync.h for the contract. Pure Buffer reads, byte packing, and integer math
 * over a struct aged_sample: no BLE, no sensor subsystem, so the whole module
 * runs under host ztests. Little-endian to match docs/wire-contract.md and Web
 * Bluetooth's natural DataView reads.
 */

#include <string.h>

#include <zephyr/sys/byteorder.h>

#include "sync.h"

size_t sync_collect(const struct buffer *buf, uint32_t latch_uptime,
		    uint32_t high_water_age, uint32_t sample_interval_sec,
		    struct aged_sample *out, size_t out_cap)
{
	size_t n = buffer_snapshot(buf, latch_uptime, out, out_cap);

	if (high_water_age == MARK_SENTINEL) {
		return n;
	}

	/* Records are oldest-first with strictly decreasing Age, so the Samples
	 * the client already holds are a leading prefix: count it, then shift the
	 * rest down to out[0]. */
	size_t seen = 0;

	while (seen < n && out[seen].age + sample_interval_sec / 2 >= high_water_age) {
		seen++;
	}

	if (seen > 0) {
		memmove(out, &out[seen], (n - seen) * sizeof(*out));
	}

	return n - seen;
}

void sync_encode_record(const struct aged_sample *r, uint8_t out[RECORD_SIZE])
{
	sys_put_le32(r->age, &out[0]);
	sys_put_le16(r->co2, &out[4]);
	sys_put_le16((uint16_t)r->temp, &out[6]);
	sys_put_le16(r->humidity, &out[8]);
}

size_t sync_records_per_notification(uint16_t att_mtu)
{
	if (att_mtu < ATT_NTF_OVERHEAD + RECORD_SIZE) {
		return 0;
	}
	return (att_mtu - ATT_NTF_OVERHEAD) / RECORD_SIZE;
}
