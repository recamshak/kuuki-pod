/*
 * Web Bluetooth transport (ticket 09): the webapp's on-demand link to a Pod and
 * the glue that turns a live BLE connection into a Merge.
 *
 * This is the untestable seam by design (spec "Out of test scope": Web Bluetooth
 * transport is manual, on-device). It stays thin: every byte it reads or writes
 * goes through the pure, tested wire codec (./wire), and every Sample it lands
 * goes through the pure, tested Merge (applySync in ./history). What is left here
 * is orchestration — connect, identify, subscribe, run one Sync to end-of-batch —
 * which is verified against real firmware (tickets 06/07), not in unit tests.
 *
 * All UUIDs and framing come from docs/wire-contract.md and the firmware GATT
 * service; they are not redefined anywhere else.
 */

import { applySync, History, type HistoryOptions, type SyncRecord } from './history';
import {
  decodeLiveReading,
  decodeSyncRecords,
  encodeMark,
  formatPodId,
  type LiveReading,
  markFor,
} from './wire';

// The single custom service and its characteristics. The base spells "kuuki-pod"
// in ASCII; the trailing 16-bit field selects the characteristic (firmware ble.c).
const SERVICE_UUID = '4b75756b-692d-706f-6400-000000000001';
const POD_ID_UUID = '4b75756b-692d-706f-6400-000000000002';
const LIVE_UUID = '4b75756b-692d-706f-6400-000000000003';
const SYNC_CTRL_UUID = '4b75756b-692d-706f-6400-000000000004';
const SYNC_DATA_UUID = '4b75756b-692d-706f-6400-000000000005';

/** Options passed through to the per-Pod History (mainly the storage backend). */
export interface ConnectOptions {
  historyOptions?: HistoryOptions;
}

/**
 * A live connection to one Pod, keyed by its Pod ID and backed by that Pod's
 * History. The UI sets `onLiveReading` / `onDisconnected` and calls `sync()`;
 * the "right now" number arrives via Live reading notifications independent of
 * any Sync (docs/wire-contract.md).
 */
export class PodConnection {
  /** Stable per-Pod key (hex of the 16-byte Pod ID); History is stored under it. */
  readonly podId: string;
  /** This Pod's long-lived History; `sync()` Merges into it. */
  readonly history: History;

  /** The most recent Live reading, or null before the Pod's first Measurement. */
  liveReading: LiveReading | null = null;
  /** Called on every Live reading notification (and once with the initial read). */
  onLiveReading?: (reading: LiveReading | null) => void;
  /** Called when the link drops (a mid-Sync drop self-heals on the next Sync). */
  onDisconnected?: () => void;

  private readonly device: BluetoothDevice;
  private readonly live: BluetoothRemoteGATTCharacteristic;
  private readonly syncCtrl: BluetoothRemoteGATTCharacteristic;
  private readonly syncData: BluetoothRemoteGATTCharacteristic;

  /** Unblocks an in-flight `sync()` when the link drops, keeping the prefix. */
  private endSync?: () => void;

  private constructor(
    device: BluetoothDevice,
    podId: string,
    history: History,
    live: BluetoothRemoteGATTCharacteristic,
    syncCtrl: BluetoothRemoteGATTCharacteristic,
    syncData: BluetoothRemoteGATTCharacteristic,
  ) {
    this.device = device;
    this.podId = podId;
    this.history = history;
    this.live = live;
    this.syncCtrl = syncCtrl;
    this.syncData = syncData;

    device.addEventListener('gattserverdisconnected', () => {
      // Let a truncated Sync keep the contiguous oldest-first prefix it received;
      // the next Sync's advanced High-water mark re-fetches the lost tail (ADR-0002).
      this.endSync?.();
      this.onDisconnected?.();
    });
  }

  /**
   * Run one full Sync: latch a single `nowMs`, ask for everything newer than our
   * High-water mark, consume the notification stream to the end-of-batch marker,
   * and Merge the decoded records. Idempotent — re-Syncing is harmless (the Merge
   * dedups the boundary Sample). A mid-Sync drop lands the prefix and returns.
   */
  async sync(): Promise<void> {
    // The client-side mirror of the Pod's single latch: capture once, up front.
    const nowMs = Date.now();
    const mark = markFor(this.history.latest(), nowMs);

    const records: SyncRecord[] = [];
    const streamed = new Promise<void>((resolve, reject) => {
      const onData = (event: Event) => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        if (value.byteLength === 0) {
          // End-of-batch marker: the Sync is complete.
          finish();
          resolve();
          return;
        }
        try {
          for (const r of decodeSyncRecords(value)) records.push(r);
        } catch (err) {
          finish();
          reject(err);
        }
      };
      const finish = () => {
        this.endSync = undefined;
        this.syncData.removeEventListener('characteristicvaluechanged', onData);
      };
      // A dropped link resolves the stream too: keep the prefix, self-heal next time.
      this.endSync = () => {
        finish();
        resolve();
      };
      this.syncData.addEventListener('characteristicvaluechanged', onData);
    });

