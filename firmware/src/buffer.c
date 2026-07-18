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

size_t buffer_collect(const struct buffer *buf, uint32_t latch_uptime,
		      uint32_t high_water_age, struct sync_record *out,
		      size_t out_cap)
{
	bool everything = (high_water_age == MARK_SENTINEL);

	/* The oldest stored Sample sits `count` slots behind `next`. */
	size_t oldest = (buf->next + BUFFER_CAPACITY - buf->count) % BUFFER_CAPACITY;
	size_t n = 0;

	for (size_t i = 0; i < buf->count && n < out_cap; i++) {
		const struct sample *s =
			&buf->samples[(oldest + i) % BUFFER_CAPACITY];
		uint32_t age = latch_uptime - s->capture_uptime;

		/* Trim Samples the client already has: emit only those at least
		 * half a Sample interval newer than the mark. The half-interval
		 * guard band excludes the boundary Sample the client already holds
		 * despite sub-interval clock skew in `mark` (it's measured on the
		 * client's clock, not this latch), while every genuinely newer
		 * Sample — a full interval further on — still passes. */
		if (!everything && age + SAMPLE_INTERVAL_SEC / 2 >= high_water_age) {
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
