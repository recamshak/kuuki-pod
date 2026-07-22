/*
 * The Fleet (tickets 11a, 12d, 13a): a passive, reactive collection of rich Pod
 * objects — the set of Pods the webapp currently knows about (connected or merely
 * persisted), keyed by Pod ID. Lifted out of App.svelte so the genuinely tricky
 * logic — Live-reading fan-in, disconnect handling, persistence load, background
 * auto-sync, and the connect/Sync/reconnect orchestration — is a pure, tested seam
 * instead of untestable logic welded to Svelte runes (ADR-0004).
 *
 * `pods` returns everything the shell needs attached to one object per Pod:
 * `{ id, name, connected, syncing, live, history }`. Fleet composes the injected
 * `Names` (names.ts) to resolve each `pod.name` and to make `remove()` a one-call
 * forget (grant + History + name); it knows nothing about which Pod is "selected" —
 * selection is the shell's trivial state (ticket 13).
 *
 * Fleet reaches nothing ambient: no Web Bluetooth, no localStorage, no DOM, no
 * timers. Every dependency arrives through the injected `FleetDeps`; the real
 * transport/history functions satisfy it in production, hand-rolled fakes drive it
 * in the node tests. It owns the per-Pod maps (History, connection, Live reading and
 * per-Pod `syncing`, all keyed by Pod ID) and the single shared user-`busy`/error
 * state, and emits two fleet-level change signals:
 *   - `onHistoryChange(podId)` fires only when a Merge completes (right after
 *     `conn.sync()` resolves — the one place every Merge path passes through) and
 *     carries the merged Pod's id, so the shell rebuilds the chart only for the
 *     displayed Pod and a hidden Pod's background Merge never resets uPlot's zoom.
 *   - `onChange()` fires on membership, connection, Live-reading, name, busy, error
 *     and per-Pod `syncing` changes.
 *
 * Two kinds of Sync coexist. A user-initiated `connect()`/`sync(podId)` runs under
 * the shared `busy` flag and surfaces real errors. The 60 s auto-sync loop and the
 * on-reconnect Sync are *background* Syncs: they toggle per-Pod `syncing` and fire
 * `onHistoryChange`, but never touch `busy` and never surface an error (a failed
 * background Sync self-heals on the next tick / reconnect).
 */

import type { History } from './history';
import type { Names } from './names';
import type { LiveReading } from './wire';

/** How often the background auto-sync loop Syncs every connected Pod. */
const AUTO_SYNC_MS = 60_000;

/**
 * Stop supervising one Pod and revoke its Web Bluetooth grant (ticket 12c). Handed
 * to Fleet per-Pod alongside each reconnected connection and retained keyed by Pod
 * ID, so `remove()` can permanently unlink a device even while it is only being
 * scanned for. Defined here (not imported) so Fleet stays transport-free.
 */
export type ForgetHandle = () => Promise<void>;

/** The rich view of one known Pod: everything the shell reads, on one object. */
export interface PodView {
  /** Stable per-Pod key. */
  id: string;
  /** The user's label, or the short-hex fallback (resolved via the composed Names). */
  name: string;
  /** Whether the Pod currently has a live connection. */
  connected: boolean;
  /** Whether the Pod has a Sync in flight. */
  syncing: boolean;
  /** The most recent Live reading, or null before the Pod's first Measurement. */
  live: LiveReading | null;
  /** The Pod's long-lived History (present even while disconnected). */
  history: History;
}

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
 * Production passes the real `connectPod`/`reconnectPods`/`listPodIds`, a
 * `new History(id)` factory, and a `new Names({ store: localStorage })`; tests
 * pass fakes.
 */
export interface FleetDeps {
  /** Connect to a Pod on demand. Called synchronously by `connect()` (Web Bluetooth gesture). */
  connectPod: () => Promise<PodConnectionLike>;
  /**
   * Re-link, with no user gesture, every previously-paired Pod — one callback per
   * Pod on load and again after every drop, each carrying a stable per-Pod `forget`
   * handle (ticket 12c) Fleet retains for `remove()`.
   */
  reconnectPods: (onReconnect: (conn: PodConnectionLike, forget?: ForgetHandle) => void) => void;
  /** The Pod IDs that already have persisted History (for reload with no connection). */
  listPodIds: () => string[];
  /** Build the History for a persisted-but-not-yet-connected Pod. */
  makeHistory: (podId: string) => History;
  /**
   * Run `cb` every `everyMs`, returning a cancel. Injected (not `setInterval`) so
   * Fleet imports no timers and tests drive the auto-sync loop with a fake clock.
   */
  schedule: (cb: () => void, everyMs: number) => () => void;
  /** Per-Pod labels (names.ts); Fleet resolves `pod.name` and clears it on `remove()`. */
  names: Names;
  /** Wipe a forgotten Pod's persisted History (ticket 12b), called from `remove()`. */
  deleteHistory: (podId: string) => void;
}

