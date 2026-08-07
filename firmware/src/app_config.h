/*
 * The Retention target in Samples, derived from the firmware's project parameters.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Sample tick cadence and the Buffer's retention target are product
 * decisions, configured in Kconfig (see ../Kconfig) as
 * CONFIG_KUUKI_SAMPLE_INTERVAL_SEC and CONFIG_KUUKI_RETENTION_SEC. This header
 * is the one place the Retention target is turned into a Sample count, and the
 * application layer is the only layer that reads it: main.c sizes the Buffer's
 * backing array from it (plus the ring's runway), while the modules below it
 * take the interval and the ring's capacity as parameters (CONTEXT.md's Sample
 * tick and Buffer). The tick also has to keep the lock-free Buffer's safety
 * margin intact, which is the second assertion below.
 */

#ifndef KUUKI_APP_CONFIG_H
#define KUUKI_APP_CONFIG_H

#include <zephyr/toolchain.h>

#include "buffer.h"

/*
 * How many Samples the Retention target spans, *derived* from the configured
 * parameters — never a hard-coded Sample count. Changing the Sample interval
 * resizes the ring so it still spans the target. Deliberately not the ring's
 * capacity: the backing array is this plus BUFFER_RUNWAY, whose slots are
 * reserved for the lock-free Sync reader and are not retention.
 */
#define KUUKI_RETENTION_SAMPLES \
	(CONFIG_KUUKI_RETENTION_SEC / CONFIG_KUUKI_SAMPLE_INTERVAL_SEC)

/* An interval that does not divide the retention target would leave the ring
 * spanning less time than configured — the derivation quietly floors. */
BUILD_ASSERT(CONFIG_KUUKI_RETENTION_SEC % CONFIG_KUUKI_SAMPLE_INTERVAL_SEC == 0,
	     "Retention target must be a whole number of Sample intervals");

/* A Sync reads the ring lock-free behind BUFFER_RUNWAY reserved slots, which
 * buys `runway × Sample interval` of tolerance for a stalled consumer; a stalled
 * BLE link is torn down by the supervision timeout, whose Bluetooth Core-spec
 * ceiling is 32 s. Nothing checks the margin at runtime — by design, since it is
 * unreachable at any sane cadence (ADR-0005) — but the Kconfig range permits
 * ticks short enough to collapse it, and a short tick paired with a shortened
 * retention target is a plausible bench build. Hold the budget at 10x the
 * ceiling, which the v1 cadence clears by 11x. */
BUILD_ASSERT(BUFFER_RUNWAY * CONFIG_KUUKI_SAMPLE_INTERVAL_SEC >= 10 * 32,
	     "Sample tick too short: the Buffer runway's stall budget must stay "
	     "10x above the 32 s BLE supervision-timeout ceiling (ADR-0005)");

#endif /* KUUKI_APP_CONFIG_H */
