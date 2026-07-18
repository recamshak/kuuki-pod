/*
 * Encode the Sync data stream's bytes and size its notifications — the pure,
 * hardware-free seam behind the BLE Sync (ticket 07).
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * A Sync streams the Buffer's Samples to a connected client oldest-first, several
 * packed per GATT notification over the negotiated large ATT MTU (CONTEXT.md,
 * ADR-0002). Two correctness-critical, purely computational pieces live here so
 * host ztests exercise them free of BLE (see tests/sync/): packing one
 * collect()-produced record into its wire bytes, and computing how many whole
 * records fit in one notification. The "Sync data record" and "Notification
 * packing" sections of docs/wire-contract.md are the single source of truth for
 * both; this module names no layout the contract does not.
 */

#ifndef KUUKI_SYNC_H
#define KUUKI_SYNC_H

#include <stddef.h>
#include <stdint.h>

#include "buffer.h"

/*
 * Bytes per Sync data record: age (uint32) + co2 (uint16) + temp (int16) +
 * humidity (uint16), packed back-to-back, no padding. This is the wire
 * contract's canonical RECORD_SIZE; this module is its one code home (as live.h
 * owns LIVE_READING_SIZE), so no other module redefines it.
 */
#define RECORD_SIZE 10

/*
 * ATT bytes a notification costs on top of its payload: 1-byte opcode + 2-byte
 * handle. Usable payload per notification is ATT_MTU − ATT_NTF_OVERHEAD. Mirrors
 * the wire contract's ATT_NTF_OVERHEAD.
 */
#define ATT_NTF_OVERHEAD 3

/*
 * Pack one collect()-produced record into its RECORD_SIZE wire bytes,
 * little-endian: age at offset 0, co2 at 4, temp at 6, humidity at 8. temp is
 * signed and packs as two's-complement.
 */
void sync_encode_record(const struct sync_record *r, uint8_t out[RECORD_SIZE]);

/*
 * How many whole records fit in one notification at the negotiated att_mtu:
 * floor((att_mtu − ATT_NTF_OVERHEAD) / RECORD_SIZE). A record is never split
 * across notifications, so a partial trailing record never counts. Returns 0 if
 * the MTU cannot hold even one record.
 */
size_t sync_records_per_notification(uint16_t att_mtu);

#endif /* KUUKI_SYNC_H */
