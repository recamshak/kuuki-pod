/*
 * The Sample tick loop: drive the SCD40 and feed the Buffer.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * This is the on-device half of sampling (ticket 05): I²C, the sensor
 * subsystem, and timing live here, so — unlike measurement_to_sample() and the
 * Buffer — it is verified on hardware, not under host ztests. It reads the
 * SCD40's latest Measurement at each Sample tick, promotes it to one Sample
 * with its capture uptime, and stores it in the Buffer, sleeping between ticks.
 * Vocabulary (Sample tick, Measurement, Sample, Buffer) follows CONTEXT.md.
 */

#ifndef KUUKI_SAMPLER_H
#define KUUKI_SAMPLER_H

struct buffer;

/*
 * Start the Sample tick loop against buf. Spawns a dedicated thread that runs
 * for the lifetime of the Pod; buf must outlive it (it is the application's
 * single long-lived Buffer). Returns 0 once the thread is started, or a
 * negative errno if the SCD40 is not ready.
 */
int sampler_start(struct buffer *buf);

#endif /* KUUKI_SAMPLER_H */
