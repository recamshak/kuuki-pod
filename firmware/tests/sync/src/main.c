/*
 * Host ztests for the Sync data seam (ticket 07): sync_encode_record()'s
 * 10-byte little-endian record packing and sync_records_per_notification()'s
 * MTU math. Both are pure functions of their inputs — no BLE — so they run on
 * the host under native_sim like the buffer, measurement, and live suites.
 * Asserts the external wire contract only (docs/wire-contract.md), never any
 * internal representation.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/ztest.h>

#include "sync.h"

ZTEST_SUITE(sync, NULL, NULL, NULL, NULL, NULL);

/* A tagged record so each field is distinguishable on the wire. */
static struct sync_record record(uint32_t age, uint16_t co2, int16_t temp,
				 uint16_t humidity)
{
	return (struct sync_record){
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
	struct sync_record r = record(0x0A0B0C0D, 812, 2143, 4750);
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
	struct sync_record r = record(900, 600, -325, 4000); /* -325 = 0xFEBB */
	uint8_t out[RECORD_SIZE];

	sync_encode_record(&r, out);

	zassert_equal(out[6], 0xBB, "temp low byte (two's complement)");
	zassert_equal(out[7], 0xFE, "temp high byte (two's complement)");
}

/* A near-max Age (a ~30-day-old Sample) fills all four age bytes, LE. */
ZTEST(sync, test_large_age_fills_all_four_bytes)
{
	struct sync_record r = record(0xFFFFFFFE, 800, 2100, 4500);
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
