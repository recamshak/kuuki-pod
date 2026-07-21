/*
 * Per-Pod History + the idempotent applySync() Merge (ticket 08).
 *
 * This is the correctness guarantee of the whole sync path: it folds a Sync's
 * decoded Samples into the webapp's long-lived per-Pod History (CONTEXT.md).
 * It is a pure, tested seam — no Web Bluetooth, no DOM. Decode is upstream
 * (ticket 09); this module consumes already-decoded records.
 *
 * Correctness rests on two things, neither of which is the High-water mark:
 *   - Samples are appended oldest-first (ADR-0002), so a truncated Sync only
 *     ever loses the not-yet-sent newest tail and the next Sync re-fetches it.
 *   - Boundary-only dedup: because the client Syncs with its High-water mark,
 *     the sole possible duplicate is our latest stored Sample vs the oldest
 *     incoming one. We compare their values (co2/temp/humidity, NOT their
 *     wall-clock t, which drifts with Age) and drop that one overlap if equal.
 *
 * History is persisted in a compact columnar encoding in localStorage. Callers
 * and tests only observe Samples in and Samples out; the byte layout is private
 * and may be reimplemented without touching a single test.
 */

/** One decoded Sync data record — the wire fields, pre-`t`. See docs/wire-contract.md. */
export interface SyncRecord {
  /** Age in seconds: latch_uptime − capture_uptime. */
  age: number;
  /** CO₂ in ppm. */
  co2: number;
  /** Temperature in centi-°C (signed). */
  temp: number;
  /** Relative humidity in centi-%RH. */
  humidity: number;
}

/** A stored Sample: one CO₂/temp/humidity point placed on the wall clock. */
export interface Sample {
  /** Wall-clock time in ms (Date.now() domain), = latch − age × 1000. */
  t: number;
  co2: number;
  temp: number;
  humidity: number;
}

/**
 * The slice of the Web Storage API this module needs. `localStorage` satisfies
 * it; tests pass an in-memory double. `setItem` may throw QuotaExceededError.
 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * A `KeyValueStore` that can also be enumerated (the `length`/`key(i)` pair of
 * the Web Storage API). `localStorage` satisfies it; `listPodIds` needs it to
 * discover which Pods have History without a live connection.
 */
export interface EnumerableKeyValueStore extends KeyValueStore {
  readonly length: number;
  key(index: number): string | null;
}

export interface HistoryOptions {
  /** Where to persist. Defaults to the ambient `localStorage` (undefined under Node). */
  store?: KeyValueStore;
  /** Hard cap on stored Samples; oldest are trimmed past it. Defaults to MAX_SAMPLES. */
  maxSamples?: number;
}

/** Bytes per Sample in the columnar encoding: t(f64) + co2(u16) + temp(i16) + humidity(u16). */
const BYTES_PER_SAMPLE = 8 + 2 + 2 + 2;

const KEY_PREFIX = 'kuuki:history:';

/**
 * The webapp's per-Pod History: the long-lived localStorage record built up by
 * Merge across many Syncs, keyed by Pod ID. Ordered oldest-first.
 */
export class History {
  /** Cap on Samples stored per Pod. Realistic use is a few thousand; this is a ceiling. */
  static readonly MAX_SAMPLES = 1_000_000;

  private readonly key: string;
  private readonly store: KeyValueStore | undefined;
  private readonly maxSamples: number;
  private stored: Sample[];

  constructor(podId: string, options: HistoryOptions = {}) {
    this.key = KEY_PREFIX + podId;
    this.store = options.store ?? (globalThis as { localStorage?: KeyValueStore }).localStorage;
    this.maxSamples = options.maxSamples ?? History.MAX_SAMPLES;
    this.stored = this.load();
  }

  /** Number of stored Samples. */
  get length(): number {
    return this.stored.length;
  }

  /** The newest stored Sample, or undefined when the History is empty. */
  latest(): Sample | undefined {
    const last = this.stored[this.stored.length - 1];
    return last ? { ...last } : undefined;
  }

  /** All stored Samples, oldest-first, as copies (mutating them cannot corrupt History). */
  samples(): Sample[] {
    return this.stored.map((s) => ({ ...s }));
  }

  /**
   * Append Samples (already oldest-first) and persist. Enforces the cap and,
   * on QuotaExceededError, trims oldest and retries — never throwing and never
   * dropping the just-appended Samples.
   */
  append(incoming: Sample[]): void {
    if (incoming.length === 0) return;
    this.stored.push(...incoming);
    if (this.stored.length > this.maxSamples) {
      this.stored.splice(0, this.stored.length - this.maxSamples);
    }
    this.persist(incoming.length);
  }

