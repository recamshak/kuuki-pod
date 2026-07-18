/*
 * In-RAM ring Buffer + collect() Sync query — implementation.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * See buffer.h for the contract. Kept free of BLE/I²C so the whole module runs
 * under host ztests.
 */

#include <stdbool.h>

#include "buffer.h"

void buffer_init(struct buffer *buf)
{
	buf->next = 0;
	buf->count = 0;
}

void buffer_put(struct buffer *buf, const struct sample *s)
{
	buf->samples[buf->next] = *s;
	buf->next = (buf->next + 1) % BUFFER_CAPACITY;

	if (buf->count < BUFFER_CAPACITY) {
		buf->count++;
	}
	/* Once full, `next` has advanced onto the oldest Sample, so the next
	 * put() overwrites it — the ring keeps the most recent BUFFER_CAPACITY. */
}

/* Snap an Age to its Sample-interval slot index (nearest quarter-hour). */
static uint32_t age_to_slot(uint32_t age)
{
	return (age + SAMPLE_INTERVAL_SEC / 2) / SAMPLE_INTERVAL_SEC;
}

size_t buffer_collect(const struct buffer *buf, uint32_t latch_uptime,
		      uint32_t high_water_age, struct sync_record *out,
		      size_t out_cap)
{
	bool everything = (high_water_age == MARK_SENTINEL);
	uint32_t hw_slot = everything ? 0 : age_to_slot(high_water_age);

	/* The oldest stored Sample sits `count` slots behind `next`. */
	size_t oldest = (buf->next + BUFFER_CAPACITY - buf->count) % BUFFER_CAPACITY;
	size_t n = 0;

	for (size_t i = 0; i < buf->count && n < out_cap; i++) {
		const struct sample *s =
			&buf->samples[(oldest + i) % BUFFER_CAPACITY];
		uint32_t age = latch_uptime - s->capture_uptime;

		/* Trim Samples the client already has: same slot as the mark, or
		 * older (larger Age ⇒ larger slot). Only strictly-newer slots pass. */
		if (!everything && age_to_slot(age) >= hw_slot) {
			continue;
		}

		out[n].age = age;
		out[n].co2 = s->co2;
		out[n].temp = s->temp;
		out[n].humidity = s->humidity;
		n++;
	}

	return n;
}
