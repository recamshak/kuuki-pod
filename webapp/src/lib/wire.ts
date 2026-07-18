/*
 * The Sync wire codec (ticket 09): byte-exact encode/decode against the single
 * source of truth in docs/wire-contract.md. Everything the Web Bluetooth
 * transport reads off or writes onto a GATT characteristic passes through here,
 * which keeps the framing in one pure, tested place rather than smeared through
 * the untestable BLE plumbing.
 *
 * Endianness is little-endian on every multi-byte field (GATT convention, and
 * Web Bluetooth's natural DataView reads); records are packed with no padding.
 */

import type { Sample, SyncRecord } from './history';

// Canonical constants — values taken verbatim from docs/wire-contract.md, which
// forbids any module redefining them with a different value.

/** Bytes per Sync data record: age(u32) + co2(u16) + temp(i16) + humidity(u16). */
export const RECORD_SIZE = 10;
/** Bytes of the Live reading payload — a record minus its 4-byte age. */
export const LIVE_READING_SIZE = 6;
/** ATT bytes subtracted from the MTU for a notification (opcode + handle). */
export const ATT_NTF_OVERHEAD = 3;
/** High-water mark meaning "I have nothing — send everything." */
export const MARK_SENTINEL = 0xffffffff;

/** The Live reading's three Measurement fields — "right now", carrying no Age. */
export interface LiveReading {
  /** CO₂ in ppm (always > 0; a 0 on the wire is the "not available yet" sentinel). */
  co2: number;
  /** Temperature in centi-°C (signed). */
  temp: number;
  /** Relative humidity in centi-%RH. */
  humidity: number;
}

/**
 * Decode one Sync data notification into its records, oldest-first as received.
 *
 * A record is never split across notifications, so a data-bearing payload is a
 * whole number of `RECORD_SIZE` chunks; a zero-length payload (the end-of-batch
 * marker, handled by the caller) decodes to no records. Any other length is a
 * framing violation and throws rather than silently mis-decode.
 */
export function decodeSyncRecords(view: DataView): SyncRecord[] {
  if (view.byteLength % RECORD_SIZE !== 0) {
    throw new Error(
      `Sync notification of ${view.byteLength} bytes is not a multiple of RECORD_SIZE (${RECORD_SIZE})`,
    );
  }
  const count = view.byteLength / RECORD_SIZE;
  const out: SyncRecord[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const at = i * RECORD_SIZE;
    out[i] = {
      age: view.getUint32(at, true),
      co2: view.getUint16(at + 4, true),
      temp: view.getInt16(at + 6, true),
      humidity: view.getUint16(at + 8, true),
    };
  }
  return out;
}

/**
 * Decode the Live reading characteristic's payload, or `null` when the Pod has
 * no Measurement yet. A real room is never 0 ppm CO₂, so the Pod uses `co2 == 0`
 * as the sentinel for the ~30 s after boot before the SCD40's first Measurement;
 * the client shows "not available" rather than a bogus reading.
 */
export function decodeLiveReading(view: DataView): LiveReading | null {
  if (view.byteLength !== LIVE_READING_SIZE) {
    throw new Error(
      `Live reading of ${view.byteLength} bytes, expected LIVE_READING_SIZE (${LIVE_READING_SIZE})`,
    );
  }
  const co2 = view.getUint16(0, true);
  if (co2 === 0) return null;
  return {
    co2,
    temp: view.getInt16(2, true),
    humidity: view.getUint16(4, true),
  };
}

/**
 * The High-water mark to write at Sync start: the Age of the newest Sample the
 * client already holds, or the sentinel when it holds none. Age is `(nowMs − t)`
 * in whole seconds, where `nowMs` is the Latched read instant captured once at
 * Sync start — the mirror of the value the records' Ages are measured against.
 *
 * The mark only trims transfer volume; correctness is the slot-keyed Merge, so a
 * rounded (or clock-skewed, hence clamped-to-zero) Age is fine.
 */
export function markFor(latest: Sample | undefined, nowMs: number): number {
  if (!latest) return MARK_SENTINEL;
  return Math.max(0, Math.round((nowMs - latest.t) / 1000));
}

/** Encode a High-water mark as the 4-byte little-endian Sync control write. */
export function encodeMark(mark: number): ArrayBuffer {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, mark, true);
  return buf;
}

/** Hex-encode the raw Pod ID bytes into the stable key the webapp stores History under. */
export function formatPodId(view: DataView): string {
  let hex = '';
  for (let i = 0; i < view.byteLength; i++) {
    hex += view.getUint8(i).toString(16).padStart(2, '0');
  }
  return hex;
}
