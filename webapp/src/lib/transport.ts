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
