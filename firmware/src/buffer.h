/*
 * In-RAM ring Buffer of Samples + the pure collect() Sync query.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * This is a correctness-critical, hardware-free module: no BLE, no I²C. The
 * Buffer holds the most recent ~30 days of Samples (overwriting the oldest on
 * overflow) and collect() answers a Sync entirely as a function of its inputs,
 * so the whole module is exercised by host ztests (see tests/buffer/). Field
 * widths mirror the Sync wire contract (docs/wire-contract.md); vocabulary
 * (Sample, Sync, Age, High-water mark, Latched read instant) follows
 * CONTEXT.md.
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
 * High-water mark sentinel: "I have nothing for this Pod — send everything."
 * Matches MARK_SENTINEL in the wire contract. A real Age is far below this
 * (~30-day Buffer ⇒ max Age ≈ 2.6 M s), so it never collides with a real mark.
 */
#define MARK_SENTINEL UINT32_MAX

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
 * One Sync data record: what collect() emits per Sample. Carries Age rather
 * than capture time (Age = latch_uptime − capture_uptime); its fields mirror
 * the 10-byte wire record so ticket 07 serialises this struct directly.
 */
struct sync_record {
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
 * Answer a Sync: fill out[0..out_cap) with records for the stored Samples,
 * oldest-first, and return how many were written.
 *
 * Each record's age is latch_uptime − capture_uptime. Only Samples strictly
 * newer than the Sample-interval slot matched by high_water_age are emitted;
 * high_water_age == MARK_SENTINEL emits every stored Sample. The slot match
 * (nearest quarter-hour) makes trimming tolerant of a mark that doesn't land
 * exactly on a Pod Sample's Age.
 *
 * out must have room for out_cap records; at most BUFFER_CAPACITY are ever
 * produced.
 */
size_t buffer_collect(const struct buffer *buf, uint32_t latch_uptime,
		      uint32_t high_water_age, struct sync_record *out,
		      size_t out_cap);

#endif /* KUUKI_BUFFER_H */
