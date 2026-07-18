/*
 * Promote an SCD40 Measurement to a stored Sample — the pure, hardware-free
 * scaling seam.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * The SCD40 driver reports each channel as a struct sensor_value (val1 = whole
 * units, val2 = millionths). The Buffer stores each Sample in compact integer
 * units matching the Sync wire contract (docs/wire-contract.md): CO₂ in ppm,
 * temperature in centi-°C (signed), humidity in centi-%RH. This module is the
 * one place that conversion happens, kept free of I²C and the sensor subsystem
 * so it is exercised by host ztests (see tests/measurement/). Vocabulary
 * (Measurement, Sample) follows CONTEXT.md.
 */

#ifndef KUUKI_MEASUREMENT_H
#define KUUKI_MEASUREMENT_H

#include <stdint.h>

#include "buffer.h"

/* Forward declaration: only the two int32 fields of struct sensor_value are
 * used, so callers need not pull in the whole sensor subsystem here. */
struct sensor_value;

/*
 * Build one Sample from an SCD40 Measurement captured at capture_uptime
 * (monotonic uptime, seconds). Each channel is scaled to the Buffer's integer
 * units and saturated to its field width, so an out-of-range Measurement stores
 * a clamped Sample rather than a wrapped-around bogus value:
 *   co2      → ppm         (uint16, saturating)
 *   temp     → centi-°C    (int16, saturating; e.g. 21.43 °C → 2143)
 *   humidity → centi-%RH   (uint16, saturating)
 */
struct sample measurement_to_sample(uint32_t capture_uptime,
				    const struct sensor_value *co2,
				    const struct sensor_value *temp,
				    const struct sensor_value *humidity);

#endif /* KUUKI_MEASUREMENT_H */
