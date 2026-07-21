/*
 * The Fleet (tickets 11a, 12d): the webapp's model of the multi-Pod world — the set
 * of Pods it currently knows about (connected or merely persisted), keyed by Pod ID,
 * together with which one is selected. Lifted out of App.svelte so the genuinely
 * tricky logic — selection rules, Live-reading fan-in, disconnect handling,
 * persistence load, background auto-sync, and the connect/Sync/reconnect
 * orchestration — becomes a pure, tested seam instead of untestable logic welded to
 * Svelte runes (ADR-0004).
 *
 * Fleet reaches nothing ambient: no Web Bluetooth, no localStorage, no DOM, no
 * timers. Every dependency arrives through the injected `FleetDeps`; the real
 * transport/history functions satisfy it in production, hand-rolled fakes drive it in
 * the node tests. It owns the per-Pod maps (History, connection, Live reading and
 * per-Pod `syncing`, all keyed by Pod ID) and the single shared user-`busy`/error
 * state, and emits change signals so a caller can react without reaching into
 * internals:
 *   - `onHistoryChange` fires only when a Merge completes (right after `conn.sync()`
 *     resolves — the one place every Merge path passes through), so the chart is the
 *     only thing that recomputes and a Live reading never resets uPlot's zoom.
 *   - `onStateChange` fires on selection, connection, Live-reading, busy, error and
 *     per-Pod `syncing` changes.
 *   - `onNewPod` fires once the first time a Pod not persisted at startup registers,
 *     so the component can prompt for a name.
 *
 * Two kinds of Sync coexist. A user-initiated `connect()`/`sync()` runs under the
 * shared `busy` flag and surfaces real errors. The 60 s auto-sync loop and the
 * on-reconnect Sync are *background* Syncs: they toggle per-Pod `syncing` and fire
 * `onHistoryChange`, but never touch `busy` and never surface an error (a failed
 * background Sync self-heals on the next tick / reconnect).
 */

import type { History, KeyValueStore } from './history';
import type { LiveReading } from './wire';

/** How often the background auto-sync loop Syncs every connected Pod. */
const AUTO_SYNC_MS = 60_000;

/** Where the selected Pod ID is persisted, so a reload restores the focused room. */
const SELECTION_KEY = 'kuuki:selected';

/**
 * Stop supervising one Pod and revoke its Web Bluetooth grant (ticket 12c). Handed
 * to Fleet per-Pod alongside each reconnected connection and retained keyed by Pod
 * ID, so `remove()` can permanently unlink a device even while it is only being
 * scanned for. Defined here (not imported) so Fleet stays transport-free.
 */
export type ForgetHandle = () => Promise<void>;

/** One entry of the per-Pod picker view: a known Pod plus its live/syncing status. */
export interface PodView {
  /** Stable per-Pod key (the component resolves its name from names.ts). */
  id: string;
  /** Whether the Pod currently has a live connection. */
  connected: boolean;
  /** Whether the Pod has a Sync in flight. */
  syncing: boolean;
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
 * Production passes the real `connectPod`/`reconnectPods`/`listPodIds` and a
 * `new History(id)` factory; tests pass fakes.
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
  /** Persists the selected Pod ID across reloads (the `localStorage` slice from history.ts). */
  selectionStore: KeyValueStore;
  /** Wipe a forgotten Pod's persisted History (ticket 12b), called from `remove()`. */
  deleteHistory: (podId: string) => void;
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
  // Pods with a Sync in flight — the hero indicator and the auto-sync overlap guard.
  private readonly syncingPods = new Set<string>();
  // Per-Pod supervision/forget handles delivered by reconnect, retained for remove().
  private readonly forgetByPod = new Map<string, ForgetHandle>();

  private _knownPodIds: string[] = [];
  private _selectedPodId: string | null = null;
  private _busy = false;
  private _error: string | null = null;

  // The Pod IDs already persisted when Fleet was built, so `onNewPod` can tell a
  // genuinely new Pod from a known one reconnecting; and which new Pods it has fired
  // for, so it fires exactly once each across drops/reconnects.
  private readonly persistedAtStartup: ReadonlySet<string>;
  private readonly firedNewPod = new Set<string>();
  // The last persisted / current selection target: a restored choice that is not yet
  // known holds focus so a reconnecting other Pod cannot steal it.
  private restoredSelection: string | null;

  /** Fired only when a Merge completes (after `conn.sync()` resolves). */
  onHistoryChange?: () => void;
  /** Fired on selection, connection, Live-reading, busy, error and per-Pod syncing changes. */
  onStateChange?: () => void;
  /** Fired once the first time a Pod not persisted at startup registers (for naming). */
  onNewPod?: (podId: string) => void;

