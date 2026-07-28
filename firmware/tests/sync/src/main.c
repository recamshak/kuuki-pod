/*
 * Host ztests for the Sync seam: sync_collect()'s High-water-mark trim
 * (ticket 14a), sync_encode_record()'s 10-byte little-endian record packing and
 * sync_records_per_notification()'s MTU math (ticket 07). All are pure
 * functions of their inputs — no BLE — so they run on the host under native_sim
 * like the buffer, measurement, and live suites. Asserts the external wire
 * contract only (docs/wire-contract.md), never any internal representation.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <string.h>

#include <zephyr/ztest.h>

#include "buffer.h"
#include "sync.h"

/* The Buffer and a whole sync_collect() output are ~28 KB each — keep them off the
 * test stack. */
static struct buffer buf;
static struct aged_sample out[BUFFER_CAPACITY];

static void reset(void *fixture)
{
	ARG_UNUSED(fixture);
	buffer_init(&buf);
	memset(out, 0, sizeof(out));
}

ZTEST_SUITE(sync, NULL, NULL, reset, NULL, NULL);

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

/* Collect with the v1 Sample interval, over the whole Buffer. */
static size_t collect(uint32_t latch, uint32_t mark)
{
	return sync_collect(&buf, latch, mark, SAMPLE_INTERVAL_SEC, out,
			    BUFFER_CAPACITY);
}

/* The sentinel mark means "I have nothing" — every stored Sample is sent. */
ZTEST(sync, test_sentinel_collects_everything)
{
	const uint32_t latch = 1000000;
	const int count = 7;

	for (int i = 0; i < count; i++) {
		put(latch - (uint32_t)(count - i) * SAMPLE_INTERVAL_SEC, (uint16_t)i);
	}

	size_t n = collect(latch, MARK_SENTINEL);

	zassert_equal(n, (size_t)count, "sentinel emits every stored Sample");
	zassert_equal(out[0].co2, 0, "oldest-first survives the trim");
	zassert_equal(out[n - 1].co2, (uint16_t)(count - 1), "newest last");
}

/* High-water trimming returns exactly the Samples newer than the matched slot. */
ZTEST(sync, test_high_water_trims_to_matched_slot)
{
	const uint32_t latch = 1000000;

	/* k = 1..10: Sample k has Age k*interval (slot k), tagged co2 = k. */
	for (int k = 10; k >= 1; k--) {
		put(latch - (uint32_t)k * SAMPLE_INTERVAL_SEC, (uint16_t)k);
	}

	/* Client's newest known Sample is slot 3 (Age 2700). Expect slots 1,2. */
	size_t n = collect(latch, 3 * SAMPLE_INTERVAL_SEC);

	zassert_equal(n, 2, "only Samples strictly newer than slot 3");
	zassert_equal(out[0].age, 2 * SAMPLE_INTERVAL_SEC, "oldest-first: slot 2");
	zassert_equal(out[0].co2, 2, "slot 2 identity");
	zassert_equal(out[1].age, 1 * SAMPLE_INTERVAL_SEC, "then slot 1");
	zassert_equal(out[1].co2, 1, "slot 1 identity");
}

/* The half-interval guard band absorbs sub-interval skew in the client's mark:
 * a mark measured on the client's clock still snaps to the Sample it holds. */
ZTEST(sync, test_skewed_mark_snaps_to_the_same_slot)
{
	const uint32_t latch = 1000000;

	for (int k = 10; k >= 1; k--) {
		put(latch - (uint32_t)k * SAMPLE_INTERVAL_SEC, (uint16_t)k);
	}

	/* Marks either side of slot 3's exact Age must all match slot 3 —
	 * including both ends of the half-interval band, which is inclusive at
	 * the top (+half) and exclusive at the bottom (−half). */
	const int32_t skews[] = {
		-50,
		+50,
		-(SAMPLE_INTERVAL_SEC / 2 - 1),
		+(SAMPLE_INTERVAL_SEC / 2),
	};

	for (size_t i = 0; i < ARRAY_SIZE(skews); i++) {
		size_t n = collect(latch, (uint32_t)(3 * SAMPLE_INTERVAL_SEC + skews[i]));

		zassert_equal(n, 2, "a skewed mark matches the nearest slot");
		zassert_equal(out[0].co2, 2, "slot 2 is the oldest unseen Sample");
	}
}

/* A mark older than every stored Sample (but below the sentinel) sends them
 * all, with no bogus Ages. */
