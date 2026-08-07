/*
 * Choose a Sync's records, encode their bytes, and size its notifications —
 * the pure, hardware-free seam behind the BLE Sync (tickets 07, 14a, 15d).
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * A Sync streams the Buffer's Samples to a connected client oldest-first, several
 * packed per GATT notification over the negotiated large ATT MTU (CONTEXT.md,
 * ADR-0002). Three correctness-critical, purely computational pieces live here so
 * host ztests exercise them free of BLE (see tests/sync/): deciding which of the
 * Buffer's Samples the client still needs (the High-water-mark trim) and aging
 * them, packing one of those records into its wire bytes, and computing how many
 * whole records fit in one notification. The "Sync data record" and
 * "Notification packing" sections of docs/wire-contract.md are the single source
 * of truth for the latter two; this module names no layout the contract does not.
 *
 * Age lives here rather than in the Buffer: it is a property of a Sample as seen
 * by one Sync, measured against that Sync's Latched read instant, not of a
 * buffered Sample.
 */

#ifndef KUUKI_SYNC_H
#define KUUKI_SYNC_H

#include <stdbool.h>
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
 * One Sync data record: a buffered Sample aged against its Sync's Latched read
 * instant (age = latch_uptime − capture_uptime), so it is already placed
 * relative to that one instant. Its fields mirror the 10-byte wire layout, so it
 * serialises straight out with no repacking.
 */
struct sync_record {
	uint32_t age;      /* latch_uptime − capture_uptime, seconds */
	uint16_t co2;      /* ppm */
	int16_t  temp;     /* centi-°C */
	uint16_t humidity; /* centi-%RH */
};

/*
 * A Sync in progress: the records one client still needs, streamed straight out
 * of the ring. Fields are internal; drive it with sync_iter_next().
 */
struct sync_iter {
	struct buffer_iter samples; /* a copy of the frozen walk, taken at init */
	uint32_t latch_uptime;
	uint32_t high_water_age;
	uint32_t sample_interval_sec;
	bool trimming; /* still swallowing the Samples the client holds */
};

/*
 * Begin answering a Sync over a copy of `frozen`, a Buffer iterator the caller
 * has already created, yielding the Samples this client still needs,
 * oldest-first.
 *
 * The Buffer iterator is created by the caller rather than here because
 * freezing it must happen *before* latch_uptime is read, and this module stays
 * clock-free so it runs under host tests. Doing both at the call site puts the
 * freeze, the clock read and this call on three consecutive lines, where the
 * ordering constraint is visible. It is what makes the Age subtraction safe: the
 * frozen batch cannot grow, and a monotonic clock read after the freeze is at or
 * after every capture time in it, so the unsigned subtraction cannot wrap.
 *
 * high_water_age is the Age of the client's newest known Sample, measured on
 * *its* clock; MARK_SENTINEL means "send everything". A Sample is swallowed
 * unless it is at least half a Sample interval newer than the mark: that guard
 * band snaps the mark to the Sample-interval slot it names, so sub-interval skew
 * still excludes exactly the boundary Sample the client holds while every
 * genuinely newer Sample — a full interval further on — passes.
 *
 * The mark is a bandwidth optimisation only; over-sending is always safe,
 * because the webapp's Merge is idempotent (CONTEXT.md).
 */
void sync_iter_init(struct sync_iter *it, const struct buffer_iter *frozen,
		    uint32_t latch_uptime, uint32_t high_water_age,
		    uint32_t sample_interval_sec);

/*
 * Write the next record the client needs into *out and advance, or return false
 * once the Sync's records are exhausted (*out untouched).
 */
bool sync_iter_next(struct sync_iter *it, struct sync_record *out);

/*
 * Pack one record into its RECORD_SIZE wire bytes, little-endian: age at offset
 * 0, co2 at 4, temp at 6, humidity at 8. temp is signed and packs as
 * two's-complement.
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
