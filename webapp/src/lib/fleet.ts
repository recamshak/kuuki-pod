/*
 * The Fleet (ticket 11a): the webapp's model of the multi-Pod world — the set of
 * Pods it currently knows about (connected or merely persisted), keyed by Pod ID,
 * together with which one is selected. Lifted out of App.svelte so the genuinely
 * tricky logic — selection rules, Live-reading fan-in, disconnect handling,
 * persistence load, and the connect/Sync/reconnect orchestration — becomes a pure,
 * tested seam instead of untestable logic welded to Svelte runes (ADR-0004).
 *
 * Fleet reaches nothing ambient: no Web Bluetooth, no localStorage, no DOM. Every
 * dependency arrives through the injected `FleetDeps`; the real transport/history
 * functions satisfy it in production, hand-rolled fakes drive it in the node tests.
 * It owns the two per-Pod maps (History and connection, both keyed by Pod ID) and the
 * single shared busy/error state, and emits exactly two change signals so a caller
 * can react without reaching into internals:
 *   - `onHistoryChange` fires only when a Merge completes (right after `conn.sync()`
 *     resolves — the one place every Merge path passes through), so the chart is the
 *     only thing that recomputes and a Live reading never resets uPlot's zoom.
 *   - `onStateChange` fires on selection, connection, Live-reading, busy and error
 *     changes.
 */

import type { History } from './history';
import type { LiveReading } from './wire';

/**
 * The structural slice of a Pod connection Fleet drives — `podId`, `history`, the
 * Live-reading surface, and the `sync()`/`disconnect()` lifecycle. The concrete
 * `PodConnection` (transport.ts) satisfies it structurally; tests supply a fake.
 * Fleet deliberately does not depend on the concrete class (whose constructor is
 * private) so the whole lifecycle can be driven without Web Bluetooth.
 */
export interface PodConnectionLike {
  /** Stable per-Pod key; this Pod's History is stored under it. */
  readonly podId: string;
  /** This Pod's long-lived History; `sync()` Merges into it. */
  readonly history: History;
  /** The most recent Live reading, or null before the Pod's first Measurement. */
  liveReading: LiveReading | null;
  /** Called on every Live reading notification (and once with the initial read). */
  onLiveReading?: (reading: LiveReading | null) => void;
  /** Called when the link drops. */
  onDisconnected?: () => void;
  /** Run one full Sync and Merge into `history`. */
  sync(): Promise<void>;
  /** Tear down the link. */
  disconnect(): void;
}

/**
 * Everything Fleet needs from the outside world, injected as a flat object so the
 * module imports neither transport nor localStorage nor navigator.bluetooth.
 * Production passes the real `connectPod`/`reconnectPods`/`listPodIds` and a
 * `new History(id)` factory; tests pass fakes.
 */
export interface FleetDeps {
  /** Connect to a Pod on demand. Called synchronously by `connect()` (Web Bluetooth gesture). */
  connectPod: () => Promise<PodConnectionLike>;
  /** Re-link, with no user gesture, every previously-paired Pod, one callback per Pod. */
  reconnectPods: (onReconnect: (conn: PodConnectionLike) => void) => void;
  /** The Pod IDs that already have persisted History (for reload with no connection). */
  listPodIds: () => string[];
  /** Build the History for a persisted-but-not-yet-connected Pod. */
  makeHistory: (podId: string) => History;
}

/**
 * The set of Pods the webapp currently knows about, keyed by Pod ID, plus which
 * one is selected. Read through the getters; drive through `select`/`connect`/`sync`.
 */
export class Fleet {
  // Per-Pod maps keyed by Pod ID. A Pod can have a History without a connection
  // (persisted-but-not-in-range); a connected Pod brings its own `conn.history`.
  private readonly histories = new Map<string, History>();
  private readonly connections = new Map<string, PodConnectionLike>();
  private readonly liveByPod = new Map<string, LiveReading | null>();

  private _knownPodIds: string[] = [];
  private _selectedPodId: string | null = null;
  private _busy = false;
  private _error: string | null = null;

  /** Fired only when a Merge completes (after `conn.sync()` resolves). */
  onHistoryChange?: () => void;
  /** Fired on selection, connection, Live-reading, busy and error changes. */
  onStateChange?: () => void;