ZTEST(sync, test_mark_older_than_every_sample_collects_all)
{
	const uint32_t latch = 1000000;
	const int count = 4;

	for (int i = 0; i < count; i++) {
		put(latch - (uint32_t)(count - i) * SAMPLE_INTERVAL_SEC, (uint16_t)i);
	}

	/* Larger than any real Age here but well below the sentinel: the client's
	 * newest known Sample predates our whole Buffer. */
	size_t n = collect(latch, 10000000);

	zassert_equal(n, (size_t)count, "a mark past every Sample returns them all");

	for (size_t i = 0; i < n; i++) {
		zassert_true(out[i].age <= latch,
			     "Age never underflows into a bogus huge value");
	}
}

/* An empty Buffer collects nothing, sentinel or not. */
ZTEST(sync, test_empty_buffer_collects_nothing)
{
	zassert_equal(collect(1000000, MARK_SENTINEL), 0, "nothing to send");
	zassert_equal(collect(1000000, 3 * SAMPLE_INTERVAL_SEC), 0, "still nothing");
}

/* A tagged record so each field is distinguishable on the wire. */
static struct aged_sample record(uint32_t age, uint16_t co2, int16_t temp,
				 uint16_t humidity)
{
	return (struct aged_sample){
		.age = age,
		.co2 = co2,
		.temp = temp,
		.humidity = humidity,
	};
}

/* The record is exactly age + co2 + temp + humidity wide — no padding. */
ZTEST(sync, test_record_is_ten_bytes)
{
	zassert_equal(RECORD_SIZE, 10, "Sync record is 10 packed bytes");
}

/* Each field lands little-endian at its offset: age@0, co2@4, temp@6, humid@8. */
ZTEST(sync, test_fields_pack_little_endian)
{
	/* age 0x0A0B0C0D, co2 0x032C, temp 0x085F, humidity 0x128E. */
	struct aged_sample r = record(0x0A0B0C0D, 812, 2143, 4750);
	uint8_t out[RECORD_SIZE];

	sync_encode_record(&r, out);

	zassert_equal(out[0], 0x0D, "age byte 0");
	zassert_equal(out[1], 0x0C, "age byte 1");
	zassert_equal(out[2], 0x0B, "age byte 2");
	zassert_equal(out[3], 0x0A, "age byte 3");
	zassert_equal(out[4], 0x2C, "co2 low byte");
	zassert_equal(out[5], 0x03, "co2 high byte");
	zassert_equal(out[6], 0x5F, "temp low byte");
	zassert_equal(out[7], 0x08, "temp high byte");
	zassert_equal(out[8], 0x8E, "humidity low byte");
	zassert_equal(out[9], 0x12, "humidity high byte");
}

/* Temperature is signed: a sub-zero reading packs as two's-complement LE. */
ZTEST(sync, test_negative_temperature_is_twos_complement)
{
	struct aged_sample r = record(900, 600, -325, 4000); /* -325 = 0xFEBB */
	uint8_t out[RECORD_SIZE];

	sync_encode_record(&r, out);

	zassert_equal(out[6], 0xBB, "temp low byte (two's complement)");
	zassert_equal(out[7], 0xFE, "temp high byte (two's complement)");
}

/* A near-max Age (a ~30-day-old Sample) fills all four age bytes, LE. */
ZTEST(sync, test_large_age_fills_all_four_bytes)
{
	struct aged_sample r = record(0xFFFFFFFE, 800, 2100, 4500);
	uint8_t out[RECORD_SIZE];

	sync_encode_record(&r, out);

	zassert_equal(out[0], 0xFE, "age byte 0");
	zassert_equal(out[1], 0xFF, "age byte 1");
	zassert_equal(out[2], 0xFF, "age byte 2");
	zassert_equal(out[3], 0xFF, "age byte 3");
}

/* The target negotiated MTU packs 24 records into a 240-byte payload. */
ZTEST(sync, test_records_per_notification_target_mtu)
{
	zassert_equal(sync_records_per_notification(247), 24,
		      "floor((247 - 3) / 10) = 24 records");
}

/* The formula floors: a partial trailing record never counts. */
ZTEST(sync, test_records_per_notification_floors)
{
	zassert_equal(sync_records_per_notification(23), 2,
		      "default MTU: floor((23 - 3) / 10) = 2");
	zassert_equal(sync_records_per_notification(27), 2,
		      "floor((27 - 3) / 10) = 2, the 4 spare bytes are unused");
	zassert_equal(sync_records_per_notification(33), 3,
		      "floor((33 - 3) / 10) = 3, an exact fit");
}

/* An MTU too small to hold even one whole record yields zero. */
ZTEST(sync, test_records_per_notification_below_one_record)
{
	zassert_equal(sync_records_per_notification(12), 0,
		      "12 - 3 = 9 bytes cannot hold a 10-byte record");
	zassert_equal(sync_records_per_notification(13), 1,
		      "13 - 3 = 10 bytes holds exactly one record");
}
