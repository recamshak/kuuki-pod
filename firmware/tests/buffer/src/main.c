/*
 * Host ztests for the in-RAM ring Buffer (ticket 04). Every test asserts
 * external behaviour — inputs to snapshot records — never the ring's internal
 * index arithmetic, so it survives a reimplementation of the internals. What a
 * given client still needs out of that snapshot is Sync's business; those cases
 * live in tests/sync/ (ticket 14a). The ring is exercised with explicit storage
 * and capacity: the Pod's Retention target and Sample tick are project
 * parameters, asserted in tests/config/ (ticket 14b).
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <string.h>

#include <zephyr/ztest.h>

#include "buffer.h"

/* A ring small enough to fill and overflow readably. The Buffer's behaviour is
 * a function of its capacity, not of the Pod's configured one. */
#define TEST_CAPACITY 8

/* A plausible spacing between the Samples these tests put; the Buffer never
 * reasons about it, it only subtracts capture times from the latch instant. */
#define TEST_SPACING_SEC 900

static struct buffer buf;
static struct sample storage[TEST_CAPACITY];
static struct aged_sample out[TEST_CAPACITY];

static void reset(void *fixture)
{
	ARG_UNUSED(fixture);
	buffer_init(&buf, storage, TEST_CAPACITY);
	memset(storage, 0, sizeof(storage));
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

/* Overflow overwrites the oldest: Samples beyond capacity fall off the old end. */
ZTEST(buffer, test_overflow_overwrites_oldest)
{
	const uint32_t overflow = 5;
	const uint32_t total = TEST_CAPACITY + overflow;

	for (uint32_t i = 0; i < total; i++) {
		put((i + 1) * TEST_SPACING_SEC, (uint16_t)i);
	}

	uint32_t latch = (total + 1) * TEST_SPACING_SEC;
	size_t n = buffer_snapshot(&buf, latch, out, TEST_CAPACITY);

	zassert_equal(n, TEST_CAPACITY, "ring holds exactly capacity Samples");
	/* The first `overflow` insertions were overwritten; the oldest survivor
	 * is insertion index `overflow`, the newest is `total - 1`. */
	zassert_equal(out[0].co2, overflow, "oldest survivor is insertion #overflow");
	zassert_equal(out[n - 1].co2, (uint16_t)(total - 1), "newest is the last put");
}

/* Capacity is whatever the caller injected — a second ring over its own storage
 * keeps its own, unrelated number of Samples. */
ZTEST(buffer, test_capacity_is_the_injected_one)
{
	struct sample small_storage[3];
	struct aged_sample small_out[3];
	struct buffer small;

	buffer_init(&small, small_storage, ARRAY_SIZE(small_storage));

	zassert_equal(buffer_capacity(&small), 3, "the ring reports what it was given");
	zassert_equal(buffer_capacity(&buf), TEST_CAPACITY, "and so does the other one");

	for (uint32_t i = 0; i < 10; i++) {
		struct sample s = {
			.capture_uptime = (i + 1) * TEST_SPACING_SEC,
			.co2 = (uint16_t)i,
		};
		buffer_put(&small, &s);
	}

	uint32_t latch = 11 * TEST_SPACING_SEC;
	size_t n = buffer_snapshot(&small, latch, small_out,
				   ARRAY_SIZE(small_out));

	zassert_equal(n, 3, "the 3-slot ring holds 3 Samples, not the other's 8");
	zassert_equal(small_out[0].co2, 7, "oldest survivor of ten puts");
	zassert_equal(small_out[2].co2, 9, "newest is the last put");
}

/* Records come out oldest-first: ascending capture time, descending Age. */
ZTEST(buffer, test_records_ordered_oldest_first)
{
	const uint32_t latch = 1000000;
	const int count = 5;

	/* Insert oldest-first with strictly increasing capture time. */
	for (int i = 0; i < count; i++) {
		put(latch - (uint32_t)(count - i) * TEST_SPACING_SEC, (uint16_t)i);
	}

	size_t n = buffer_snapshot(&buf, latch, out, TEST_CAPACITY);
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
	zassert_equal(buffer_snapshot(&buf, 1000000, out, TEST_CAPACITY), 0,
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

	size_t n = buffer_snapshot(&buf, latch, out, TEST_CAPACITY);
	zassert_equal(n, 3, "all three Samples");
	zassert_equal(out[0].age, 2900, "oldest Age exact");
	zassert_equal(out[1].age, 2000, "slipped-tick Age exact");
	zassert_equal(out[2].age, 900, "newest Age exact");
}