/**
 * The set of Pods the webapp currently knows about, keyed by Pod ID. Read through
 * `pods`; drive through `connect`/`sync`/`rename`/`remove`; react via the two
 * change signals.
 */
export class Fleet {
  // Per-Pod maps keyed by Pod ID. A Pod can have a History without a connection
  // (persisted-but-not-in-range); a connected Pod brings its own `conn.history`.
  private readonly histories = new Map<string, History>();
  private readonly connections = new Map<string, PodConnectionLike>();
  private readonly liveByPod = new Map<string, LiveReading | null>();
  // Pods with a Sync in flight — the hero indicator and the auto-sync overlap guard.
  private readonly syncingPods = new Set<string>();
  // Per-Pod supervision/forget handles delivered by reconnect, retained for remove().
  private readonly forgetByPod = new Map<string, ForgetHandle>();

  private _knownPodIds: string[] = [];
  private _busy = false;
  private _error: string | null = null;

  /** Fired when a Merge completes (after `conn.sync()` resolves), with the merged Pod's id. */
  onHistoryChange?: (podId: string) => void;
  /** Fired on membership, connection, Live-reading, name, busy, error and syncing changes. */
  onChange?: () => void;

  constructor(private readonly deps: FleetDeps) {
    // Load persisted Pods up front so a reload shows the chart with no connection.
    const persistedIds = deps.listPodIds();
    for (const id of persistedIds) this.histories.set(id, deps.makeHistory(id));
    this._knownPodIds = persistedIds;

    // Then, without a click, re-link any previously-paired Pod still in range; each
    // arrives via the callback as it comes up and is background-Synced (no busy, no
    // surfaced error), retaining its `forget` handle for `remove()`.
    deps.reconnectPods((conn, forget) => {
      if (forget) this.forgetByPod.set(conn.podId, forget);
      this.register(conn);
      return this.backgroundSync(conn);
    });

    // Keep every connected Pod fresh on a fixed cadence, silently, in the background.
    // The loop lives for the page's lifetime; there is nothing to tear down.
    deps.schedule(() => this.autoSyncTick(), AUTO_SYNC_MS);
  }

  /**
   * The rich view over every known Pod (connected or merely persisted), in the
   * order Pods became known. The shell reads everything off one entry.
   */
  get pods(): PodView[] {
    return this._knownPodIds.map((id) => ({
      id,
      name: this.deps.names.getName(id),
      connected: this.connections.has(id),
      syncing: this.syncingPods.has(id),
      live: this.liveByPod.get(id) ?? null,
      history: this.histories.get(id)!,
    }));
  }

  /** Whether a connect/Sync is in flight (single shared flag across all Pods). */
  get busy(): boolean {
    return this._busy;
  }

  /** The last error message, or null. Cleared at the start of each action. */
  get error(): string | null {
    return this._error;
  }

  /** Whether the Pod has a stored label (lets the shell decide whether to prompt). */
  hasName(podId: string): boolean {
    return this.deps.names.hasName(podId);
  }

  /** Persist a Pod's label (blank clears it, per names.ts) and signal the change. */
  rename(podId: string, name: string): void {
    this.deps.names.setName(podId, name);
    this.onChange?.();
  }

  /**
   * Connect to a Pod the user explicitly picks: prompt (via the injected
   * `connectPod`, called synchronously so the Web Bluetooth gesture holds),
   * register it, Sync it, and resolve to its Pod ID so the shell can select it.
   * Resolves to null when the device chooser was cancelled (`NotFoundError` — a
   * quiet no-op, not an error) or the connect failed (surfaced on `error`).
   */
  async connect(): Promise<string | null> {
    let id: string | null = null;
    await this.runBusy(async () => {
      let conn: PodConnectionLike;
      try {
        conn = await this.deps.connectPod();
      } catch (e) {
        // A cancelled device chooser is a normal no-op, not an error to surface.
        if (e instanceof DOMException && e.name === 'NotFoundError') return;
        throw e;
      }
      this.register(conn);
      // The Pod is registered even if its first Sync then fails: resolve to its id.
      id = conn.podId;
      await this.runSync(conn);
    });
    return id;
  }