  private persist(justAppended: number): void {
    if (!this.store) return;
    for (;;) {
      try {
        this.store.setItem(this.key, encode(this.stored));
        return;
      } catch (err) {
        if (!isQuotaError(err)) throw err;
        // Trim oldest to make room, but never sacrifice the incoming Samples.
        const removable = this.stored.length - justAppended;
        if (removable <= 0) return; // best effort: kept in memory, storage left as-is
        const drop = Math.min(removable, Math.max(1, Math.ceil(this.stored.length * 0.1)));
        this.stored.splice(0, drop);
      }
    }
  }

  private load(): Sample[] {
    const raw = this.store?.getItem(this.key);
    if (!raw) return [];
    try {
      return decode(raw);
    } catch {
      // Corrupt or foreign data: start clean rather than fail the whole webapp.
      return [];
    }
  }
}

/**
 * The Pod IDs that already have persisted History in `store`, so the webapp can
 * open a Pod's chart on reload with no Bluetooth connection (ticket 10). Defaults
 * to the ambient `localStorage`; returns empty when no store is available.
 */
export function listPodIds(store?: EnumerableKeyValueStore): string[] {
  const s = store ?? (globalThis as { localStorage?: EnumerableKeyValueStore }).localStorage;
  if (!s) return [];
  const ids: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const key = s.key(i);
    if (key?.startsWith(KEY_PREFIX)) ids.push(key.slice(KEY_PREFIX.length));
  }
  return ids;
}

/**
 * Remove a Pod's persisted History from `store`, so "forget Pod" can wipe its
 * stored data (ticket 12). Companion to `listPodIds`: after this, `listPodIds`
 * no longer lists `podId` and every other Pod's History is untouched. Defaults
 * to the ambient `localStorage`; idempotent and a no-op when absent or unstored.
 */
export function deleteHistory(podId: string, store?: KeyValueStore): void {
  const s = store ?? (globalThis as { localStorage?: KeyValueStore }).localStorage;
  s?.removeItem(KEY_PREFIX + podId);
}

/**
 * Fold a Sync's decoded records into `history`, in place.
 *
 * Each record is placed on the wall clock at `t = nowMs − age × 1000`, where
 * `nowMs` is the Latched read instant (Date.now() captured once at Sync start).
 * The oldest incoming record is dropped when its values equal the latest
 * stored Sample's (the only possible overlap); the rest are appended oldest-first.
 */
export function applySync(history: History, payload: SyncRecord[], nowMs: number): void {
  if (payload.length === 0) return;

  let incoming: Sample[] = payload.map((r) => ({
    t: nowMs - r.age * 1000,
    co2: r.co2,
    temp: r.temp,
    humidity: r.humidity,
  }));

  const latest = history.latest();
  if (latest && sameValues(latest, incoming[0])) {
    incoming = incoming.slice(1);
  }

  history.append(incoming);
}

/** Two Samples carry the same values (Age/t is deliberately excluded — it drifts). */
function sameValues(a: Sample, b: Sample): boolean {
  return a.co2 === b.co2 && a.temp === b.temp && a.humidity === b.humidity;
}

function isQuotaError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; code?: number };
  return (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    e.code === 22 ||
    e.code === 1014
  );
}

// --- Compact columnar encoding -------------------------------------------------
// Layout (little-endian, packed): uint32 count, then the four columns back to
// back — t[] as float64, co2[] as uint16, temp[] as int16, humidity[] as uint16.
// Columnar keeps like-typed values adjacent; base64 makes it a localStorage string.

function encode(samples: Sample[]): string {
  const n = samples.length;
  const buf = new ArrayBuffer(4 + n * BYTES_PER_SAMPLE);
  const dv = new DataView(buf);
  dv.setUint32(0, n, true);
  const tAt = 4;
  const co2At = tAt + n * 8;
  const tempAt = co2At + n * 2;
  const humAt = tempAt + n * 2;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    dv.setFloat64(tAt + i * 8, s.t, true);
    dv.setUint16(co2At + i * 2, s.co2, true);
    dv.setInt16(tempAt + i * 2, s.temp, true);
    dv.setUint16(humAt + i * 2, s.humidity, true);
  }
  return bytesToBase64(new Uint8Array(buf));
}

function decode(raw: string): Sample[] {
  const bytes = base64ToBytes(raw);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(0, true);
  const tAt = 4;
  const co2At = tAt + n * 8;
  const tempAt = co2At + n * 2;
  const humAt = tempAt + n * 2;
  const out: Sample[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      t: dv.getFloat64(tAt + i * 8, true),
      co2: dv.getUint16(co2At + i * 2, true),
      temp: dv.getInt16(tempAt + i * 2, true),
      humidity: dv.getUint16(humAt + i * 2, true),
    };
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000; // stay under String.fromCharCode's argument-count limit
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
