import { describe, expect, it } from 'vitest';
import { co2Band, RANGES, selectRange, toPlotData } from './dashboard';
import type { Sample } from './history';

// Pure view-support logic for the dashboard (ticket 10). The Svelte shell is the
// untestable seam; these are the decisions worth pinning down under test:
// CO₂ colour-banding, range windowing, and the uPlot column transform.

const T0 = 1_700_000_000_000;

function sample(t: number, co2: number, temp = 2100, humidity = 5000): Sample {
  return { t, co2, temp, humidity };
}

describe('co2Band', () => {
  it('is good below the fair threshold (~800 ppm)', () => {
    expect(co2Band(420).level).toBe('good');
    expect(co2Band(799).level).toBe('good');
  });

  it('is fair from 800 up to the poor threshold (~1200 ppm)', () => {
    expect(co2Band(800).level).toBe('fair');
    expect(co2Band(1199).level).toBe('fair');
  });

  it('is poor at and above 1200 ppm', () => {
    expect(co2Band(1200).level).toBe('poor');
    expect(co2Band(2500).level).toBe('poor');
  });

  it('carries a colour and a human label for each band', () => {
    for (const co2 of [500, 1000, 1500]) {
      const band = co2Band(co2);
      expect(band.color).toMatch(/^#|rgb|hsl/);
      expect(band.label.length).toBeGreaterThan(0);
    }
  });
});

describe('selectRange', () => {
  const samples = [
    sample(T0 - 5 * 3_600_000, 600), // 5h ago
    sample(T0 - 3 * 3_600_000, 700), // 3h ago
    sample(T0 - 1 * 3_600_000, 800), // 1h ago
  ];

  it('keeps only Samples within the window, ending at now', () => {
    const within = selectRange(samples, 4 * 3_600_000, T0);
    expect(within.map((s) => s.co2)).toEqual([700, 800]);
  });

  it('keeps everything when the window spans the whole History', () => {
    expect(selectRange(samples, 24 * 3_600_000, T0)).toHaveLength(3);
  });

  it('returns empty when nothing falls inside the window', () => {
    expect(selectRange(samples, 30 * 60_000, T0)).toEqual([]);
  });

  it('offers selectable ranges from a night to several days', () => {
    expect(RANGES.length).toBeGreaterThanOrEqual(3);
    expect(RANGES.every((r) => r.ms > 0 && r.label.length > 0)).toBe(true);
    // Spans at least a night (~12h) up to several days.
    expect(Math.min(...RANGES.map((r) => r.ms))).toBeLessThanOrEqual(12 * 3_600_000);
    expect(Math.max(...RANGES.map((r) => r.ms))).toBeGreaterThanOrEqual(3 * 24 * 3_600_000);
  });
});

describe('toPlotData', () => {
  it('produces aligned uPlot columns in seconds and real units, oldest-first', () => {
    const [xs, co2, temp, humidity] = toPlotData([
      sample(T0, 800, 2153, 4790),
      sample(T0 + 900_000, 810, 2160, 4800),
    ]);

    // x is unix seconds (uPlot convention), ascending.
    expect(xs).toEqual([T0 / 1000, (T0 + 900_000) / 1000]);
    expect(co2).toEqual([800, 810]);
    // centi-°C / centi-%RH decoded to real units.
    expect(temp).toEqual([21.53, 21.6]);
    expect(humidity).toEqual([47.9, 48]);
  });

  it('yields empty columns for empty History', () => {
    expect(toPlotData([])).toEqual([[], [], [], []]);
  });
});
