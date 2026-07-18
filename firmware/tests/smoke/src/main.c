/*
 * Smoke test — the reference pattern for TDD'ing Pod logic off-board.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * This suite exists to prove the native_sim ztest harness builds and runs
 * green on a developer's laptop, with no hardware attached. Real
 * correctness-critical modules (the Buffer collect() query, ticket 04, and
 * friends) are added as pure sources and exercised by suites shaped like this
 * one — inputs to outputs, never internal representation.
 */

#include <zephyr/ztest.h>

ZTEST_SUITE(smoke, NULL, NULL, NULL, NULL, NULL);

/* If this fails, the host toolchain or the ztest harness itself is broken. */
ZTEST(smoke, test_harness_runs)
{
	zassert_equal(2 + 2, 4, "host arithmetic is broken");
}