  /** Sync one Pod (a no-op when it has no live connection) and fire `onHistoryChange`. */
  sync(podId: string): Promise<void> {
    const conn = this.connections.get(podId);
    if (!conn) return Promise.resolve();
    return this.runBusy(() => this.runSync(conn));
  }

  /**
   * Forget a Pod for good (tickets 12d, 13a) in one call: stop supervising it and
   * revoke its Web Bluetooth grant (via the retained `forget` handle from 12c, or a
   * plain `disconnect()` for a manually-connected Pod with no supervision), drop it
   * from every per-Pod map, wipe its persisted History (12b) and its name.
   */
  async remove(podId: string): Promise<void> {
    const conn = this.connections.get(podId);
    const forget = this.forgetByPod.get(podId);

    // Drop the Pod from every map and signal *before* revoking the grant: the
    // revoke is a real BLE round-trip, and the UI must not keep showing the
    // vanishing Pod while it is in flight. Unsubscribe the connection first so a
    // late Live reading / drop from it cannot resurrect state or fire signals.
    if (conn) {
      conn.onLiveReading = undefined;
      conn.onDisconnected = undefined;
    }
    this.connections.delete(podId);
    this.histories.delete(podId);
    this.liveByPod.delete(podId);
    this.syncingPods.delete(podId);
    this.forgetByPod.delete(podId);
    this._knownPodIds = this._knownPodIds.filter((id) => id !== podId);
    this.deps.deleteHistory(podId);
    this.deps.names.forget(podId);
    this.onChange?.();

    if (forget) {
      // Aborts supervision (stops scanning/reconnecting) and drops the GATT link.
      try {
        await forget();
      } catch {
        // Best effort: a failed revoke changes nothing — the Pod is already gone
        // from the UI and its persisted state.
      }
    } else {
      conn?.disconnect();
    }
  }

  /** Run an async action under the shared busy flag with error surfacing. */
  private async runBusy(action: () => Promise<void>): Promise<void> {
    this._error = null;
    this._busy = true;
    this.onChange?.();
    try {
      await action();
    } catch (e) {
      this._error = e instanceof Error ? e.message : String(e);
    } finally {
      this._busy = false;
      this.onChange?.();
    }
  }

  /**
   * One Sync of a specific connection: toggle its per-Pod `syncing` around the call
   * (firing `onChange` on both edges) and fire `onHistoryChange` with its id on the
   * Merge. Shared by the user paths (wrapped in `runBusy`) and the background paths
   * (wrapped in `backgroundSync`); a throw propagates to the caller, which decides
   * how to handle it.
   */
  private async runSync(conn: PodConnectionLike): Promise<void> {
    const id = conn.podId;
    this.syncingPods.add(id);
    this.onChange?.();
    try {
      await conn.sync();
      this.onHistoryChange?.(id);
    } finally {
      this.syncingPods.delete(id);
      this.onChange?.();
    }
  }

  /** A background Sync: like `runSync`, but never touches busy and swallows errors. */
  private async backgroundSync(conn: PodConnectionLike): Promise<void> {
    try {
      await this.runSync(conn);
    } catch {
      // Background Syncs self-heal on the next tick / reconnect: no busy, no error.
    }
  }

  /** Background-sync every connected, not-already-syncing Pod. */
  private autoSyncTick(): void {
    for (const conn of this.connections.values()) {
      if (this.syncingPods.has(conn.podId)) continue; // no overlapping sync
      void this.backgroundSync(conn);
    }
  }

  /**
   * Register a fresh connection under its Pod ID: expose its History, seed and
   * subscribe its Live reading, and drop the connection on disconnect (keeping the
   * History). Shared by manual Connect and reload-reconnect.
   */
  private register(conn: PodConnectionLike): void {
    const id = conn.podId;
    this.connections.set(id, conn);
    this.histories.set(id, conn.history);
    if (!this._knownPodIds.includes(id)) this._knownPodIds = [...this._knownPodIds, id];
    this.liveByPod.set(id, conn.liveReading);
    conn.onLiveReading = (r) => {
      this.liveByPod.set(id, r);
      this.onChange?.();
    };
    conn.onDisconnected = () => {
      // Drop the connection but keep the Pod's History and its place in the known
      // set; walking out of range never costs accumulated data.
      this.connections.delete(id);
      this.onChange?.();
    };
    this.onChange?.();
  }
}