  constructor(private readonly deps: FleetDeps) {
    // Load persisted Pods up front so a reload shows the chart with no connection,
    // and auto-select when there is exactly one room to look at.
    const persistedIds = deps.listPodIds();
    for (const id of persistedIds) this.histories.set(id, deps.makeHistory(id));
    this._knownPodIds = persistedIds;
    if (persistedIds.length === 1) this._selectedPodId = persistedIds[0];

    // Then, without a click, re-link any previously-paired Pod still in range; each
    // arrives via the callback as it comes up and is Merged like a manual connect.
    deps.reconnectPods((conn) =>
      this.runBusy(async () => {
        this.register(conn);
        await conn.sync();
        this.onHistoryChange?.();
      }),
    );
  }

  /** The Pod IDs the webapp knows about (connected or merely persisted). */
  get knownPodIds(): string[] {
    return this._knownPodIds;
  }

  /** The selected Pod's ID, or null when none is selected. */
  get selectedPodId(): string | null {
    return this._selectedPodId;
  }

  /** The selected Pod's History, or undefined when none is selected. */
  get selectedHistory(): History | undefined {
    return this._selectedPodId ? this.histories.get(this._selectedPodId) : undefined;
  }

  /** The selected Pod's most recent Live reading, or null. */
  get live(): LiveReading | null {
    return this._selectedPodId ? (this.liveByPod.get(this._selectedPodId) ?? null) : null;
  }

  /** Whether the selected Pod currently has a live connection. */
  get connected(): boolean {
    return this._selectedPodId ? this.connections.has(this._selectedPodId) : false;
  }

  /** Whether a connect/Sync is in flight (single shared flag across all Pods). */
  get busy(): boolean {
    return this._busy;
  }

  /** The last error message, or null. Cleared at the start of each action. */
  get error(): string | null {
    return this._error;
  }

  /** Focus a known Pod. A no-op (no signal) when it is already selected. */
  select(id: string): void {
    if (id === this._selectedPodId) return;
    this._selectedPodId = id;
    this.onStateChange?.();
  }

  /**
   * Connect to a Pod the user explicitly picks: prompt (via the injected
   * `connectPod`, called synchronously so the Web Bluetooth gesture holds), focus
   * the picked Pod, Sync it, and fire `onHistoryChange`. A cancelled device chooser
   * (`NotFoundError`) is a quiet no-op, not an error.
   */
  connect(): Promise<void> {
    return this.runBusy(async () => {
      let conn: PodConnectionLike;
      try {
        conn = await this.deps.connectPod();
      } catch (e) {
        // A cancelled device chooser is a normal no-op, not an error to surface.
        if (e instanceof DOMException && e.name === 'NotFoundError') return;
        throw e;
      }
      // Manual Connect is an explicit choice: focus the Pod the user just picked.
      this._selectedPodId = this.register(conn);
      await conn.sync();
      this.onHistoryChange?.();
    });
  }

  /** Sync the selected Pod (a no-op when it has no live connection) and fire `onHistoryChange`. */
  sync(): Promise<void> {
    const conn = this._selectedPodId ? this.connections.get(this._selectedPodId) : undefined;
    if (!conn) return Promise.resolve();
    return this.runBusy(async () => {
      await conn.sync();
      this.onHistoryChange?.();
    });
  }

  /** Run an async action under the shared busy flag with error surfacing. */
  private async runBusy(action: () => Promise<void>): Promise<void> {
    this._error = null;
    this._busy = true;
    this.onStateChange?.();
    try {
      await action();
    } catch (e) {
      this._error = e instanceof Error ? e.message : String(e);
    } finally {
      this._busy = false;
      this.onStateChange?.();
    }
  }

  /**
   * Register a fresh connection under its Pod ID: expose its History, seed and
   * subscribe its Live reading, drop the connection on disconnect (keeping the
   * History), and auto-select it when nothing is selected yet. Shared by manual
   * Connect and reload-reconnect. Returns the Pod ID.
   */
  private register(conn: PodConnectionLike): string {
    const id = conn.podId;
    this.connections.set(id, conn);
    this.histories.set(id, conn.history);
    if (!this._knownPodIds.includes(id)) this._knownPodIds = [...this._knownPodIds, id];
    if (this._selectedPodId === null) this._selectedPodId = id;
    this.liveByPod.set(id, conn.liveReading);
    conn.onLiveReading = (r) => {
      this.liveByPod.set(id, r);
      this.onStateChange?.();
    };
    conn.onDisconnected = () => {
      // Drop the connection but keep the Pod's History and its place in the known
      // set; walking out of range never costs accumulated data.
      this.connections.delete(id);
      this.onStateChange?.();
    };
    return id;
  }
}
