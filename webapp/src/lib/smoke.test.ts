import { describe, expect, it } from 'vitest';
import { harnessRuns } from './smoke';

// If this suite fails, the Vitest harness or the Node test environment itself
// is broken — not any application logic.
describe('smoke', () => {
  it('runs pure logic with no browser, Web Bluetooth, or DOM', () => {
    expect(harnessRuns()).toBe(true);
    expect(2 + 2).toBe(4);
  });

  it('has no DOM or Web Bluetooth in the test environment', () => {
    // Asserts the runner is genuinely headless (environment: "node"), so the
    // correctness seams are exercised in isolation from any UI or transport.
    expect(typeof document).toBe('undefined');
    expect((globalThis.navigator as { bluetooth?: unknown })?.bluetooth).toBeUndefined();
  });
});
