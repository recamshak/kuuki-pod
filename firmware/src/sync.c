/*
 * Sync data encoding + notification sizing — implementation.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * See sync.h for the contract. Pure byte packing and integer math over a
 * struct sync_record: no BLE, no sensor subsystem, so the whole module runs
 * under host ztests. Little-endian to match docs/wire-contract.md and Web
 * Bluetooth's natural DataView reads.
 */

#include <zephyr/sys/byteorder.h>

#include "sync.h"

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
