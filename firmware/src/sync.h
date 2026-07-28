/*
 * Choose a Sync's record set, encode its bytes, and size its notifications —
 * the pure, hardware-free seam behind the BLE Sync (tickets 07, 14a).
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * A Sync streams the Buffer's Samples to a connected client oldest-first, several
 * packed per GATT notification over the negotiated large ATT MTU (CONTEXT.md,
 * ADR-0002). Three correctness-critical, purely computational pieces live here so
 * host ztests exercise them free of BLE (see tests/sync/): deciding which of the
 * Buffer's Samples the client still needs (the High-water-mark trim), packing one
 * of those records into its wire bytes, and computing how many whole records fit
 * in one notification. The "Sync data record" and "Notification packing" sections
 * of docs/wire-contract.md are the single source of truth for the latter two;
 * this module names no layout the contract does not.
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
 * High-water mark sentinel: "I have nothing for this Pod — send everything."
 * This module is the code home of the wire contract's MARK_SENTINEL (as it is
 * for RECORD_SIZE), so no other module redefines it. A real Age is far below it
 * (~30-day Buffer ⇒ max Age ≈ 2.6 M s), so it never collides with a real mark.
 */
#define MARK_SENTINEL UINT32_MAX

/*
 * Answer a Sync: fill out[0..out_cap) with the Samples this client still needs,
 * oldest-first, and return how many were written.
 *
 * Takes the Buffer's whole snapshot at latch_uptime and drops the Samples the
 * client already holds. high_water_age is the Age of the client's newest known
 * Sample, measured on *its* clock; MARK_SENTINEL means "send everything". A
 * Sample is trimmed unless it is at least half a Sample interval newer than the
 * mark: that guard band snaps the mark to the Sample-interval slot it names, so
 * sub-interval skew still excludes exactly the boundary Sample the client holds
 * while every genuinely newer Sample — a full interval further on — passes.
 *
 * The mark is a bandwidth optimisation only; over-sending is always safe,
 * because the webapp's Merge is idempotent (CONTEXT.md).
 *
 * Precondition (inherited from buffer_snapshot): out_cap >= the Buffer's
 * capacity. The trim runs *after* the snapshot, so an undersized out_cap would
 * discard the newest Samples before the trim ever sees them and could answer a
 * Sync with nothing while unsent Samples remain.
 */
size_t sync_collect(const struct buffer *buf, uint32_t latch_uptime,
		    uint32_t high_water_age, uint32_t sample_interval_sec,
		    struct aged_sample *out, size_t out_cap);

/*
 * Pack one sync_collect()-produced aged Sample into its RECORD_SIZE wire bytes,
 * little-endian: age at offset 0, co2 at 4, temp at 6, humidity at 8. temp is
 * signed and packs as two's-complement.
 */
void sync_encode_record(const struct aged_sample *r, uint8_t out[RECORD_SIZE]);

/*
 * How many whole records fit in one notification at the negotiated att_mtu:
 * floor((att_mtu − ATT_NTF_OVERHEAD) / RECORD_SIZE). A record is never split
 * across notifications, so a partial trailing record never counts. Returns 0 if
 * the MTU cannot hold even one record.
 */
size_t sync_records_per_notification(uint16_t att_mtu);

#endif /* KUUKI_SYNC_H */
