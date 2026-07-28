/*
 * In-RAM ring Buffer of Samples.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * This is a correctness-critical, hardware-free module: no BLE, no I²C. The
 * Buffer holds the most recent ~30 days of Samples (overwriting the oldest on
 * overflow) and hands back a snapshot of everything it holds, entirely as a
 * function of its inputs, so the whole module is exercised by host ztests (see
 * tests/buffer/). It is a dumb ring: which of those Samples a given client still
 * needs, and how they are framed on the wire, are Sync's business (see sync.h).
 * Field widths mirror the wire contract (docs/wire-contract.md) so no repacking
 * is needed on the way out; vocabulary (Sample, Age, Latched read instant)
 * follows CONTEXT.md.
 */

#ifndef KUUKI_BUFFER_H
#define KUUKI_BUFFER_H

#include <stddef.h>
#include <stdint.h>

/*
 * Sample tick cadence, seconds. The Pod promotes one Measurement to a Sample
 * every SAMPLE_INTERVAL_SEC. Overridable at build time (e.g. from Kconfig)
 * without touching this header; defaults to the 15-minute v1 cadence.
 */
#ifndef SAMPLE_INTERVAL_SEC
#define SAMPLE_INTERVAL_SEC (15 * 60)
#endif

/* Buffer retention target, seconds: ~30 days. */
#define BUFFER_RETENTION_SEC (30 * 24 * 60 * 60)

/*
 * Ring capacity in Samples, *derived* from the retention target and the
 * configured Sample interval — never a hard-coded Sample count. Changing the
 * interval resizes the ring so it still spans ~30 days.
 */
#define BUFFER_CAPACITY (BUFFER_RETENTION_SEC / SAMPLE_INTERVAL_SEC)

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
 * The in-RAM ring Buffer. Holds up to BUFFER_CAPACITY Samples; once full,
 * buffer_put() overwrites the oldest so it always holds the most recent
 * ~30 days. Fields are internal — tests must exercise behaviour through the
 * functions below, never this layout.
 */
struct buffer {
	struct sample samples[BUFFER_CAPACITY];
	size_t next;  /* index the next Sample will be written to */
	size_t count; /* Samples currently stored, ≤ BUFFER_CAPACITY */
};

/* Reset a Buffer to empty. */
void buffer_init(struct buffer *buf);

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
 * Precondition: out_cap >= BUFFER_CAPACITY, so the whole ring always fits. A
 * smaller out_cap silently stops at the oldest out_cap Samples and drops the
 * newest — never what a caller wants, hence the precondition rather than a
 * documented truncation mode.
 */
size_t buffer_snapshot(const struct buffer *buf, uint32_t latch_uptime,
		       struct aged_sample *out, size_t out_cap);

#endif /* KUUKI_BUFFER_H */
