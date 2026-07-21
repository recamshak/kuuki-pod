import { beforeEach, describe, expect, it } from 'vitest';
import { Fleet, type FleetDeps, type PodConnectionLike } from './fleet';
import { applySync, History, type KeyValueStore, type SyncRecord } from './history';
import type { LiveReading } from './wire';

// Fleet drives the whole Pod lifecycle behind an injected interface (ticket 11a).
// These suites assert external behaviour only — fakes and method calls in, getter
// values and which change signal fired out — never the private registries, so they
// survive a reimplementation. Prior art: EnumerableFakeStore in pods.test.ts, the
// store double in history.test.ts.

/** In-memory KeyValueStore so a fake connection can carry a real, persistable History. */
class FakeStore implements KeyValueStore {
  private readonly map = new Map<string, string>();
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

function rec(age: number, co2: number, temp = 2100, humidity = 5000): SyncRecord {
  return { age, co2, temp, humidity };
}

function live(co2: number, temp = 2100, humidity = 5000): LiveReading {
  return { co2, temp, humidity };
}

/**
 * A hand-rolled PodConnectionLike. Its `sync()` folds a scripted batch into a real
 * History (so `selectedHistory` reflects a genuine Merge); `emitLive()` and `drop()`
 * fire the callbacks Fleet subscribes, exactly as the real transport would.
 */
class FakeConnection implements PodConnectionLike {
  readonly history: History;
  liveReading: LiveReading | null;
  onLiveReading?: (reading: LiveReading | null) => void;
  onDisconnected?: () => void;

  syncCalls = 0;
  disconnectCalls = 0;
  /** When set, sync() rejects with this instead of Merging (drives error paths). */
  syncError: Error | null = null;

  constructor(
    readonly podId: string,
    /** Records folded into History on each sync(), oldest-first. */
    private readonly batch: SyncRecord[] = [rec(900, 800)],
    initialLive: LiveReading | null = null,
  ) {
    this.history = new History(podId, { store: new FakeStore() });
    this.liveReading = initialLive;
  }

  sync(): Promise<void> {
    this.syncCalls++;
    if (this.syncError) return Promise.reject(this.syncError);
    applySync(this.history, this.batch, T0 + this.syncCalls * 900_000);
    return Promise.resolve();
  }

  disconnect(): void {
    this.disconnectCalls++;
  }

  /** Simulate a Live reading notification arriving from the Pod. */
  emitLive(reading: LiveReading | null): void {
    this.liveReading = reading;
    this.onLiveReading?.(reading);
  }

