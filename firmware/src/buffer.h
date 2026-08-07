/*
 * In-RAM ring Buffer of Samples.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * This is a correctness-critical, hardware-free module: no BLE, no I²C. The
 * Buffer holds the most recent `capacity` Samples (overwriting the oldest on
 * overflow) and hands back a snapshot of everything it holds, entirely as a
 * function of its inputs, so the whole module is exercised by host ztests (see
 * tests/buffer/). It is a dumb ring: how many Samples that is (a retention
 * decision — see ../Kconfig and app_config.h), which of them a given client
 * still needs, and how they are framed on the wire are all somebody else's
 * business (see sync.h). Field widths mirror the wire contract
 * (docs/wire-contract.md) so no repacking is needed on the way out; vocabulary
 * (Sample, Age, Latched read instant) follows CONTEXT.md.
 */

#ifndef KUUKI_BUFFER_H
#define KUUKI_BUFFER_H

#include <stddef.h>
#include <stdint.h>

/*
 * One buffered Sample: a Measurement promoted at a Sample tick, plus the device
 * capture time needed to place it on a wall clock later. capture_uptime is the
 * Pod's monotonic uptime in seconds; the Pod has no notion of wall-clock time.
 */
struct sample {
	uint32_t capture_uptime; /* monotonic uptime at capture, seconds */
	uint16_t co2;            /* ppm */
	int16_t  temp;           /* centi-°C */
	uint16_t humidity;       /* centi-%RH */
};

/*
 * One aged Sample: what buffer_snapshot() emits per stored Sample. Carries Age
 * rather than capture time (Age = latch_uptime − capture_uptime), so it is
 * already placed relative to a Latched read instant. Its fields mirror the
 * 10-byte wire layout, so it serialises straight out with no repacking.
 */
struct aged_sample {
	uint32_t age;      /* latch_uptime − capture_uptime, seconds */
	uint16_t co2;      /* ppm */
	int16_t  temp;     /* centi-°C */
	uint16_t humidity; /* centi-%RH */
};

/*
 * The in-RAM ring Buffer. Holds up to `capacity` Samples in caller-provided
 * storage; once full, buffer_put() overwrites the oldest so it always holds the
 * most recent `capacity` of them. Fields are internal — tests must exercise
 * behaviour through the functions below, never this layout.
 *
 * Its position is one monotonic count of Samples ever written — the write head
 * — never a write-index / stored-count pair, so the two can never disagree
 * about where the ring starts. The count is a fixed 32 bits rather than a
 * size_t so the ring behaves identically on the 32-bit device and in the host
 * test build; it wraps after 2^32 writes, which is over a century even if a
 * Sample were written every second.
 */
struct buffer {
	struct sample *samples; /* borrowed storage, `capacity` Samples long */
	size_t capacity;        /* slots in `samples`, > 0 */
	uint32_t written;       /* Samples ever written — the write head */
};

/*
 * Reset a Buffer to empty over `capacity` Samples of caller-provided storage.
 *
 * The Buffer borrows `storage` for its whole lifetime — the application owns it
 * (main.c holds the Pod's single long-lived array) and sizes it from the
 * project's retention parameters, so the ring itself needs no compile-time size
 * and no opinion on how far back a Pod keeps Samples. Capacity must be > 0 and
 * `storage` must hold at least that many Samples.
 */
void buffer_init(struct buffer *buf, struct sample *storage, size_t capacity);

/*
 * How many Samples this Buffer can hold — the capacity it was initialised with.
 * Exposed so a caller can size (or check) its snapshot output against the ring
 * it is actually reading, rather than against whatever constant it was built
 * with; see the precondition on buffer_snapshot() below.
 */
size_t buffer_capacity(const struct buffer *buf);

/* Append a Sample, overwriting the oldest one when the ring is full. */
void buffer_put(struct buffer *buf, const struct sample *s);

/*
 * Snapshot the Buffer: fill out[0..out_cap) with *every* stored Sample,
 * oldest-first, aged against latch_uptime, and return how many were written.
 *
 * Each Sample's age is latch_uptime − capture_uptime, the one mechanical
 * transform the Buffer performs — nothing here is dropped or filtered. Ages
 * therefore decrease strictly along the output as long as capture times
 * increase, which is what lets a caller treat any already-seen leading run as a
 * prefix.
 *
 * Precondition: out_cap >= the Buffer's capacity, so the whole ring fits. A
 * smaller out_cap silently stops at the oldest out_cap Samples and drops the
 * newest — never what a caller wants, hence the precondition rather than a
 * documented truncation mode.
 */
size_t buffer_snapshot(const struct buffer *buf, uint32_t latch_uptime,
		       struct aged_sample *out, size_t out_cap);

#endif /* KUUKI_BUFFER_H */
