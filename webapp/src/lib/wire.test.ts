import { describe, expect, it } from 'vitest';
import {
  ATT_NTF_OVERHEAD,
  decodeLiveReading,
  decodeSyncRecords,
  encodeMark,
  formatPodId,
  LIVE_READING_SIZE,
  markFor,
  MARK_SENTINEL,
  RECORD_SIZE,
} from './wire';
import type { Sample } from './history';

// The pure wire codec (ticket 09): the byte-exact seam between Web Bluetooth and
// the tested Merge. These suites assert the framing in docs/wire-contract.md —
// little-endian, packed, no padding — with no BLE and no DOM. The transport that
// drives a real GATT connection is out of unit-test scope (manual, on-device);
// every byte it touches goes through the functions exercised here.

/** Build a DataView over freshly written bytes so tests read what they wrote. */
function view(bytes: number[]): DataView {
  const buf = new Uint8Array(bytes);
  return new DataView(buf.buffer);
}

/** Little-endian byte tuples for the record/live fields, for hand-built payloads. */
function u16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}
function i16(n: number): number[] {
  return u16(n & 0xffff);
}
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

describe('decodeSyncRecords', () => {
  it('decodes one 10-byte record, little-endian, signed temp', () => {
    const bytes = [...u32(900), ...u16(812), ...i16(2143), ...u16(4750)];
    expect(decodeSyncRecords(view(bytes))).toEqual([
      { age: 900, co2: 812, temp: 2143, humidity: 4750 },
    ]);
  });

  it('preserves oldest-first order across a multi-record notification', () => {
    const recs = [
      [...u32(2700), ...u16(800), ...i16(2000), ...u16(5000)],
      [...u32(1800), ...u16(810), ...i16(2010), ...u16(5100)],
      [...u32(900), ...u16(820), ...i16(2020), ...u16(5200)],
    ];
    const out = decodeSyncRecords(view(recs.flat()));
    expect(out.map((r) => r.age)).toEqual([2700, 1800, 900]);
    expect(out.map((r) => r.co2)).toEqual([800, 810, 820]);
  });

  it('reads a negative (below-zero centi-°C) temperature', () => {
    const bytes = [...u32(60), ...u16(600), ...i16(-512), ...u16(3000)];
    expect(decodeSyncRecords(view(bytes))[0].temp).toBe(-512);
  });

  it('decodes a zero-length notification as no records', () => {
    expect(decodeSyncRecords(view([]))).toEqual([]);
  });

  it('rejects a payload that is not a whole number of records', () => {
    expect(() => decodeSyncRecords(view([1, 2, 3, 4, 5]))).toThrow();
  });
});

describe('decodeLiveReading', () => {
  it('decodes the 6-byte Live reading, little-endian', () => {
    const bytes = [...u16(742), ...i16(2143), ...u16(4800)];
    expect(decodeLiveReading(view(bytes))).toEqual({ co2: 742, temp: 2143, humidity: 4800 });
  });

  it('treats co2 == 0 as "no Measurement yet" (null)', () => {
    const bytes = [...u16(0), ...i16(2100), ...u16(5000)];
    expect(decodeLiveReading(view(bytes))).toBeNull();
  });

  it('rejects a wrong-length payload', () => {
    expect(() => decodeLiveReading(view([1, 2, 3, 4]))).toThrow();
  });
});

describe('markFor', () => {
  const nowMs = 1_700_000_000_000;

  it('returns the sentinel when the History is empty', () => {
    expect(markFor(undefined, nowMs)).toBe(MARK_SENTINEL);
  });

  it("computes the newest Sample's Age in whole seconds", () => {
    const latest: Sample = { t: nowMs - 900_000, co2: 800, temp: 2100, humidity: 5000 };
    expect(markFor(latest, nowMs)).toBe(900);
  });

  it('clamps a future-dated Sample (clock skew) to a non-negative Age', () => {
    const latest: Sample = { t: nowMs + 5_000, co2: 800, temp: 2100, humidity: 5000 };
    expect(markFor(latest, nowMs)).toBe(0);
  });
});

describe('encodeMark', () => {
  it('writes a 4-byte little-endian Age', () => {
    expect([...new Uint8Array(encodeMark(900))]).toEqual(u32(900));
  });

  it('writes the send-everything sentinel', () => {
    expect([...new Uint8Array(encodeMark(MARK_SENTINEL))]).toEqual([0xff, 0xff, 0xff, 0xff]);
  });
});

describe('formatPodId', () => {
  it('hex-encodes the 16 raw bytes in order', () => {
    const bytes = view([
      0x4b, 0x75, 0x75, 0x6b, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa,
      0xbb,
    ]);
    expect(formatPodId(bytes)).toBe('4b75756b00112233445566778899aabb');
  });
});

describe('canonical constants match the wire contract', () => {
  it('names the wire-contract values', () => {
    expect(RECORD_SIZE).toBe(10);
    expect(LIVE_READING_SIZE).toBe(6);
    expect(ATT_NTF_OVERHEAD).toBe(3);
    expect(MARK_SENTINEL).toBe(0xffffffff);
  });
});
