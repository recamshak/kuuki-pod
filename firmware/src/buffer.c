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
	buf->written = 0;
}

size_t buffer_capacity(const struct buffer *buf)
{
	return buf->capacity;
}

void buffer_put(struct buffer *buf, const struct sample *s)
{
	buf->samples[buf->written % buf->capacity] = *s;
	buf->written++;
	/* The head only ever climbs: once it has come round onto the oldest
	 * Sample, the next put() overwrites it — the ring keeps the most
	 * recent `capacity`. */
}

size_t buffer_snapshot(const struct buffer *buf, uint32_t latch_uptime,
		       struct aged_sample *out, size_t out_cap)
{
	/* Both positions derive from the one count, so they cannot disagree:
	 * the ring holds every write until it fills and `capacity` after, and
	 * the oldest Sample it holds sits that many writes behind the head. */
	size_t stored = buf->written < buf->capacity ? buf->written
						     : buf->capacity;
	size_t oldest = (buf->written - stored) % buf->capacity;
	size_t n = stored < out_cap ? stored : out_cap;

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
