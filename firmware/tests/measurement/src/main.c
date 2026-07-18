/*
 * Host ztests for measurement_to_sample() — the SCD40 Measurement → Sample
 * scaling seam (ticket 05). Asserts the external contract (sensor_value inputs
 * to stored-Sample fields) only; it never touches I²C or the sensor subsystem,
 * so it runs on the host under native_sim like the Buffer suite.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/ztest.h>
#include <zephyr/drivers/sensor.h>

#include "measurement.h"

ZTEST_SUITE(measurement, NULL, NULL, NULL, NULL, NULL);

/* A whole-plus-millionths sensor_value, the SCD40 driver's output convention. */
static struct sensor_value sv(int32_t val1, int32_t val2)
{
	return (struct sensor_value){ .val1 = val1, .val2 = val2 };
}

/* The driver reports CO₂ as whole ppm in val1; it lands in the Sample verbatim. */
ZTEST(measurement, test_co2_is_whole_ppm)
{
	struct sensor_value co2 = sv(812, 0);
	struct sensor_value temp = sv(21, 430000);
	struct sensor_value hum = sv(47, 500000);

	struct sample s = measurement_to_sample(1234, &co2, &temp, &hum);

	zassert_equal(s.co2, 812, "CO₂ passes through as whole ppm");
	zassert_equal(s.capture_uptime, 1234, "capture uptime is stored verbatim");
}

/* Temperature scales to centi-°C: val1*100 + val2 rounded down to hundredths. */
ZTEST(measurement, test_temp_scales_to_centi_celsius)
{
	struct sensor_value co2 = sv(800, 0);
	struct sensor_value temp = sv(21, 430000); /* 21.43 °C */
	struct sensor_value hum = sv(50, 0);

	struct sample s = measurement_to_sample(0, &co2, &temp, &hum);

	zassert_equal(s.temp, 2143, "21.43 °C → 2143 centi-°C");
}

/* Humidity scales to centi-%RH the same way. */
ZTEST(measurement, test_humidity_scales_to_centi_percent)
{
	struct sensor_value co2 = sv(800, 0);
	struct sensor_value temp = sv(20, 0);
	struct sensor_value hum = sv(47, 500000); /* 47.50 %RH */

	struct sample s = measurement_to_sample(0, &co2, &temp, &hum);

	zassert_equal(s.humidity, 4750, "47.50 %RH → 4750 centi-%RH");
}

/* A sub-zero temperature keeps its sign (sensor_value makes both parts negative). */
ZTEST(measurement, test_negative_temperature)
{
	struct sensor_value co2 = sv(600, 0);
	struct sensor_value temp = sv(-3, -250000); /* -3.25 °C */
	struct sensor_value hum = sv(40, 0);

	struct sample s = measurement_to_sample(0, &co2, &temp, &hum);

	zassert_equal(s.temp, -325, "-3.25 °C → -325 centi-°C");
}

/* An implausibly high CO₂ saturates at the uint16 field width, never wraps. */
ZTEST(measurement, test_co2_saturates_high)
{
	struct sensor_value co2 = sv(70000, 0); /* beyond uint16 */
	struct sensor_value temp = sv(20, 0);
	struct sensor_value hum = sv(50, 0);

	struct sample s = measurement_to_sample(0, &co2, &temp, &hum);

	zassert_equal(s.co2, UINT16_MAX, "CO₂ clamps to uint16 max, not wraps");
}

/* A negative CO₂ (should never happen, but be defensive) clamps to zero. */
ZTEST(measurement, test_co2_saturates_low)
{
	struct sensor_value co2 = sv(-5, 0);
	struct sensor_value temp = sv(20, 0);
	struct sensor_value hum = sv(50, 0);

	struct sample s = measurement_to_sample(0, &co2, &temp, &hum);

	zassert_equal(s.co2, 0, "negative CO₂ clamps to zero");
}
