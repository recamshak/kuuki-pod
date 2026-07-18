/*
 * Host ztests for live_encode() — the Live reading characteristic's byte
 * packing (ticket 06). Asserts the external contract (a Sample's Measurement
 * fields to the 6 little-endian wire bytes) only; it never touches BLE, so it
 * runs on the host under native_sim like the buffer and measurement suites.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/ztest.h>

#include "live.h"

ZTEST_SUITE(live, NULL, NULL, NULL, NULL, NULL);

/* A plausible room reading, tagged so each field is distinguishable on the wire. */
static struct sample reading(uint16_t co2, int16_t temp, uint16_t humidity)
{
	return (struct sample){
		.capture_uptime = 123456, /* must not leak into the Live reading */
		.co2 = co2,
		.temp = temp,
		.humidity = humidity,
	};
}

/* The payload is exactly co2 + temp + humidity wide — no Age, no padding. */
ZTEST(live, test_payload_is_six_bytes)
{
	zassert_equal(LIVE_READING_SIZE, 6, "Live reading is 6 packed bytes");
}

/* Each field lands little-endian at its offset: co2@0, temp@2, humidity@4. */
ZTEST(live, test_fields_pack_little_endian)
{
	struct sample s = reading(812, 2143, 4750); /* 0x032C, 0x085F, 0x128E */
	uint8_t out[LIVE_READING_SIZE];

	live_encode(&s, out);

	zassert_equal(out[0], 0x2C, "co2 low byte");
	zassert_equal(out[1], 0x03, "co2 high byte");
	zassert_equal(out[2], 0x5F, "temp low byte");
	zassert_equal(out[3], 0x08, "temp high byte");
	zassert_equal(out[4], 0x8E, "humidity low byte");
	zassert_equal(out[5], 0x12, "humidity high byte");
}

/* Temperature is signed: a sub-zero reading packs as two's-complement LE. */
ZTEST(live, test_negative_temperature_is_twos_complement)
{
	struct sample s = reading(600, -325, 4000); /* -325 = 0xFEBB */
	uint8_t out[LIVE_READING_SIZE];

	live_encode(&s, out);

	zassert_equal(out[2], 0xBB, "temp low byte (two's complement)");
	zassert_equal(out[3], 0xFE, "temp high byte (two's complement)");
}

/* capture_uptime is not "now" — it must never appear in the Live reading. */
ZTEST(live, test_capture_uptime_is_not_encoded)
{
	struct sample s = reading(0, 0, 0);
	uint8_t out[LIVE_READING_SIZE];

	live_encode(&s, out);

	for (size_t i = 0; i < LIVE_READING_SIZE; i++) {
		zassert_equal(out[i], 0x00,
			      "an all-zero Measurement encodes to all-zero bytes");
	}
}
