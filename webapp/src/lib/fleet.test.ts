import { describe, expect, it } from 'vitest';
import { Fleet, type FleetDeps, type PodConnectionLike } from './fleet';
import { applySync, History, type KeyValueStore, type SyncRecord } from './history';
import { Names } from './names';
import type { LiveReading } from './wire';

// Fleet drives the whole Pod lifecycle behind an injected interface (tickets 11a,
// 13a). These suites assert external behaviour only — fakes and method calls in,
// `pods` values and which change signal fired out — never the private maps, so
// they survive a reimplementation. Prior art: EnumerableFakeStore in pods.test.ts,
// the store double in history.test.ts.

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
 * History (so `pods[].history` reflects a genuine Merge); `emitLive()` and `drop()`
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
    names: new Names({ store: new FakeStore() }),
    deleteHistory: () => {},
    ...overrides,
  };
}

/** The rich view of one Pod out of `fleet.pods`, or undefined when unknown. */
function pod(fleet: Fleet, id: string) {
  return fleet.pods.find((p) => p.id === id);
}

describe('Fleet — persistence load', () => {
  it('lists every persisted Pod as a rich, disconnected entry with its History', () => {
    const store = new FakeStore();
    applySync(new History('pod-a', { store }), [rec(900, 640)], T0);

    const fleet = new Fleet(
      makeDeps({
        listPodIds: () => ['pod-a', 'pod-b'],
        makeHistory: (id) => new History(id, { store }),
      }),
    );

    expect(fleet.pods.map((p) => p.id)).toEqual(['pod-a', 'pod-b']);
    const a = pod(fleet, 'pod-a')!;
    expect(a.connected).toBe(false);
    expect(a.syncing).toBe(false);
    expect(a.live).toBeNull();
    expect(a.history.samples().map((s) => s.co2)).toEqual([640]);
  });
});

describe('Fleet — rich Pod view (pods)', () => {
  it('returns id, name, connected, syncing, live and history in the order Pods became known', async () => {
    const names = new Names({ store: new FakeStore() });
    names.setName('pod-a', 'Living room');
    const a = new FakeConnection('pod-a', [rec(900, 600)]);
    const fleet = new Fleet(
      makeDeps({
        listPodIds: () => ['pod-persisted'],
        connectPod: () => Promise.resolve(a),
        names,
      }),
    );

    await fleet.connect();
    a.emitLive(live(742));

    expect(fleet.pods.map((p) => p.id)).toEqual(['pod-persisted', 'pod-a']);
    expect(pod(fleet, 'pod-persisted')).toMatchObject({
      name: 'pod-pers', // unnamed: 8-char hex-prefix fallback from names.ts
      connected: false,
      syncing: false,
      live: null,
    });
    expect(pod(fleet, 'pod-a')).toMatchObject({
      name: 'Living room',
      connected: true,
      syncing: false,
      live: live(742),
    });
    expect(pod(fleet, 'pod-a')!.history.samples().map((s) => s.co2)).toEqual([600]);
  });
});

describe('Fleet — names', () => {
  it('rename persists via the composed Names and fires onChange', () => {
    const names = new Names({ store: new FakeStore() });
    const fleet = new Fleet(makeDeps({ listPodIds: () => ['pod-a'], names }));
    const change = counter();
    fleet.onChange = change.fire;

    expect(fleet.hasName('pod-a')).toBe(false);
    fleet.rename('pod-a', 'Bedroom');

    expect(pod(fleet, 'pod-a')!.name).toBe('Bedroom');
    expect(fleet.hasName('pod-a')).toBe(true);
    expect(names.getName('pod-a')).toBe('Bedroom'); // persisted, not just cached
    expect(change.count).toBe(1);
  });
});

