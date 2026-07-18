/*
 * Live reading encoding — implementation.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * See live.h for the contract. Pure byte packing over a struct sample: no BLE,
 * no sensor subsystem, so the whole module runs under host ztests. Little-endian
 * to match docs/wire-contract.md and Web Bluetooth's natural DataView reads.
 */

#include <zephyr/sys/byteorder.h>

#include "live.h"

void live_encode(const struct sample *s, uint8_t out[LIVE_READING_SIZE])
{
	sys_put_le16(s->co2, &out[0]);
	sys_put_le16((uint16_t)s->temp, &out[2]);
	sys_put_le16(s->humidity, &out[4]);
}
