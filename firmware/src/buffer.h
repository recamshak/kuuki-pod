/*
 * In-RAM ring Buffer of Samples.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * This is a correctness-critical, hardware-free module: no BLE, no I²C. The
 * Buffer holds the most recent Samples (overwriting the oldest on overflow) and
 * hands them back one at a time through an iterator that freezes the ring's end
 * at init, entirely as a function of its inputs, so the whole module is
 * exercised by host ztests (see tests/buffer/). It is a dumb ring: how many
 * Samples that is (a retention decision — see ../Kconfig and app_config.h),
 * which of them a given client still needs, and how they are framed on the wire
 * are all somebody else's business (see sync.h) — including their Age, which is
 * a property of a Sample as seen by one Sync, not of a buffered one. Vocabulary
 * (Sample, Buffer) follows CONTEXT.md.
 *
 * A Sample is published by the producer and read by one concurrent consumer
 * with no lock: the reader freezes the write head with a single acquire load and
 * then walks plain indices behind a reserved runway of slots the producer cannot
 * have reached. See docs/adr/0005-lock-free-buffer-with-runway.md — the runway
 * has no runtime partner to find, and deleting it as unused re-introduces a data
 * race no test will catch.
 */

#ifndef KUUKI_BUFFER_H
#define KUUKI_BUFFER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * Physical slots the ring reserves ahead of the write head: the Samples an
 * iterator considers live stop this many slots short of it, so the producer
 * cannot overwrite a slot the reader has yet to reach. Owned by the Buffer
 * rather than passed in — it is a property of the lock-free mechanism, and no
 * caller has a basis on which to choose it. It buys `runway × Sample interval`
 * of consumer-stall tolerance; ADR-0005 derives the number and app_config.h
 * asserts the Pod's cadence keeps clearing it.
 */
#define BUFFER_RUNWAY 6

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
 * The in-RAM ring Buffer over `capacity` slots of caller-provided storage; once
 * full, buffer_put() overwrites the oldest Sample. Fields are internal — tests
 * must exercise behaviour through the functions below, never this layout.
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
	size_t capacity;        /* slots in `samples`, > BUFFER_RUNWAY */
	uint32_t written;       /* Samples ever written — the write head */
};

/*
 * A frozen walk over the Samples the Buffer held at the moment it was created.
 * Fields are internal; drive it with buffer_iter_next().
 */
struct buffer_iter {
	const struct buffer *buf;
	uint32_t next; /* write-head position of the next Sample to yield */
	uint32_t end;  /* the write head, frozen at init */
};

/*
 * Reset a Buffer to empty over `capacity` Samples of caller-provided storage.
 *
 * The Buffer borrows `storage` for its whole lifetime — the application owns it
 * (main.c holds the Pod's single long-lived array) and sizes it from the
 * project's retention parameters plus BUFFER_RUNWAY, so the ring itself needs no
 * compile-time size and a test can pick its own.
 *
 * Precondition: capacity > BUFFER_RUNWAY. A ring no longer than the runway has
 * no live Samples at all.
 */
void buffer_init(struct buffer *buf, struct sample *storage, size_t capacity);

/* Append a Sample, overwriting the oldest one when the ring is full. */
void buffer_put(struct buffer *buf, const struct sample *s);

/*
 * Freeze the Buffer's end and start walking what it holds, oldest-first.
 *
 * The write head is read once, here; every subsequent step is plain indexing
 * against that fixed bound, so a Sample put after this call is never yielded and
 * the batch cannot grow under the reader mid-walk. That is also what lets a
 * caller read its Latched read instant *after* this call and know no Sample in
 * the walk was captured later (sync.h).
 *
 * The walk covers at most `capacity − BUFFER_RUNWAY` Samples: the runway's slots
 * behind the write head are given up so the producer cannot catch the reader.
 */
void buffer_iter_init(struct buffer_iter *it, const struct buffer *buf);

/*
 * Copy the next Sample into *out and advance, or return false when the frozen
 * walk is exhausted (*out untouched).
 */
bool buffer_iter_next(struct buffer_iter *it, struct sample *out);

#endif /* KUUKI_BUFFER_H */