describe('Fleet — connect', () => {
  it('registers the picked Pod, Syncs it, resolves to its id, and fires onHistoryChange with it', async () => {
    const conn = new FakeConnection('pod-x', [rec(900, 700)]);
    const fleet = new Fleet(makeDeps({ connectPod: () => Promise.resolve(conn) }));
    const merged: string[] = [];
    fleet.onHistoryChange = (id) => merged.push(id);

    const id = await fleet.connect();

    expect(id).toBe('pod-x');
    expect(pod(fleet, 'pod-x')!.connected).toBe(true);
    expect(conn.syncCalls).toBe(1);
    expect(pod(fleet, 'pod-x')!.history.samples().map((s) => s.co2)).toEqual([700]);
    expect(merged).toEqual(['pod-x']);
  });

  it('a cancelled device chooser (NotFoundError) resolves null, registers nothing, leaves error null', async () => {
    const fleet = new Fleet(
      makeDeps({
        connectPod: () => Promise.reject(new DOMException('cancelled', 'NotFoundError')),
      }),
    );

    const id = await fleet.connect();

    expect(id).toBeNull();
    expect(fleet.pods).toEqual([]);
    expect(fleet.error).toBeNull();
    expect(fleet.busy).toBe(false);
  });

  it('a real connect failure resolves null, surfaces on error, and clears busy', async () => {
    const fleet = new Fleet(
      makeDeps({ connectPod: () => Promise.reject(new Error('GATT failed')) }),
    );

    const id = await fleet.connect();

    expect(id).toBeNull();
    expect(fleet.error).toBe('GATT failed');
    expect(fleet.busy).toBe(false);
    expect(fleet.pods).toEqual([]);
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

describe('Fleet — sync(podId)', () => {
  it('Syncs that Pod and fires onHistoryChange with its id', async () => {
    const conn = new FakeConnection('pod-x', [rec(900, 700)]);
    const fleet = new Fleet(makeDeps({ connectPod: () => Promise.resolve(conn) }));
    await fleet.connect();

    const merged: string[] = [];
    fleet.onHistoryChange = (id) => merged.push(id);

    await fleet.sync('pod-x');

    expect(conn.syncCalls).toBe(2); // once on connect, once here
    expect(merged).toEqual(['pod-x']);
  });

  it('is a no-op for a Pod with no live connection', async () => {
    const fleet = new Fleet(makeDeps({ listPodIds: () => ['pod-persisted'] }));
    const merged: string[] = [];
    fleet.onHistoryChange = (id) => merged.push(id);

    await fleet.sync('pod-persisted');

    expect(merged).toEqual([]);
    expect(fleet.error).toBeNull();
  });
});

describe('Fleet — Live-reading fan-in', () => {
  it('updates that Pod live, fires onChange, and does not fire onHistoryChange', async () => {
    const conn = new FakeConnection('pod-x');
    const fleet = new Fleet(makeDeps({ connectPod: () => Promise.resolve(conn) }));
    await fleet.connect();

    const history = counter();
    const change = counter();
    fleet.onHistoryChange = history.fire;
    fleet.onChange = change.fire;

    conn.emitLive(live(742));

    expect(pod(fleet, 'pod-x')!.live).toEqual(live(742));
    expect(change.count).toBe(1);
    expect(history.count).toBe(0); // chart/zoom must not rebuild on a Live reading
  });

  it('keeps each Pod live reading independent (no cross-contamination)', async () => {
    const a = new FakeConnection('pod-a');
    const b = new FakeConnection('pod-b');
    const conns = [a, b];
    let i = 0;
    const fleet = new Fleet(makeDeps({ connectPod: () => Promise.resolve(conns[i++]) }));

    await fleet.connect(); // pod-a
    await fleet.connect(); // pod-b

    b.emitLive(live(999));
    expect(pod(fleet, 'pod-a')!.live).toBeNull(); // pod-a never emitted
    expect(pod(fleet, 'pod-b')!.live).toEqual(live(999));
    a.emitLive(live(500));
    expect(pod(fleet, 'pod-a')!.live).toEqual(live(500));
  });
});

describe('Fleet — disconnect', () => {
  it('drops the connection but keeps the Pod History and its place in pods', async () => {
    const conn = new FakeConnection('pod-x', [rec(900, 700)]);
    const fleet = new Fleet(makeDeps({ connectPod: () => Promise.resolve(conn) }));
    await fleet.connect();
    expect(pod(fleet, 'pod-x')!.connected).toBe(true);

    const change = counter();
    fleet.onChange = change.fire;

    conn.drop();

    expect(pod(fleet, 'pod-x')!.connected).toBe(false);
    expect(pod(fleet, 'pod-x')!.history.samples().map((s) => s.co2)).toEqual([700]);
    expect(change.count).toBe(1);
  });

  it('re-links a dropped Pod from a fresh connection without duplicating pods', async () => {
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
    expect(pod(fleet, 'pod-x')!.connected).toBe(false);

    const again = new FakeConnection('pod-x', [rec(900, 700)]);
    await deliver(again);

    expect(fleet.pods.map((p) => p.id)).toEqual(['pod-x']);
    expect(pod(fleet, 'pod-x')!.connected).toBe(true);
    expect(again.syncCalls).toBe(1);
  });
});

describe('Fleet — reconnect loop', () => {
  it('adds each Pod as it comes up and background-Syncs it', async () => {
    let deliver!: (conn: PodConnectionLike) => void;
    const fleet = new Fleet(
      makeDeps({ reconnectPods: (onReconnect) => (deliver = onReconnect) }),
    );

    expect(fleet.pods).toEqual([]);

    const first = new FakeConnection('pod-1', [rec(900, 600)]);
    const second = new FakeConnection('pod-2', [rec(900, 700)]);

    await deliver(first);
    expect(fleet.pods.map((p) => p.id)).toEqual(['pod-1']);

    await deliver(second);
    expect(fleet.pods.map((p) => p.id)).toEqual(['pod-1', 'pod-2']);
    expect(first.syncCalls).toBe(1);
    expect(second.syncCalls).toBe(1);
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

    expect(pod(fleet, 'pod-a')!.history.samples().map((s) => s.co2)).toEqual([600]);
    expect(pod(fleet, 'pod-b')!.history.samples().map((s) => s.co2)).toEqual([700]);
  });
});

describe('Fleet — per-Pod syncing', () => {
  it('toggles that Pod syncing around a sync and fires onChange on both edges', async () => {
    let resolveSync!: () => void;
    const conn = new FakeConnection('pod-x');
    conn.sync = () => {
      conn.syncCalls++;
      return new Promise<void>((r) => (resolveSync = () => r()));
    };
    const fleet = new Fleet(makeDeps({ connectPod: () => Promise.resolve(conn) }));

    const change = counter();
    fleet.onChange = change.fire;

    const pending = fleet.connect();
    await Promise.resolve(); // let connectPod resolve and the sync begin
    await Promise.resolve();
    expect(pod(fleet, 'pod-x')!.syncing).toBe(true); // sync in flight
    const before = change.count;

    resolveSync();
    await pending;

    expect(pod(fleet, 'pod-x')!.syncing).toBe(false);
    expect(change.count).toBeGreaterThan(before); // a transition off fired a change
  });
});

describe('Fleet — auto-sync', () => {
  it('syncs every connected Pod on a tick and fires onHistoryChange per Merge with the id', async () => {
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

    const merged: string[] = [];
    fleet.onHistoryChange = (id) => merged.push(id);

    clock.tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(a.syncCalls).toBe(2);
    expect(b.syncCalls).toBe(2);
    expect(merged.sort()).toEqual(['pod-a', 'pod-b']); // one Merge per connected Pod
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
    expect(pod(fleet, 'pod-x')!.syncing).toBe(true);

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

    const change = counter();
    fleet.onHistoryChange = counter().fire;
    fleet.onChange = change.fire;

    conn.syncError = new Error('background boom');
    clock.tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(fleet.busy).toBe(false);
    expect(fleet.error).toBeNull(); // background failure is swallowed
    expect(pod(fleet, 'pod-x')!.syncing).toBe(false); // cleared even though the sync threw

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
    expect(pod(fleet, 'pod-1')!.connected).toBe(true); // still registered despite the failed sync
  });
});

describe('Fleet — remove', () => {
  it('stops supervision, deletes History and name, drops all state, and fires onChange', async () => {
    let deliver!: (conn: PodConnectionLike, forget: () => Promise<void>) => void;
    const deleted: string[] = [];
    const names = new Names({ store: new FakeStore() });
    names.setName('pod-a', 'Living room');
    const fleet = new Fleet(
      makeDeps({
        reconnectPods: (onReconnect) =>
          (deliver = onReconnect as (c: PodConnectionLike, f: () => Promise<void>) => void),
        deleteHistory: (id) => deleted.push(id),
        names,
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

    const change = counter();
    fleet.onChange = change.fire;

    await fleet.remove('pod-a');

    expect(forgot).toBe(true); // supervision stopped + grant revoked via injected forget
    expect(deleted).toEqual(['pod-a']); // persisted History wiped
    expect(names.hasName('pod-a')).toBe(false); // name cleared in the same call
    expect(fleet.pods.map((p) => p.id)).toEqual(['pod-b']);
    expect(change.count).toBeGreaterThan(0);
  });

  it('drops the Pod from pods before the forget handle resolves (nothing lingers on the hero)', async () => {
    // The forget handle is a real BLE round-trip; the UI must not keep showing
    // the vanishing Pod (via the shell's pods[0] fallback) while it is in flight.
    let deliver!: (conn: PodConnectionLike, forget: () => Promise<void>) => void;
    const fleet = new Fleet(
      makeDeps({
        reconnectPods: (onReconnect) =>
          (deliver = onReconnect as (c: PodConnectionLike, f: () => Promise<void>) => void),
      }),
    );

    let resolveForget!: () => void;
    const conn = new FakeConnection('pod-only');
    await deliver(conn, () => new Promise<void>((r) => (resolveForget = r)));
    expect(fleet.pods.map((p) => p.id)).toEqual(['pod-only']);

    const change = counter();
    fleet.onChange = change.fire;

    const removal = fleet.remove('pod-only');
    expect(fleet.pods).toEqual([]); // gone synchronously, before the revoke settles
    expect(change.count).toBeGreaterThan(0);

    resolveForget();
    await removal;
    expect(fleet.pods).toEqual([]);
  });

  it('disconnects a Pod with no supervision handle and empties pods when it was the only one', async () => {
    const deleted: string[] = [];
    const conn = new FakeConnection('pod-only');
    const fleet = new Fleet(
      makeDeps({
        connectPod: () => Promise.resolve(conn),
        deleteHistory: (id) => deleted.push(id),
      }),
    );
    await fleet.connect();

    await fleet.remove('pod-only');

    expect(conn.disconnectCalls).toBe(1);
    expect(deleted).toEqual(['pod-only']);
    expect(fleet.pods).toEqual([]);
  });
});
