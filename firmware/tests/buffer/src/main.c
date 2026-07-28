/*
 * Host ztests for the in-RAM ring Buffer (ticket 04). Every test asserts
 * external behaviour — inputs to snapshot records — never the ring's internal
 * index arithmetic, so it survives a reimplementation of the internals. What a
 * given client still needs out of that snapshot is Sync's business; those cases
 * live in tests/sync/ (ticket 14a).
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <string.h>

#include <zephyr/ztest.h>

#include "buffer.h"

/* The Buffer and the snapshot output are ~28 KB each — keep them off the
 * test stack. */
static struct buffer buf;
static struct aged_sample out[BUFFER_CAPACITY];

static void reset(void *fixture)
{
	ARG_UNUSED(fixture);
	buffer_init(&buf);
	memset(out, 0, sizeof(out));
}

ZTEST_SUITE(buffer, NULL, NULL, reset, NULL, NULL);

/* Append one Sample tagged so a record can be traced back to its insertion. */
static void put(uint32_t capture_uptime, uint16_t tag)
{
	struct sample s = {
		.capture_uptime = capture_uptime,
		.co2 = tag,
		.temp = 2143,   /* 21.43 °C — a plausible constant */
		.humidity = 4750, /* 47.50 %RH */
	};
	buffer_put(&buf, &s);
}

/* Capacity is derived from the interval and spans ~30 days, not a magic count. */
ZTEST(buffer, test_capacity_derived_from_interval)
{
	zassert_equal(SAMPLE_INTERVAL_SEC, 900,
		      "v1 Sample tick is 15 minutes");
	zassert_equal(BUFFER_CAPACITY, 2880,
		      "30 days / 15 min = 2880 Samples");
	zassert_equal((size_t)BUFFER_CAPACITY * SAMPLE_INTERVAL_SEC,
		      BUFFER_RETENTION_SEC, "capacity must span the retention window");
}

/* Overflow overwrites the oldest: Samples beyond capacity fall off the old end. */
ZTEST(buffer, test_overflow_overwrites_oldest)
{
	const uint32_t overflow = 5;
	const uint32_t total = BUFFER_CAPACITY + overflow;

	for (uint32_t i = 0; i < total; i++) {
		put((i + 1) * SAMPLE_INTERVAL_SEC, (uint16_t)i);
	}

	uint32_t latch = (total + 1) * SAMPLE_INTERVAL_SEC;
	size_t n = buffer_snapshot(&buf, latch, out, BUFFER_CAPACITY);

	zassert_equal(n, BUFFER_CAPACITY, "ring holds exactly capacity Samples");
	/* The first `overflow` insertions were overwritten; the oldest survivor
	 * is insertion index `overflow`, the newest is `total - 1`. */
	zassert_equal(out[0].co2, overflow, "oldest survivor is insertion #overflow");
	zassert_equal(out[n - 1].co2, (uint16_t)(total - 1), "newest is the last put");
}

/* Records come out oldest-first: ascending capture time, descending Age. */
ZTEST(buffer, test_records_ordered_oldest_first)
{
	const uint32_t latch = 1000000;
	const int count = 10;

	/* Insert oldest-first with strictly increasing capture time. */
	for (int i = 0; i < count; i++) {
		put(latch - (uint32_t)(count - i) * SAMPLE_INTERVAL_SEC, (uint16_t)i);
	}

	size_t n = buffer_snapshot(&buf, latch, out, BUFFER_CAPACITY);
	zassert_equal(n, (size_t)count, "the snapshot returns every stored Sample");

	for (size_t i = 1; i < n; i++) {
		zassert_true(out[i].age < out[i - 1].age,
			     "Age strictly decreases oldest-first");
		zassert_true(out[i].co2 > out[i - 1].co2,
			     "insertion order is preserved oldest-first");
	}
}

/* An empty Buffer snapshots to nothing. */
ZTEST(buffer, test_empty_buffer_snapshots_nothing)
{
	zassert_equal(buffer_snapshot(&buf, 1000000, out, BUFFER_CAPACITY), 0,
		      "a fresh Buffer holds no Samples");
}

/* Age = latch_uptime − capture_uptime, exact even when a tick slips. */
ZTEST(buffer, test_age_exact_with_slipped_tick)
{
	const uint32_t latch = 500000;

	/* Irregular gaps: the middle interval is 1100 s, not 900 — a slipped
	 * tick. Ages must still be the exact subtraction. */
	put(latch - 2900, 1);
	put(latch - 2000, 2);
	put(latch - 900, 3);

	size_t n = buffer_snapshot(&buf, latch, out, BUFFER_CAPACITY);
	zassert_equal(n, 3, "all three Samples");
	zassert_equal(out[0].age, 2900, "oldest Age exact");
	zassert_equal(out[1].age, 2000, "slipped-tick Age exact");
	zassert_equal(out[2].age, 900, "newest Age exact");
}
