/*
 * In-RAM ring Buffer — implementation.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * See buffer.h for the contract. Kept free of BLE/I²C so the whole module runs
 * under host ztests — including free of Zephyr and <stdatomic.h>: the two places
 * that need ordering use the compiler's __atomic builtins directly rather than
 * changing the write head's declared type, so both host suites keep compiling
 * this file straight into their binaries.
 */

#include "buffer.h"

void buffer_init(struct buffer *buf, struct sample *storage, size_t capacity)
{
	buf->samples = storage;
	buf->capacity = capacity;
	buf->written = 0;
}

void buffer_put(struct buffer *buf, const struct sample *s)
{
	buf->samples[buf->written % buf->capacity] = *s;

	/* Publish the slot with a release store: it pairs with the acquire load
	 * in buffer_iter_init(), and it is what stops the compiler sinking the
	 * write above past this increment, where a concurrent reader could see
	 * the count without the Sample (ADR-0005). Only this producer writes the
	 * head, so reading it plainly above is safe.
	 *
	 * The head only ever climbs: once it has come round onto the oldest
	 * Sample, the next put() overwrites it — the ring keeps the most
	 * recent `capacity`. */
	__atomic_store_n(&buf->written, buf->written + 1, __ATOMIC_RELEASE);
}

void buffer_iter_init(struct buffer_iter *it, const struct buffer *buf)
{
	/* The one atomic operation of the whole walk. Acquiring here is what
	 * makes every Sample below the frozen head fully visible. */
	uint32_t end = __atomic_load_n(&buf->written, __ATOMIC_ACQUIRE);

	/* Both positions derive from that one count, so they cannot disagree:
	 * the ring holds every write until it fills and its usable depth after,
	 * and the oldest live Sample sits that many writes behind the frozen
	 * head. Usable depth stops BUFFER_RUNWAY slots short of the head so the
	 * producer cannot reach the reader's slot before the walk ends. */
	size_t usable = buf->capacity - BUFFER_RUNWAY;
	size_t live = end < usable ? end : usable;

	it->buf = buf;
	it->next = end - (uint32_t)live;
	it->end = end;
}

bool buffer_iter_next(struct buffer_iter *it, struct sample *out)
{
	if (it->next == it->end) {
		return false;
	}

	*out = it->buf->samples[it->next % it->buf->capacity];
	it->next++;
	return true;
}
