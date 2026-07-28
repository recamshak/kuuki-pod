/*
 * In-RAM ring Buffer — implementation.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * See buffer.h for the contract. Kept free of BLE/I²C so the whole module runs
 * under host ztests.
 */

#include "buffer.h"

void buffer_init(struct buffer *buf, struct sample *storage, size_t capacity)
{
	buf->samples = storage;
	buf->capacity = capacity;
	buf->next = 0;
	buf->count = 0;
}

size_t buffer_capacity(const struct buffer *buf)
{
	return buf->capacity;
}

void buffer_put(struct buffer *buf, const struct sample *s)
{
	buf->samples[buf->next] = *s;
	buf->next = (buf->next + 1) % buf->capacity;

	if (buf->count < buf->capacity) {
		buf->count++;
	}
	/* Once full, `next` has advanced onto the oldest Sample, so the next
	 * put() overwrites it — the ring keeps the most recent `capacity`. */
}

size_t buffer_snapshot(const struct buffer *buf, uint32_t latch_uptime,
		       struct aged_sample *out, size_t out_cap)
{
	/* The oldest stored Sample sits `count` slots behind `next`. */
	size_t oldest = (buf->next + buf->capacity - buf->count) % buf->capacity;
	size_t n = buf->count < out_cap ? buf->count : out_cap;

	for (size_t i = 0; i < n; i++) {
		const struct sample *s =
			&buf->samples[(oldest + i) % buf->capacity];

		out[i].age = latch_uptime - s->capture_uptime;
		out[i].co2 = s->co2;
		out[i].temp = s->temp;
		out[i].humidity = s->humidity;
	}

	return n;
}
