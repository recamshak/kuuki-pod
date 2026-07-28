/*
 * Host ztests for the firmware's project parameters (ticket 14b): the Sample
 * interval and the Buffer's retention target, and the ring capacity derived
 * from them. These are product decisions, not Buffer facts — the ring is a dumb
 * container that is handed a capacity — so the derivation is asserted here, at
 * the configuration layer that owns it, rather than in tests/buffer/.
 *
 * Twister builds this suite twice (see testcase.yaml): once at the parameters
 * the Pod ships with, and once with the Sample interval overridden, which is
 * what pins "changing the interval resizes the ring" to a real Kconfig build
 * rather than to arithmetic on literals.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/ztest.h>

#include "app_config.h"

/*
 * The capacity each configured cadence must derive, stated as a concrete Sample
 * count so the assertions below cannot degenerate into restating the formula.
 */
#if CONFIG_KUUKI_SAMPLE_INTERVAL_SEC == 900
#define EXPECTED_CAPACITY 2880 /* 30 days / 15 min */
#elif CONFIG_KUUKI_SAMPLE_INTERVAL_SEC == 300
#define EXPECTED_CAPACITY 8640 /* 30 days / 5 min */
#else
#error "No expected capacity for this Sample interval; add one alongside the twister scenario"
#endif

ZTEST_SUITE(config, NULL, NULL, NULL, NULL, NULL);

/*
 * The v1 parameters: a 15-minute Sample tick over 30 days. Only asserted in the
 * scenario that ships — the override scenario deliberately runs a different
 * cadence.
 */
#if CONFIG_KUUKI_SAMPLE_INTERVAL_SEC == 900
ZTEST(config, test_v1_defaults)
{
	zassert_equal(CONFIG_KUUKI_SAMPLE_INTERVAL_SEC, 900,
		      "v1 Sample tick is 15 minutes");
	zassert_equal(CONFIG_KUUKI_RETENTION_SEC, 30 * 24 * 60 * 60,
		      "v1 retention target is 30 days");
}
#endif

/*
 * Capacity is derived, never a hard-coded Sample count: at whichever cadence is
 * configured, the ring holds exactly the Samples that span the retention target.
 */
ZTEST(config, test_capacity_spans_the_retention_target)
{
	zassert_equal(KUUKI_BUFFER_CAPACITY, EXPECTED_CAPACITY,
		      "the configured cadence derives its expected Sample count");
	zassert_equal((size_t)KUUKI_BUFFER_CAPACITY * CONFIG_KUUKI_SAMPLE_INTERVAL_SEC,
		      CONFIG_KUUKI_RETENTION_SEC,
		      "capacity must span the whole retention target");
}
