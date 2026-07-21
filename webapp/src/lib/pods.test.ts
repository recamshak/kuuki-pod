import { describe, expect, it } from 'vitest';
import { applySync, deleteHistory, History, listPodIds, type EnumerableKeyValueStore } from './history';

// listPodIds enumerates which Pods already have History in the store, so the UI
// can render charts on reload with no live connection (ticket 10 persistence).
// deleteHistory is its companion: it wipes a Pod's stored History so "forget
// Pod" can drop persisted data (ticket 12).

/** In-memory store that also supports enumeration (length / key), like localStorage. */
class EnumerableFakeStore implements EnumerableKeyValueStore {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const T0 = 1_700_000_000_000;

describe('listPodIds', () => {
  it('returns the Pod IDs that have stored History', () => {
    const store = new EnumerableFakeStore();
    applySync(new History('pod-a', { store }), [{ age: 900, co2: 600, temp: 2000, humidity: 5000 }], T0);
    applySync(new History('pod-b', { store }), [{ age: 900, co2: 700, temp: 2000, humidity: 5000 }], T0);

    expect(listPodIds(store).sort()).toEqual(['pod-a', 'pod-b']);
  });

  it('ignores unrelated keys and returns empty when no Pods are stored', () => {
    const store = new EnumerableFakeStore();
    store.setItem('some-other-app:setting', 'x');
    expect(listPodIds(store)).toEqual([]);
  });

  it('does not list a Pod whose History was never persisted (empty append)', () => {
    const store = new EnumerableFakeStore();
    // Constructing a History alone writes nothing; only a non-empty Merge persists.
    new History('pod-c', { store });
    expect(listPodIds(store)).toEqual([]);
  });
});

describe('deleteHistory', () => {
  const sample = { age: 900, co2: 600, temp: 2000, humidity: 5000 };

  it('removes the Pod so listPodIds no longer lists it', () => {
    const store = new EnumerableFakeStore();
    applySync(new History('pod-a', { store }), [sample], T0);
    expect(listPodIds(store)).toEqual(['pod-a']);

    deleteHistory('pod-a', store);
    expect(listPodIds(store)).toEqual([]);
  });

  it('is a no-op when the Pod has no stored History', () => {
    const store = new EnumerableFakeStore();
    expect(() => deleteHistory('never-seen', store)).not.toThrow();
    expect(listPodIds(store)).toEqual([]);
  });

  it('removes only the target Pod, leaving siblings intact', () => {
    const store = new EnumerableFakeStore();
    applySync(new History('pod-a', { store }), [sample], T0);
    applySync(new History('pod-b', { store }), [{ ...sample, co2: 700 }], T0);

    deleteHistory('pod-a', store);

    expect(listPodIds(store)).toEqual(['pod-b']);
    // pod-b's Samples survive untouched.
    expect(new History('pod-b', { store }).samples().map((s) => s.co2)).toEqual([700]);
  });

  it('does not throw when no ambient store is available', () => {
    // Simulate a store-less host (SSR / plain Node): the ambient global is absent.
    const g = globalThis as { localStorage?: unknown };
    const saved = g.localStorage;
    delete g.localStorage;
    try {
      expect(() => deleteHistory('pod-a')).not.toThrow();
    } finally {
      g.localStorage = saved;
    }
  });
});