    // Enable notifications before triggering the stream, so no record is missed.
    await this.syncData.startNotifications();
    await this.syncCtrl.writeValueWithResponse(encodeMark(mark));
    await streamed;
    try {
      await this.syncData.stopNotifications();
    } catch {
      // The link may already be gone after a mid-Sync drop; nothing to unsubscribe.
    }

    applySync(this.history, records, nowMs);
  }

  /** Tear down the link (idempotent; the disconnect handler fires `onDisconnected`). */
  disconnect(): void {
    this.device.gatt?.disconnect();
  }

  /**
   * Connect to a Pod on demand: prompt for a device advertising the service,
   * connect GATT, read the Pod ID to key History, and subscribe the Live reading.
   *
   * MTU: Web Bluetooth has no MTU API — the platform negotiates the largest ATT
   * MTU automatically on GATT connect. The codec is deliberately MTU-agnostic
   * (records never split across notifications; a zero-length notification ends the
   * batch), so the transport transparently handles whatever MTU is negotiated.
   */
  static async connect(options: ConnectOptions = {}): Promise<PodConnection> {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
    });
    return PodConnection.fromDevice(device, options);
  }

  /**
   * Bring up the link to a device we already hold (from the chooser or from
   * getDevices() on reload): connect GATT, read the Pod ID to key History, and
   * subscribe the Live reading. Shared by the gesture-driven `connect()` and the
   * gesture-free `reconnectPods()`.
   */
  static async fromDevice(
    device: BluetoothDevice,
    options: ConnectOptions = {},
  ): Promise<PodConnection> {
    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);

    const [podIdChar, live, syncCtrl, syncData] = await Promise.all([
      service.getCharacteristic(POD_ID_UUID),
      service.getCharacteristic(LIVE_UUID),
      service.getCharacteristic(SYNC_CTRL_UUID),
      service.getCharacteristic(SYNC_DATA_UUID),
    ]);

    const podId = formatPodId(await podIdChar.readValue());
    const history = new History(podId, options.historyOptions);

    const conn = new PodConnection(device, podId, history, live, syncCtrl, syncData);
    await conn.subscribeLive();
    return conn;
  }

  /** Read the current Live reading and subscribe to its notifications. */
  private async subscribeLive(): Promise<void> {
    this.live.addEventListener('characteristicvaluechanged', (event) => {
      const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
      if (value) this.publishLive(value);
    });
    // Seed "right now" from a direct read so the UI shows a value immediately,
    // then let notifications refresh it on each new Measurement.
    this.publishLive(await this.live.readValue());
    await this.live.startNotifications();
  }

  private publishLive(value: DataView): void {
    this.liveReading = decodeLiveReading(value);
    this.onLiveReading?.(this.liveReading);
  }
}

/** Connect to a Pod on demand. Must be called from a user gesture (Web Bluetooth). */
export function connectPod(options?: ConnectOptions): Promise<PodConnection> {
  return PodConnection.connect(options);
}

/**
 * Stop supervising a Pod and revoke its Web Bluetooth grant. Delivered to the
 * caller alongside each reconnected `PodConnection` (keyed there by `podId`) so a
 * "forget Pod" flow can permanently unlink one device: it aborts the supervision
 * loop (so the Pod stops scanning/reconnecting at once) and calls `device.forget()`
 * where available, so the Pod is gone for this session and after the next reload.
 */
export type ForgetHandle = () => Promise<void>;

/**
 * Keep every Pod permitted in an earlier session linked, with no user gesture,
 * calling `onReconnect` with a fresh connection — and a per-Pod `forget` handle —
 * each time one comes up, on load and again after every drop. Web Bluetooth
 * remembers devices granted through `requestDevice()`; after a reload `getDevices()`
 * returns them.
 *
 * The `forget` handle is stable across a Pod's reconnects (it aborts that one
 * device's supervision loop), so a caller can retain it keyed by `podId` and later
 * stop supervising even while the Pod is disconnected and merely being scanned for.
 *
 * `getDevices()` is Chrome-only, so elsewhere this is a no-op and the app falls
 * back to the manual Connect button. A fresh connection re-delivered for a Pod the
 * caller already knows is safe: its History reloads the same persisted Samples from
 * localStorage (history.ts), so nothing accumulated is lost across a reconnect.
 */
export async function reconnectPods(
  onReconnect: (conn: PodConnection, forget: ForgetHandle) => void,
  options?: ConnectOptions,
): Promise<void> {
  const bluetooth = navigator.bluetooth;
  if (!bluetooth?.getDevices) return;

  const devices = await bluetooth.getDevices();
  for (const device of devices) superviseDevice(device, onReconnect, options);
}

