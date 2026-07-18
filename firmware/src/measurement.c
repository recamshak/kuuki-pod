/*
 * Measurement → Sample scaling — implementation.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * See measurement.h for the contract. Kept free of I²C and the sensor
 * subsystem (only the two int32 fields of struct sensor_value are read) so the
 * whole module runs under host ztests.
 */

#include <zephyr/drivers/sensor.h>

#include "measurement.h"

/* Saturating narrow of a scaled value into each Sample field's width, so an
 * out-of-range Measurement clamps rather than wrapping into a bogus reading. */
static uint16_t saturate_u16(int32_t v)
{
	if (v < 0) {
		return 0;
	}
	if (v > UINT16_MAX) {
		return UINT16_MAX;
	}
	return (uint16_t)v;
}

static int16_t saturate_i16(int32_t v)
{
	if (v < INT16_MIN) {
		return INT16_MIN;
	}
	if (v > INT16_MAX) {
		return INT16_MAX;
	}
	return (int16_t)v;
}

/* Scale a sensor_value (val1 whole units, val2 millionths) to hundredths.
 * Truncates toward zero; for a negative reading the driver makes both parts
 * negative, so the sign is preserved. */
static int32_t to_centi(const struct sensor_value *v)
{
	return v->val1 * 100 + v->val2 / 10000;
}

struct sample measurement_to_sample(uint32_t capture_uptime,
				    const struct sensor_value *co2,
				    const struct sensor_value *temp,
				    const struct sensor_value *humidity)
{
	return (struct sample){
		.capture_uptime = capture_uptime,
		.co2 = saturate_u16(co2->val1),
		.temp = saturate_i16(to_centi(temp)),
		.humidity = saturate_u16(to_centi(humidity)),
	};
}