  constructor(private readonly deps: FleetDeps) {
    // Load persisted Pods up front so a reload shows the chart with no connection.
    const persistedIds = deps.listPodIds();
    for (const id of persistedIds) this.histories.set(id, deps.makeHistory(id));
    this._knownPodIds = persistedIds;
    this.persistedAtStartup = new Set(persistedIds);

    // Restore the persisted selection even if that Pod is disconnected (its History
    // still shows). A restored choice wins over the legacy "auto-select the sole
    // persisted Pod" rule; if it names an unknown Pod, hold it as the target so a
    // reconnecting other Pod cannot steal focus, else fall back to the sole Pod.
    const restored = deps.selectionStore.getItem(SELECTION_KEY);
    this.restoredSelection = restored;
    if (restored && this.histories.has(restored)) this._selectedPodId = restored;
    else if (persistedIds.length === 1) this._selectedPodId = persistedIds[0];

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

  /**
   * A per-Pod view over every known Pod (connected or merely persisted), for the
   * picker: each entry's `connected` and `syncing` drive its disc/indicator. Name is
   * resolved by the component (names.ts); Fleet stays name-agnostic.
   */
  get pods(): PodView[] {
    return this._knownPodIds.map((id) => ({
      id,
      connected: this.connections.has(id),
      syncing: this.syncingPods.has(id),
    }));
  }

  /** Whether the selected Pod has a Sync in flight (drives the hero sync indicator). */
  get syncing(): boolean {
    return this._selectedPodId ? this.syncingPods.has(this._selectedPodId) : false;
  }

  /** Whether a connect/Sync is in flight (single shared flag across all Pods). */
  get busy(): boolean {
    return this._busy;
  }

  /** The last error message, or null. Cleared at the start of each action. */
  get error(): string | null {
    return this._error;
  }

  /** Focus a known Pod, persisting the choice. A no-op (no signal) when already selected. */
  select(id: string): void {
    if (id === this._selectedPodId) return;
    this.setSelected(id);
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
      this.register(conn);
      this.setSelected(conn.podId);
      await this.runSync(conn);
    });
  }

  /** Sync the selected Pod (a no-op when it has no live connection) and fire `onHistoryChange`. */
  sync(): Promise<void> {
    const conn = this._selectedPodId ? this.connections.get(this._selectedPodId) : undefined;
    if (!conn) return Promise.resolve();
    return this.runBusy(() => this.runSync(conn));
  }

  /**
   * Forget a Pod for good (ticket 12d): stop supervising it and revoke its Web
   * Bluetooth grant (via the retained `forget` handle from 12c, or a plain
   * `disconnect()` for a manually-connected Pod with no supervision), drop it from
   * every per-Pod map, wipe its persisted History (12b), and re-select another known
   * Pod (or none) if it was the focused one. Fleet does not touch the Pod's *name* —
   * that is the component's job (names.ts is not a Fleet dependency).
   */
  async remove(podId: string): Promise<void> {
    const forget = this.forgetByPod.get(podId);
    if (forget) {
      // Aborts supervision (stops scanning/reconnecting) and drops the GATT link.
      try {
        await forget();
      } catch {
        // Best effort: a failed revoke must not strand the Pod in the UI.
      }
    } else {
      this.connections.get(podId)?.disconnect();
    }

    this.connections.delete(podId);
    this.histories.delete(podId);
    this.liveByPod.delete(podId);
    this.syncingPods.delete(podId);
    this.forgetByPod.delete(podId);
    this._knownPodIds = this._knownPodIds.filter((id) => id !== podId);
    this.deps.deleteHistory(podId);

    const wasSelected = this._selectedPodId === podId;
    if (wasSelected) this.setSelected(this._knownPodIds[0] ?? null);
    this.onStateChange?.();
    if (wasSelected) this.onHistoryChange?.(); // the selected chart changed
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
   * One Sync of a specific connection: toggle its per-Pod `syncing` around the call
   * (firing `onStateChange` on both edges) and fire `onHistoryChange` on the Merge.
   * Shared by the user paths (wrapped in `runBusy`) and the background paths (wrapped
   * in `backgroundSync`); a throw propagates to the caller, which decides how to
   * handle it.
   */
  private async runSync(conn: PodConnectionLike): Promise<void> {
    const id = conn.podId;
    this.syncingPods.add(id);
    this.onStateChange?.();
    try {
      await conn.sync();
      this.onHistoryChange?.();
    } finally {
      this.syncingPods.delete(id);
      this.onStateChange?.();
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

  /** Set (and persist) the current selection target; `null` clears the stored choice. */
  private setSelected(id: string | null): void {
    this._selectedPodId = id;
    this.restoredSelection = id;
    if (id === null) this.deps.selectionStore.removeItem(SELECTION_KEY);
    else this.deps.selectionStore.setItem(SELECTION_KEY, id);
  }

  /**
   * Register a fresh connection under its Pod ID: expose its History, seed and
   * subscribe its Live reading, drop the connection on disconnect (keeping the
   * History), auto-select it when nothing is selected yet (without stealing a
   * restored selection target), and fire `onNewPod` once for a genuinely new Pod.
   * Shared by manual Connect and reload-reconnect. Returns the Pod ID.
   */
  private register(conn: PodConnectionLike): string {
    const id = conn.podId;
    const firstRegistration = !this._knownPodIds.includes(id);
    this.connections.set(id, conn);
    this.histories.set(id, conn.history);
    if (firstRegistration) this._knownPodIds = [...this._knownPodIds, id];
    // Auto-select only when nothing is chosen and no restored target is still waiting
    // for a different Pod to come up — a reconnect must not steal a restored choice.
    if (this._selectedPodId === null && (this.restoredSelection === null || this.restoredSelection === id)) {
      this.setSelected(id);
    }
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
    // A Pod absent from the startup persisted set is genuinely new: fire once so the
    // component can prompt for a name. A persisted Pod reconnecting never fires.
    if (!this.persistedAtStartup.has(id) && !this.firedNewPod.has(id)) {
      this.firedNewPod.add(id);
      this.onNewPod?.(id);
    }
    return id;
  }
}
