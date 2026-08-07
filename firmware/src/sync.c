/*
 * Sync record selection + data encoding + notification sizing — implementation.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * See sync.h for the contract. Pure Buffer reads, byte packing, and integer math
 * over a struct sync_record: no BLE, no sensor subsystem, no clock, so the whole
 * module runs under host ztests. Little-endian to match docs/wire-contract.md
 * and Web Bluetooth's natural DataView reads.
 */

#include <zephyr/sys/byteorder.h>

#include "sync.h"

void sync_iter_init(struct sync_iter *it, const struct buffer_iter *frozen,
		    uint32_t latch_uptime, uint32_t high_water_age,
		    uint32_t sample_interval_sec)
{
	it->samples = *frozen;
	it->latch_uptime = latch_uptime;
	it->high_water_age = high_water_age;
	it->sample_interval_sec = sample_interval_sec;
	it->trimming = high_water_age != MARK_SENTINEL;
}

bool sync_iter_next(struct sync_iter *it, struct sync_record *out)
{
	struct sample s;

	while (buffer_iter_next(&it->samples, &s)) {
		uint32_t age = it->latch_uptime - s.capture_uptime;

		/* Samples arrive oldest-first with strictly decreasing Age, so
		 * the ones the client already holds are a leading prefix:
		 * swallow it, and the first Sample past it ends the trim for
		 * good rather than re-deciding per record. */
		if (it->trimming) {
			if (age + it->sample_interval_sec / 2 >=
			    it->high_water_age) {
				continue;
			}
			it->trimming = false;
		}

		out->age = age;
		out->co2 = s.co2;
		out->temp = s.temp;
		out->humidity = s.humidity;
		return true;
	}

	return false;
}

void sync_encode_record(const struct sync_record *r, uint8_t out[RECORD_SIZE])
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