/**
 * Keep one restored device linked for as long as the app runs (or until it is
 * forgotten). The loop only ever does one of two things: bring the link up when it
 * is down, or wait for it to drop.
 *
 * Bringing it up tries a direct `gatt.connect()` first (the fast path when the OS
 * still holds the link, e.g. a Pod that no longer advertises), and otherwise waits
 * for the Pod to advertise and connects then — so a Pod that is asleep or out of
 * range costs nothing until it reappears, and a failed connect simply waits for the
 * next advertisement rather than giving up. Scanning runs only while disconnected.
 *
 * A per-device `AbortController` is the stop switch: the `forget` handle handed to
 * `onReconnect` aborts it, which breaks the loop and cancels any in-flight scan or
 * disconnected-wait, so a forgotten Pod stops scanning/reconnecting immediately.
 *
 * Without `watchAdvertisements` (unsupported or behind an experimental flag) there
 * is no way to notice the Pod reappear, so the loop ends and the app falls back to a
 * manual Connect or a future reload.
 */
async function superviseDevice(
  device: BluetoothDevice,
  onReconnect: (conn: PodConnection, forget: ForgetHandle) => void,
  options?: ConnectOptions,
): Promise<void> {
  const supervision = new AbortController();
  const { signal } = supervision;
  const forget: ForgetHandle = () => forgetDevice(device, supervision);

  while (!signal.aborted) {
    if (!device.gatt?.connected) {
      const conn = await tryConnect(device, options);
      if (signal.aborted) return; // forgotten mid-connect: drop the fresh link on the floor
      if (!conn) {
        // Not reachable now: wait for the Pod to advertise, then loop and retry.
        if (!(await waitForAdvertisement(device, signal))) return;
        continue;
      }
      onReconnect(conn, forget);
    }
    // Linked (just now or already): sit until it drops, then loop to re-establish.
    await disconnected(device, signal);
  }
}

/** Bring the link up if the Pod is reachable right now; null if it is not. */
async function tryConnect(
  device: BluetoothDevice,
  options?: ConnectOptions,
): Promise<PodConnection | null> {
  try {
    return await PodConnection.fromDevice(device, options);
  } catch {
    return null;
  }
}

/**
 * Scan until the Pod advertises, then stop. Resolves true once it appears; false
 * when scanning is unavailable or the external `signal` aborts (the Pod was
 * forgotten mid-scan) — either way the caller stops supervising this device.
 */
async function waitForAdvertisement(
  device: BluetoothDevice,
  signal: AbortSignal,
): Promise<boolean> {
  if (typeof device.watchAdvertisements !== 'function' || signal.aborted) return false;

  const scan = new AbortController();
  try {
    await device.watchAdvertisements({ signal: scan.signal });
  } catch {
    // Scanning is unsupported or blocked (needs an experimental flag on some builds).
    return false;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      // Aborted while `watchAdvertisements` was starting up: an `abort` listener
      // added now would never fire, so bail before we register one and hang.
      if (signal.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      device.addEventListener('advertisementreceived', () => resolve(), {
        once: true,
        signal: scan.signal,
      });
      // Forgetting the Pod aborts supervision: end the scan without waiting for range.
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
        once: true,
        signal: scan.signal,
      });
    });
  } catch {
    return false; // forgotten mid-scan: stop supervising this device
  } finally {
    scan.abort(); // stop scanning and drop both listeners
  }
  return true;
}

/**
 * Resolve when the device's link drops, when supervision is aborted (the Pod was
 * forgotten), or at once if it is already down. Either resolution returns the loop
 * to its top, where the aborted signal ends it.
 */
function disconnected(device: BluetoothDevice, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || !device.gatt?.connected) {
      resolve();
      return;
    }
    // Bind both listeners to `done` so the first to fire removes the other.
    const done = new AbortController();
    const settle = () => {
      done.abort();
      resolve();
    };
    device.addEventListener('gattserverdisconnected', settle, { once: true, signal: done.signal });
    signal.addEventListener('abort', settle, { once: true, signal: done.signal });
  });
}

/**
 * Revoke a Pod's grant and stop supervising it (ticket 12c): abort its supervision
 * loop — which cancels any in-flight scan or disconnected-wait, so the Pod stops
 * scanning/reconnecting at once — drop the GATT link, and, where the browser
 * supports it, call `device.forget()` so it is no longer returned by `getDevices()`
 * after the next reload. `device.forget()` is Chrome-only, so it is guarded and a
 * no-op elsewhere (the loop still stops for the rest of the session).
 */
async function forgetDevice(
  device: BluetoothDevice,
  supervision: AbortController,
): Promise<void> {
  supervision.abort();
  device.gatt?.disconnect();
  if (typeof device.forget === 'function') await device.forget();
}
