/*
 * The Sample tick loop: drive the SCD40 and feed the Buffer.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * This is the on-device half of sampling (ticket 05): I²C, the sensor
 * subsystem, and timing live here, so — unlike measurement_to_sample() and the
 * Buffer — it is verified on hardware, not under host ztests. It wakes at the
 * SCD40's Measurement cadence (~30 s), reads the latest Measurement, and
 * publishes it as the Live reading (ticket 06) so a connecting client sees "right
 * now" immediately; every Sample interval it also promotes that Measurement to a
 * Sample with its capture uptime and stores it in the Buffer.
 * Vocabulary (Sample tick, Measurement, Sample, Buffer, Live reading) follows
 * CONTEXT.md.
 */

#ifndef KUUKI_SAMPLER_H
#define KUUKI_SAMPLER_H

struct buffer;
struct k_mutex;

/*
 * Start the Sample tick loop against buf. Spawns a dedicated thread that runs
 * for the lifetime of the Pod; buf must outlive it (it is the application's
 * single long-lived Buffer). buf_lock serialises Buffer access against the
 * concurrent Sync reader (ticket 07): the sampler holds it around each
 * buffer_put() so a Sync never observes a half-written ring. Returns 0 once the
 * thread is started, or a negative errno if the SCD40 is not ready.
 */
int sampler_start(struct buffer *buf, struct k_mutex *buf_lock);

#endif /* KUUKI_SAMPLER_H */
