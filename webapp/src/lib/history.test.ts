import { describe, expect, it } from 'vitest';
import { applySync, History, type KeyValueStore, type SyncRecord } from './history';

// A per-Pod History plus the idempotent applySync() Merge (ticket 08). These
// suites assert external behaviour — records in, stored Samples out — never the
// localStorage byte layout, so they survive a reimplementation of the encoding.

/** In-memory KeyValueStore with a settable capacity to exercise the quota path. */
class FakeStore implements KeyValueStore {
  private readonly map = new Map<string, string>();
  /** Max stored-value length before setItem throws QuotaExceededError. */
  capacity = Infinity;

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    if (value.length > this.capacity) {
      const err = new Error('quota exceeded');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** One decoded Sync record (the shape applySync consumes; decode is upstream). */
function rec(age: number, co2: number, temp = 2100, humidity = 5000): SyncRecord {
  return { age, co2, temp, humidity };
}

const POD = 'pod-abc';
const TICK = 900; // 15-minute Sample tick, in seconds
const T0 = 1_700_000_000_000; // an arbitrary latched read instant, in ms

/**
 * Build an oldest-first payload whose Samples sit one Sample tick apart, ending
 * `age = endAge` seconds before the latch. `co2s` lists the readings oldest-first.
 */
function batch(co2s: number[], endAge = TICK): SyncRecord[] {
  return co2s.map((co2, i) => rec(endAge + (co2s.length - 1 - i) * TICK, co2));
}

function freshHistory(store: KeyValueStore = new FakeStore()): History {
  return new History(POD, { store });
}

describe('applySync — boundary dedup Merge', () => {
  it('re-Sync idempotency: drops exactly the boundary Sample and appends the rest', () => {
    const h = freshHistory();
    applySync(h, batch([800, 810, 820]), T0);
    expect(h.samples().map((s) => s.co2)).toEqual([800, 810, 820]);

    // Second Sync overlaps by one Sample: its oldest (820) matches our latest.
    applySync(h, batch([820, 830, 840]), T0 + 3 * TICK * 1000);

    // The boundary 820 is dropped once; no duplicate, the rest appended.
    expect(h.samples().map((s) => s.co2)).toEqual([800, 810, 820, 830, 840]);
  });

  it('boundary dedup survives Age drift: deduped by value even when t shifts', () => {
    const h = freshHistory();
    applySync(h, batch([800, 810, 820]), T0);
    const storedBoundaryT = h.latest()!.t;

    // Re-Sync with a latch 3 ticks later AND a few seconds of Age drift, so the
    // boundary Sample's recomputed wall-clock t differs from what we stored.
    const drift = 7;
    const later = T0 + 3 * TICK * 1000;
    applySync(h, batch([820, 830, 840], TICK + drift), later);

    const co2s = h.samples().map((s) => s.co2);
    expect(co2s).toEqual([800, 810, 820, 830, 840]);
    // Exactly one 820, and it is the originally stored one (drift did not fork it).
    expect(co2s.filter((c) => c === 820)).toHaveLength(1);
    const boundary = h.samples().find((s) => s.co2 === 820)!;
    expect(boundary.t).toBe(storedBoundaryT);
  });

  it('no false dedup: a genuine new reading at the boundary is kept', () => {
    const h = freshHistory();
    applySync(h, batch([800, 810, 820]), T0);

    // Oldest incoming (821) differs from latest stored (820): keep it all.
    applySync(h, batch([821, 830, 840]), T0 + 3 * TICK * 1000);

    expect(h.samples().map((s) => s.co2)).toEqual([800, 810, 820, 821, 830, 840]);
  });

  it('drop-recovery: a truncated prefix then a resumed Sync yields a hole-free History', () => {
    const store = new FakeStore();
    const h = freshHistory(store);

    // First Sync drops mid-batch after the oldest-first prefix [800, 810, 820].
    applySync(h, batch([800, 810, 820]), T0);
    expect(h.samples().map((s) => s.co2)).toEqual([800, 810, 820]);

    // Next Sync's advanced High-water mark re-fetches from the boundary: the
    // Pod resends 820 (overlap) then the previously-lost tail.
    applySync(h, batch([820, 830, 840, 850]), T0 + 3 * TICK * 1000);

    // Contiguous, no hole, no duplicated boundary Sample.
    expect(h.samples().map((s) => s.co2)).toEqual([800, 810, 820, 830, 840, 850]);
  });

  it('an empty Sync (nothing newer than the mark) leaves History untouched', () => {
    const h = freshHistory();
    applySync(h, batch([800, 810]), T0);
    applySync(h, [], T0 + 10 * TICK * 1000);
    expect(h.samples().map((s) => s.co2)).toEqual([800, 810]);
  });
});

describe('applySync — wall-clock placement', () => {
  it('places each Sample at t = nowMs − age × 1000', () => {
    const h = freshHistory();
    applySync(h, [rec(1800, 700), rec(900, 710)], T0);
    expect(h.samples()).toEqual([
      { t: T0 - 1800 * 1000, co2: 700, temp: 2100, humidity: 5000 },
      { t: T0 - 900 * 1000, co2: 710, temp: 2100, humidity: 5000 },
    ]);
  });
});

describe('History — storage', () => {
  it('QuotaExceededError path trims oldest and still lands the incoming Samples', () => {
    const store = new FakeStore();
    const h = new History(POD, { store });

    // Fill History while storage is roomy.
    applySync(h, batch(Array.from({ length: 40 }, (_, i) => 400 + i)), T0);
    const before = h.length;

    // Storage tightens so the next persist cannot hold everything.
    store.capacity = store.getItem('kuuki:history:' + POD)!.length;

    // Five brand-new readings arrive; none overlap the boundary.
    const later = T0 + 41 * TICK * 1000;
    applySync(h, batch([900, 901, 902, 903, 904], TICK), later);

    const co2s = h.samples().map((s) => s.co2);
    // The incoming Samples survived...
    expect(co2s.slice(-5)).toEqual([900, 901, 902, 903, 904]);
    // ...and oldest were trimmed to make room, so History shrank, not grew.
    expect(h.length).toBeLessThan(before + 5);

    // A fresh reader over the same store sees exactly the trimmed set.
    const reopened = new History(POD, { store });
    expect(reopened.samples().map((s) => s.co2)).toEqual(co2s);
  });

  it('persists per-Pod across sessions and keeps Pods independent', () => {
    const store = new FakeStore();

    applySync(new History('pod-1', { store }), batch([600, 610]), T0);
    applySync(new History('pod-2', { store }), batch([700]), T0);

    // A fresh session (new History objects) recovers each Pod's History.
    expect(new History('pod-1', { store }).samples().map((s) => s.co2)).toEqual([600, 610]);
    expect(new History('pod-2', { store }).samples().map((s) => s.co2)).toEqual([700]);
    // A never-seen Pod starts empty.
    expect(new History('pod-3', { store }).samples()).toEqual([]);
  });

  it('caps History at its maximum, trimming oldest Samples', () => {
    const store = new FakeStore();
    const h = new History(POD, { store, maxSamples: 5 });
    applySync(h, batch([1, 2, 3, 4, 5, 6, 7]), T0);

    // Only the 5 newest survive the cap.
    expect(h.samples().map((s) => s.co2)).toEqual([3, 4, 5, 6, 7]);
    // Cap holds across reload.
    expect(new History(POD, { store, maxSamples: 5 }).samples().map((s) => s.co2)).toEqual([
      3, 4, 5, 6, 7,
    ]);
  });

  it('defaults its cap to one million Samples per Pod', () => {
    expect(History.MAX_SAMPLES).toBe(1_000_000);
  });
});
