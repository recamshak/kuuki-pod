/*
 * Encode a Measurement into the Live reading characteristic's bytes — the pure,
 * hardware-free seam behind the BLE Live reading (ticket 06).
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Live reading is the Pod's most recent Measurement (CO₂/temp/humidity),
 * exposed as its own BLE characteristic so a client sees "right now" the instant
 * it connects, without touching the Sync stream (CONTEXT.md). Its on-wire bytes
 * are the Sync record's three measurement fields, minus the Age — the "Live
 * reading characteristic" section of docs/wire-contract.md is the single source
 * of truth for their widths and little-endian order. This one place does that
 * packing, kept free of BLE so host ztests exercise it (see tests/live/).
 */

#ifndef KUUKI_LIVE_H
#define KUUKI_LIVE_H

#include <stdint.h>

#include "buffer.h"

/*
 * Live reading payload width, bytes: co2 (uint16) + temp (int16) + humidity
 * (uint16), packed back-to-back, no padding. The Sync record (RECORD_SIZE = 10)
 * minus its 4-byte age.
 */
#define LIVE_READING_SIZE 6

/*
 * Pack a Sample's Measurement fields into the Live reading's 6 bytes,
 * little-endian: co2 at offset 0, temp at 2, humidity at 4. capture_uptime is
 * not part of the Live reading (it carries no Age — it is always "now").
 */
void live_encode(const struct sample *s, uint8_t out[LIVE_READING_SIZE]);

#endif /* KUUKI_LIVE_H */