  /** Simulate the link dropping. */
  drop(): void {
    this.onDisconnected?.();
  }
}

/** A signal recorder that counts fires, so a test can assert which callback fired. */
function counter() {
  let count = 0;
  return { fire: () => void count++, get count() { return count; } };
}

/**
 * A hand-driven scheduler double: captures the callback Fleet registers for its
 * auto-sync loop so a test can `tick()` it by hand instead of waiting 60 s of
 * wall-clock. `cancel()` records that Fleet released the schedule.
 */
function fakeScheduler() {
  let cb: (() => void) | null = null;
  let everyMs = 0;
  let cancelled = false;
  return {
    schedule: (fn: () => void, ms: number) => {
      cb = fn;
      everyMs = ms;
      return () => {
        cancelled = true;
      };
    },
    /** Fire one auto-sync tick. */
    tick: () => cb?.(),
    get everyMs() {
      return everyMs;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

/** Build FleetDeps with sensible no-op defaults; override per test. */
function makeDeps(overrides: Partial<FleetDeps> = {}): FleetDeps {
  return {
    connectPod: () => Promise.reject(new Error('connectPod not configured')),
    reconnectPods: () => {},
    listPodIds: () => [],
    makeHistory: (id) => new History(id, { store: new FakeStore() }),
    schedule: () => () => {},
    selectionStore: new FakeStore(),
    deleteHistory: () => {},
    ...overrides,
  };
}

describe('Fleet — persistence load', () => {
  it('populates knownPodIds from listPodIds with no connection', () => {
    const fleet = new Fleet(makeDeps({ listPodIds: () => ['pod-a', 'pod-b'] }));
    expect(fleet.knownPodIds.sort()).toEqual(['pod-a', 'pod-b']);
    expect(fleet.connected).toBe(false);
  });

  it('auto-selects the sole persisted Pod and exposes its History, still unconnected', () => {
    const store = new FakeStore();
    // Seed persisted History for the one known Pod.
    applySync(new History('pod-only', { store }), [rec(900, 640)], T0);

    const fleet = new Fleet(
      makeDeps({
        listPodIds: () => ['pod-only'],
        makeHistory: (id) => new History(id, { store }),
      }),
    );

    expect(fleet.selectedPodId).toBe('pod-only');
    expect(fleet.selectedHistory?.samples().map((s) => s.co2)).toEqual([640]);
    expect(fleet.connected).toBe(false);
    expect(fleet.live).toBeNull();
  });

  it('does not auto-select when several Pods are persisted', () => {
    const fleet = new Fleet(makeDeps({ listPodIds: () => ['pod-a', 'pod-b'] }));
    expect(fleet.selectedPodId).toBeNull();
    expect(fleet.selectedHistory).toBeUndefined();
  });
});

describe('Fleet — connect', () => {
  let history = counter();
  let state = counter();

  function wire(fleet: Fleet) {
    history = counter();
    state = counter();
    fleet.onHistoryChange = history.fire;
    fleet.onStateChange = state.fire;
  }

  it('focuses the picked Pod, Syncs it, and fires onHistoryChange', async () => {
    const conn = new FakeConnection('pod-x', [rec(900, 700)]);
    const fleet = new Fleet(makeDeps({ connectPod: () => Promise.resolve(conn) }));
    wire(fleet);

    await fleet.connect();

    expect(fleet.selectedPodId).toBe('pod-x');
    expect(fleet.connected).toBe(true);
    expect(fleet.knownPodIds).toContain('pod-x');
    expect(conn.syncCalls).toBe(1);
    expect(fleet.selectedHistory?.samples().map((s) => s.co2)).toEqual([700]);
    expect(history.count).toBe(1);
  });

  it('focuses the manually-picked Pod even when another is already selected', async () => {
    const conn = new FakeConnection('pod-new');
    const fleet = new Fleet(
      makeDeps({
        listPodIds: () => ['pod-old'],
        connectPod: () => Promise.resolve(conn),
      }),
    );
    expect(fleet.selectedPodId).toBe('pod-old'); // sole persisted Pod auto-selected

    await fleet.connect();
    expect(fleet.selectedPodId).toBe('pod-new'); // manual pick takes focus
  });

  it('a cancelled device chooser (NotFoundError) registers nothing and leaves error null', async () => {
    const fleet = new Fleet(
      makeDeps({
        connectPod: () => Promise.reject(new DOMException('cancelled', 'NotFoundError')),
      }),
    );
    wire(fleet);

    await fleet.connect();

    expect(fleet.knownPodIds).toEqual([]);
    expect(fleet.selectedPodId).toBeNull();
    expect(fleet.error).toBeNull();
    expect(fleet.busy).toBe(false);
    expect(history.count).toBe(0);
  });

  it('a real connect failure surfaces on error and clears busy', async () => {
    const fleet = new Fleet(
      makeDeps({ connectPod: () => Promise.reject(new Error('GATT failed')) }),
    );
    wire(fleet);

    await fleet.connect();

    expect(fleet.error).toBe('GATT failed');
    expect(fleet.busy).toBe(false);
    expect(fleet.knownPodIds).toEqual([]);
  });

  it('calls the injected connectPod synchronously (Web Bluetooth gesture preserved)', () => {
    let called = false;
    const conn = new FakeConnection('pod-x');
    const fleet = new Fleet(
      makeDeps({
        connectPod: () => {
          called = true;
          return Promise.resolve(conn);
        },
      }),
    );

    // No await: connectPod must already have run by the time connect() returns.
    const pending = fleet.connect();
    expect(called).toBe(true);
    return pending;
  });

  it('sets busy while a connect is in flight and clears it after', async () => {
    let resolveConn!: (c: PodConnectionLike) => void;
    const fleet = new Fleet(
      makeDeps({ connectPod: () => new Promise<PodConnectionLike>((r) => (resolveConn = r)) }),
    );

    const pending = fleet.connect();
    expect(fleet.busy).toBe(true);

    resolveConn(new FakeConnection('pod-x'));
    await pending;
    expect(fleet.busy).toBe(false);
  });
});

describe('Fleet — sync', () => {
  it('Syncs the selected Pod and fires onHistoryChange', async () => {
    const conn = new FakeConnection('pod-x', [rec(900, 700)]);
    const fleet = new Fleet(makeDeps({ connectPod: () => Promise.resolve(conn) }));
    await fleet.connect();

    const history = counter();
    fleet.onHistoryChange = history.fire;

    await fleet.sync();

    expect(conn.syncCalls).toBe(2); // once on connect, once here
    expect(history.count).toBe(1);
  });

  it('is a no-op when the selected Pod has no live connection', async () => {
    // A persisted-but-unconnected Pod is auto-selected on load.
    const fleet = new Fleet(makeDeps({ listPodIds: () => ['pod-persisted'] }));
    const history = counter();
    fleet.onHistoryChange = history.fire;

    await fleet.sync();

    expect(history.count).toBe(0);
    expect(fleet.error).toBeNull();
  });
});

describe('Fleet — Live-reading fan-in', () => {
  it('updates the selected Pod live, fires onStateChange, and does not fire onHistoryChange', async () => {
    const conn = new FakeConnection('pod-x');
    const fleet = new Fleet(makeDeps({ connectPod: () => Promise.resolve(conn) }));
    await fleet.connect();

    const history = counter();
    const state = counter();
    fleet.onHistoryChange = history.fire;
    fleet.onStateChange = state.fire;

    conn.emitLive(live(742));

    expect(fleet.live).toEqual(live(742));
    expect(state.count).toBe(1);
    expect(history.count).toBe(0); // chart/zoom must not rebuild on a Live reading
  });

  it('a reading for a non-selected Pod does not change the selected live value', async () => {
    const a = new FakeConnection('pod-a');
    const b = new FakeConnection('pod-b');
    const conns = [a, b];
    let i = 0;
    const fleet = new Fleet(makeDeps({ connectPod: () => Promise.resolve(conns[i++]) }));

    await fleet.connect(); // pod-a, now selected
    await fleet.connect(); // pod-b, manual connect focuses it
    fleet.select('pod-a');

    b.emitLive(live(999));
    expect(fleet.live).toBeNull(); // pod-a never emitted; pod-b's reading is not shown
    a.emitLive(live(500));
    expect(fleet.live).toEqual(live(500));
  });
});

describe('Fleet — disconnect', () => {
  it('drops the connection but keeps the Pod History and its place in knownPodIds', async () => {
    const conn = new FakeConnection('pod-x', [rec(900, 700)]);
    const fleet = new Fleet(makeDeps({ connectPod: () => Promise.resolve(conn) }));
    await fleet.connect();
    expect(fleet.connected).toBe(true);

    const state = counter();
    fleet.onStateChange = state.fire;

    conn.drop();

    expect(fleet.connected).toBe(false);
    expect(fleet.knownPodIds).toContain('pod-x');
    expect(fleet.selectedHistory?.samples().map((s) => s.co2)).toEqual([700]);
    expect(state.count).toBe(1);
  });

  it('re-links a dropped Pod from a fresh connection without duplicating knownPodIds', async () => {
    // The transport re-delivers a brand-new PodConnection for the same Pod after a
    // drop (persistent pairing); Fleet must re-register it, not accrete a duplicate.
    let deliver!: (conn: PodConnectionLike) => void;
    const first = new FakeConnection('pod-x', [rec(900, 700)]);
    const fleet = new Fleet(
      makeDeps({
        connectPod: () => Promise.resolve(first),
        reconnectPods: (onReconnect) => (deliver = onReconnect),
      }),
    );
    await fleet.connect();
    first.drop();
    expect(fleet.connected).toBe(false);

    const again = new FakeConnection('pod-x', [rec(900, 700)]);
    await deliver(again);

    expect(fleet.connected).toBe(true);
    expect(fleet.selectedPodId).toBe('pod-x');
    expect(fleet.knownPodIds).toEqual(['pod-x']);
    expect(again.syncCalls).toBe(1);
  });
});

describe('Fleet — reconnect loop', () => {
  it('adds each Pod as it comes up and auto-selects the first', async () => {
    let deliver!: (conn: PodConnectionLike) => void;
    const fleet = new Fleet(
      makeDeps({ reconnectPods: (onReconnect) => (deliver = onReconnect) }),
    );

    expect(fleet.knownPodIds).toEqual([]);
    expect(fleet.selectedPodId).toBeNull();

    const first = new FakeConnection('pod-1', [rec(900, 600)]);
    const second = new FakeConnection('pod-2', [rec(900, 700)]);

    await deliver(first);
    expect(fleet.selectedPodId).toBe('pod-1'); // first up is auto-selected
    expect(fleet.knownPodIds).toEqual(['pod-1']);

    await deliver(second);
    expect(fleet.selectedPodId).toBe('pod-1'); // a later Pod does not steal focus
    expect(fleet.knownPodIds).toEqual(['pod-1', 'pod-2']);
    expect(first.syncCalls).toBe(1);
    expect(second.syncCalls).toBe(1);
  });

  it('a reconnect does not steal focus from the auto-selected sole persisted Pod', async () => {
    let deliver!: (conn: PodConnectionLike) => void;
    // The sole persisted Pod is auto-selected on load; then its own link comes back.
    const fleet = new Fleet(
      makeDeps({
        listPodIds: () => ['pod-1'],
        reconnectPods: (onReconnect) => (deliver = onReconnect),
      }),
    );
    expect(fleet.selectedPodId).toBe('pod-1');
    expect(fleet.connected).toBe(false);

    await deliver(new FakeConnection('pod-1', [rec(900, 640)]));

    expect(fleet.selectedPodId).toBe('pod-1'); // kept focus, now live
    expect(fleet.connected).toBe(true);
    expect(fleet.knownPodIds).toEqual(['pod-1']); // no duplicate entry
  });
});

describe('Fleet — per-Pod keying', () => {
  it('keeps each Pod History independent (no cross-contamination)', async () => {
    const a = new FakeConnection('pod-a', [rec(900, 600)]);
    const b = new FakeConnection('pod-b', [rec(900, 700)]);
    const conns = [a, b];
    let i = 0;
    const fleet = new Fleet(makeDeps({ connectPod: () => Promise.resolve(conns[i++]) }));

    await fleet.connect(); // pod-a
    await fleet.connect(); // pod-b

    fleet.select('pod-a');
    expect(fleet.selectedHistory?.samples().map((s) => s.co2)).toEqual([600]);
    fleet.select('pod-b');
    expect(fleet.selectedHistory?.samples().map((s) => s.co2)).toEqual([700]);
  });
});

describe('Fleet — select', () => {
  it('changes selection and fires onStateChange only when it actually changes', async () => {
    const a = new FakeConnection('pod-a');
    const b = new FakeConnection('pod-b');
    const conns = [a, b];
    let i = 0;
    const fleet = new Fleet(makeDeps({ connectPod: () => Promise.resolve(conns[i++]) }));
    await fleet.connect();
    await fleet.connect();

    const state = counter();
    fleet.onStateChange = state.fire;

    fleet.select('pod-a');
    expect(fleet.selectedPodId).toBe('pod-a');
    expect(state.count).toBe(1);

    fleet.select('pod-a'); // already selected: no signal
    expect(state.count).toBe(1);
  });
});

describe('Fleet — per-Pod view (pods)', () => {
  it('lists every known Pod with its connected and syncing flags', async () => {
    const a = new FakeConnection('pod-a');
    const b = new FakeConnection('pod-b');
    const conns = [a, b];
    let i = 0;
    const fleet = new Fleet(
      makeDeps({
        listPodIds: () => ['pod-persisted'],
        connectPod: () => Promise.resolve(conns[i++]),
      }),
    );

    await fleet.connect(); // pod-a connects
    await fleet.connect(); // pod-b connects

    const byId = new Map(fleet.pods.map((p) => [p.id, p]));
    expect(new Set(byId.keys())).toEqual(new Set(['pod-persisted', 'pod-a', 'pod-b']));
    expect(byId.get('pod-persisted')).toEqual({ id: 'pod-persisted', connected: false, syncing: false });
    expect(byId.get('pod-a')).toEqual({ id: 'pod-a', connected: true, syncing: false });
    expect(byId.get('pod-b')).toEqual({ id: 'pod-b', connected: true, syncing: false });
  });
});

describe('Fleet — per-Pod syncing', () => {
  it('toggles the selected Pod syncing around a sync and fires onStateChange on both edges', async () => {
    let resolveSync!: () => void;
    const conn = new FakeConnection('pod-x');
    conn.sync = () => {
      conn.syncCalls++;
      return new Promise<void>((r) => (resolveSync = () => r()));
    };
    const fleet = new Fleet(makeDeps({ connectPod: () => Promise.resolve(conn) }));

    const state = counter();
    fleet.onStateChange = state.fire;

    const pending = fleet.connect();
    await Promise.resolve(); // let connectPod resolve and the sync begin
    await Promise.resolve();
    expect(fleet.syncing).toBe(true); // sync in flight for the selected Pod
    const before = state.count;

    resolveSync();
    await pending;

    expect(fleet.syncing).toBe(false);
    expect(state.count).toBeGreaterThan(before); // a transition off fired a state change
  });
});

describe('Fleet — auto-sync', () => {
  it('syncs every connected Pod on a tick and fires onHistoryChange per Merge', async () => {
    const clock = fakeScheduler();
    const a = new FakeConnection('pod-a', [rec(900, 600)]);
    const b = new FakeConnection('pod-b', [rec(900, 700)]);
    const conns = [a, b];
    let i = 0;
    const fleet = new Fleet(
      makeDeps({ connectPod: () => Promise.resolve(conns[i++]), schedule: clock.schedule }),
    );
    await fleet.connect();
    await fleet.connect();
    expect(a.syncCalls).toBe(1);
    expect(b.syncCalls).toBe(1);

    const history = counter();
    fleet.onHistoryChange = history.fire;

    clock.tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(a.syncCalls).toBe(2);
    expect(b.syncCalls).toBe(2);
    expect(history.count).toBe(2); // one Merge per connected Pod
  });

  it('registers the schedule at a 60 s cadence', () => {
    const clock = fakeScheduler();
    new Fleet(makeDeps({ schedule: clock.schedule }));
    expect(clock.everyMs).toBe(60_000);
  });

  it('skips a Pod already syncing (no overlapping sync)', async () => {
    const clock = fakeScheduler();
    let resolveFirst!: () => void;
    const conn = new FakeConnection('pod-x');
    // First sync blocks; a second overlapping sync must not be issued by the tick.
    conn.sync = () => {
      conn.syncCalls++;
      if (conn.syncCalls === 1) return new Promise<void>((r) => (resolveFirst = () => r()));
      return Promise.resolve();
    };
    const fleet = new Fleet(
      makeDeps({ connectPod: () => Promise.resolve(conn), schedule: clock.schedule }),
    );

    const pending = fleet.connect(); // sync #1 in flight, pod-x is syncing
    await Promise.resolve(); // let connectPod resolve and the sync begin
    await Promise.resolve();
    expect(fleet.syncing).toBe(true);

    clock.tick(); // must skip pod-x — it is already syncing
    expect(conn.syncCalls).toBe(1);

    resolveFirst();
    await pending;
    expect(conn.syncCalls).toBe(1);
  });

  it('does not set busy, does not surface an error, and keeps looping when a background sync throws', async () => {
    const clock = fakeScheduler();
    const conn = new FakeConnection('pod-x', [rec(900, 700)]);
    const fleet = new Fleet(
      makeDeps({ connectPod: () => Promise.resolve(conn), schedule: clock.schedule }),
    );
    await fleet.connect();

    const state = counter();
    fleet.onHistoryChange = counter().fire;
    fleet.onStateChange = state.fire;

    conn.syncError = new Error('background boom');
    clock.tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(fleet.busy).toBe(false);
    expect(fleet.error).toBeNull(); // background failure is swallowed
    expect(fleet.syncing).toBe(false); // syncing cleared even though the sync threw

    conn.syncError = null;
    clock.tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(conn.syncCalls).toBe(3); // connect + failed tick + healthy tick: loop continues
  });
});

describe('Fleet — reconnect sync is a background sync', () => {
  it('does not set busy and swallows a reconnect sync error', async () => {
    let deliver!: (conn: PodConnectionLike) => void;
    const fleet = new Fleet(
      makeDeps({ reconnectPods: (onReconnect) => (deliver = onReconnect) }),
    );

    const conn = new FakeConnection('pod-1');
    conn.syncError = new Error('reconnect boom');
    await deliver(conn);
    // let the swallowed background sync settle
    await Promise.resolve();
    await Promise.resolve();

    expect(fleet.busy).toBe(false);
    expect(fleet.error).toBeNull();
    expect(fleet.connected).toBe(true); // still registered despite the failed sync
  });
});

describe('Fleet — selection persistence', () => {
  it('persists the selected Pod id via the injected store on select', async () => {
    const selectionStore = new FakeStore();
    const a = new FakeConnection('pod-a');
    const b = new FakeConnection('pod-b');
    const conns = [a, b];
    let i = 0;
    const fleet = new Fleet(
      makeDeps({ connectPod: () => Promise.resolve(conns[i++]), selectionStore }),
    );
    await fleet.connect();
    await fleet.connect();

    fleet.select('pod-a');
    // Reload with the same store: the selection is restored even before any connection.
    const reloaded = new Fleet(
      makeDeps({ listPodIds: () => ['pod-a', 'pod-b'], selectionStore }),
    );
    expect(reloaded.selectedPodId).toBe('pod-a');
  });

  it('restores a persisted selection whose Pod is disconnected, still showing its History', () => {
    const selectionStore = new FakeStore();
    selectionStore.setItem('kuuki:selected', 'pod-b');
    const store = new FakeStore();
    applySync(new History('pod-b', { store }), [rec(900, 640)], T0);

    const fleet = new Fleet(
      makeDeps({
        listPodIds: () => ['pod-a', 'pod-b'],
        makeHistory: (id) => new History(id, { store }),
        selectionStore,
      }),
    );

    expect(fleet.selectedPodId).toBe('pod-b');
    expect(fleet.connected).toBe(false);
    expect(fleet.selectedHistory?.samples().map((s) => s.co2)).toEqual([640]);
  });

  it('a restored persisted selection wins over the sole-Pod auto-select', () => {
    const selectionStore = new FakeStore();
    selectionStore.setItem('kuuki:selected', 'pod-b');
    const fleet = new Fleet(
      makeDeps({ listPodIds: () => ['pod-a', 'pod-b'], selectionStore }),
    );
    expect(fleet.selectedPodId).toBe('pod-b');
  });

  it('a reconnect does not steal selection from a restored persisted choice', async () => {
    let deliver!: (conn: PodConnectionLike) => void;
    const selectionStore = new FakeStore();
    selectionStore.setItem('kuuki:selected', 'pod-b');
    const fleet = new Fleet(
      makeDeps({
        listPodIds: () => ['pod-a', 'pod-b'],
        reconnectPods: (onReconnect) => (deliver = onReconnect),
        selectionStore,
      }),
    );
    expect(fleet.selectedPodId).toBe('pod-b');

    await deliver(new FakeConnection('pod-a', [rec(900, 600)])); // the other Pod comes up first
    expect(fleet.selectedPodId).toBe('pod-b'); // restored choice is not stolen
  });
});

describe('Fleet — new-Pod signal', () => {
  it('fires onNewPod once for a Pod absent from the startup persisted set', async () => {
    let deliver!: (conn: PodConnectionLike) => void;
    const fleet = new Fleet(
      makeDeps({ reconnectPods: (onReconnect) => (deliver = onReconnect) }),
    );
    const seen: string[] = [];
    fleet.onNewPod = (id) => seen.push(id);

    const conn = new FakeConnection('pod-new');
    await deliver(conn);
    expect(seen).toEqual(['pod-new']);

    conn.drop();
    await deliver(new FakeConnection('pod-new')); // reconnect of the same Pod
    expect(seen).toEqual(['pod-new']); // still once
  });

  it('does not fire onNewPod for a persisted Pod reconnecting on reload', async () => {
    let deliver!: (conn: PodConnectionLike) => void;
    const fleet = new Fleet(
      makeDeps({
        listPodIds: () => ['pod-known'],
        reconnectPods: (onReconnect) => (deliver = onReconnect),
      }),
    );
    const seen: string[] = [];
    fleet.onNewPod = (id) => seen.push(id);

    await deliver(new FakeConnection('pod-known'));
    expect(seen).toEqual([]);
  });

  it('fires onNewPod for a manually connected new Pod', async () => {
    const conn = new FakeConnection('pod-x');
    const fleet = new Fleet(makeDeps({ connectPod: () => Promise.resolve(conn) }));
    const seen: string[] = [];
    fleet.onNewPod = (id) => seen.push(id);

    await fleet.connect();
    expect(seen).toEqual(['pod-x']);
  });
});

describe('Fleet — remove', () => {
  it('stops supervision, disconnects, deletes History, drops all state, and re-selects', async () => {
    let deliver!: (conn: PodConnectionLike, forget: () => Promise<void>) => void;
    const deleted: string[] = [];
    const fleet = new Fleet(
      makeDeps({
        reconnectPods: (onReconnect) =>
          (deliver = onReconnect as (c: PodConnectionLike, f: () => Promise<void>) => void),
        deleteHistory: (id) => deleted.push(id),
      }),
    );

    let forgot = false;
    const a = new FakeConnection('pod-a', [rec(900, 600)]);
    const b = new FakeConnection('pod-b', [rec(900, 700)]);
    await deliver(a, () => {
      forgot = true;
      return Promise.resolve();
    });
    await deliver(b, () => Promise.resolve());
    fleet.select('pod-a');
    expect(fleet.selectedPodId).toBe('pod-a');

    const state = counter();
    fleet.onStateChange = state.fire;

    await fleet.remove('pod-a');

    expect(forgot).toBe(true); // supervision stopped + grant revoked via injected forget
    expect(deleted).toEqual(['pod-a']); // persisted History wiped
    expect(fleet.knownPodIds).toEqual(['pod-b']); // dropped from the known set
    expect(fleet.pods.map((p) => p.id)).toEqual(['pod-b']);
    expect(fleet.selectedPodId).toBe('pod-b'); // re-selected another Pod
    expect(state.count).toBeGreaterThan(0);
  });

  it('disconnects a Pod with no supervision handle and leaves selection null when it was the only Pod', async () => {
    const deleted: string[] = [];
    const conn = new FakeConnection('pod-only');
    const fleet = new Fleet(
      makeDeps({
        connectPod: () => Promise.resolve(conn),
        deleteHistory: (id) => deleted.push(id),
      }),
    );
    await fleet.connect();
    expect(fleet.selectedPodId).toBe('pod-only');

    await fleet.remove('pod-only');

    expect(conn.disconnectCalls).toBe(1);
    expect(deleted).toEqual(['pod-only']);
    expect(fleet.knownPodIds).toEqual([]);
    expect(fleet.selectedPodId).toBeNull();
    expect(fleet.selectedHistory).toBeUndefined();
  });
});
