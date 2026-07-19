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

/** Build FleetDeps with sensible no-op defaults; override per test. */
function makeDeps(overrides: Partial<FleetDeps> = {}): FleetDeps {
  return {
    connectPod: () => Promise.reject(new Error('connectPod not configured')),
    reconnectPods: () => {},
    listPodIds: () => [],
    makeHistory: (id) => new History(id, { store: new FakeStore() }),
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
