/*
 * Host ztests for the in-RAM ring Buffer (tickets 04, 15d). Every test asserts
 * external behaviour — what the iterator yields — never the ring's internal
 * index arithmetic, so it survives a reimplementation of the internals. Age and
 * which of these Samples a given client still needs are Sync's business; those
 * cases live in tests/sync/ (tickets 14a, 15d). The ring is exercised with
 * explicit storage and capacity: the Pod's Retention target and Sample tick are
 * project parameters, asserted in tests/config/ (ticket 14b).
 *
 * The lock-free producer/consumer pairing (ADR-0005) is deliberately *not*
 * stress-tested with threads: under native_sim that would be non-deterministic
 * and would pass whether or not the acquire/release pairing is right. What is
 * testable is behavioural and single-threaded — the batch a reader freezes, and
 * the depth the runway leaves usable — because the producer and the iterator are
 * separate calls this suite can interleave exactly.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <string.h>

#include <zephyr/ztest.h>

#include "buffer.h"

/* A ring small enough to fill and overflow readably, and longer than the runway
 * as the Buffer requires. The Buffer's behaviour is a function of its capacity,
 * not of the Pod's configured one. */
#define TEST_CAPACITY 12

/* What a reader can actually see: the storage less the slots the runway
 * reserves ahead of the write head. Stated as the subtraction the ring is
 * specified by, rather than asked of the ring itself. */
#define TEST_USABLE (TEST_CAPACITY - BUFFER_RUNWAY)

/* A plausible spacing between the Samples these tests put; the Buffer never
 * reasons about it, it only hands the capture times back untouched. */
#define TEST_SPACING_SEC 900

static struct buffer buf;
static struct sample storage[TEST_CAPACITY];
static struct sample out[TEST_CAPACITY];

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
		.temp = 2143,     /* 21.43 °C — a plausible constant */
		.humidity = 4750, /* 47.50 %RH */
	};
	buffer_put(&buf, &s);
}

/* Freeze a walk over `target` and drain it into `dest`, returning how many
 * Samples came out. */
static size_t drain(struct buffer *target, struct sample *dest, size_t cap)
{
	struct buffer_iter it;
	size_t n = 0;

	buffer_iter_init(&it, target);
	while (n < cap && buffer_iter_next(&it, &dest[n])) {
		n++;
	}
	return n;
}

/* Overflow overwrites the oldest, and the runway takes its slots off the top:
 * what comes out is the storage less the runway, ending at the newest put. */
ZTEST(buffer, test_overflow_yields_storage_less_the_runway)
{
	const uint32_t overflow = 5;
	const uint32_t total = TEST_CAPACITY + overflow;

	for (uint32_t i = 0; i < total; i++) {
		put((i + 1) * TEST_SPACING_SEC, (uint16_t)i);
	}

	size_t n = drain(&buf, out, TEST_CAPACITY);

	zassert_equal(n, TEST_USABLE,
		      "an overflowed ring yields its storage less the runway");
	/* Everything but the newest TEST_USABLE insertions is either overwritten
	 * or inside the runway, so the oldest survivor is that far back. */
	zassert_equal(out[0].co2, (uint16_t)(total - TEST_USABLE),
		      "oldest survivor is TEST_USABLE insertions back");
	zassert_equal(out[n - 1].co2, (uint16_t)(total - 1), "newest is the last put");
}

/* Usable depth follows the storage the caller injected — a second ring over its
 * own, differently sized storage keeps its own unrelated number of Samples. */
ZTEST(buffer, test_usable_depth_follows_the_injected_storage)
{
	struct sample small_storage[BUFFER_RUNWAY + 3];
	struct sample small_out[ARRAY_SIZE(small_storage)];
	struct buffer small;

	buffer_init(&small, small_storage, ARRAY_SIZE(small_storage));

	for (uint32_t i = 0; i < 10; i++) {
		struct sample s = {
			.capture_uptime = (i + 1) * TEST_SPACING_SEC,
			.co2 = (uint16_t)i,
		};
		buffer_put(&small, &s);
	}

	size_t n = drain(&small, small_out, ARRAY_SIZE(small_out));

	zassert_equal(n, 3, "the runway+3 ring yields 3 Samples, not the other's 8");
	zassert_equal(small_out[0].co2, 7, "oldest survivor of ten puts");
	zassert_equal(small_out[2].co2, 9, "newest is the last put");
}

/* Samples come out oldest-first, in insertion order with ascending capture
 * time, and each field survives the round trip. */
ZTEST(buffer, test_samples_ordered_oldest_first)
{
	const int count = 5;

	for (int i = 0; i < count; i++) {
		put((uint32_t)(i + 1) * TEST_SPACING_SEC, (uint16_t)i);
	}

	size_t n = drain(&buf, out, TEST_CAPACITY);
	zassert_equal(n, (size_t)count, "a part-filled ring yields every Sample");

	for (size_t i = 0; i < n; i++) {
		zassert_equal(out[i].co2, (uint16_t)i,
			      "insertion order is preserved oldest-first");
		zassert_equal(out[i].capture_uptime, (i + 1) * TEST_SPACING_SEC,
			      "capture time comes back untouched");
		zassert_equal(out[i].temp, 2143, "temp comes back untouched");
		zassert_equal(out[i].humidity, 4750, "humidity comes back untouched");
	}
}

/* An empty Buffer yields nothing. */
ZTEST(buffer, test_empty_buffer_yields_nothing)
{
	zassert_equal(drain(&buf, out, TEST_CAPACITY), 0,
		      "a fresh Buffer holds no Samples");
}

/* The batch is frozen at init: Samples put after the iterator is created are
 * never yielded by it, however many arrive mid-walk. */
ZTEST(buffer, test_frozen_batch_excludes_later_puts)
{
	struct buffer_iter it;
	struct sample s;
	size_t n = 0;

	for (int i = 0; i < 3; i++) {
		put((uint32_t)(i + 1) * TEST_SPACING_SEC, (uint16_t)i);
	}

	buffer_iter_init(&it, &buf);

	/* Interleave the producer with the walk, exactly as a Sample tick
	 * preempting the Sync thread would. */
	while (buffer_iter_next(&it, &s)) {
		zassert_equal(s.co2, (uint16_t)n, "only the pre-freeze Samples");
		put((uint32_t)(10 + n) * TEST_SPACING_SEC, (uint16_t)(100 + n));
		n++;
	}

	zassert_equal(n, 3, "the frozen batch is the three Samples put before it");

	/* The later puts are not lost — they are simply the next Sync's. */
	zassert_equal(drain(&buf, out, TEST_CAPACITY), 6,
		      "a fresh walk sees the Samples the frozen one excluded");
	zassert_equal(out[5].co2, 102, "including the last one put mid-walk");
}
