/*
 * Smoke module — the reference pattern for TDD'ing webapp logic in fast
 * isolation.
 *
 * This exists to prove the Vitest runner exercises pure TypeScript with no
 * browser, no Web Bluetooth, and no DOM. The real correctness-critical seam —
 * the slot-keyed `applySync` Merge and the wire-record decoder (ticket 08) —
 * is added as pure modules alongside this one and tested by suites shaped like
 * `smoke.test.ts`: inputs to outputs, never internal representation.
 */

/** Trivial pure function. If its test fails, the runner itself is broken. */
export function harnessRuns(): boolean {
  return true;
}
