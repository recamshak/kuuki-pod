import { describe, expect, it } from 'vitest';
import { co2Band, defaultView, followLiveEdge, toPlotData } from './dashboard';
import type { Sample } from './history';

// Pure view-support logic for the dashboard (ticket 10, reworked in 16a). The Svelte
// shell and the uPlot wrapper are the untestable seams; these are the decisions worth
// pinning down under test: CO₂ colour-banding, the chart's visible window, and the
// uPlot column transform.

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

describe('defaultView', () => {
  it('spans the last 24 h with its right edge at now, in unix seconds', () => {
    expect(defaultView(T0)).toEqual({ min: T0 / 1000 - 24 * 3600, max: T0 / 1000 });
  });
});

describe('followLiveEdge', () => {
  // The chart's x is unix seconds; the view below ends at "now", the live edge.
  const NOW = T0 / 1000;
  const atEdge = { min: NOW - 24 * 3600, max: NOW };

  it('slides the view forward by the new data when it was parked at the live edge', () => {
    // Newest Sample was 5 min old; a Merge lands one 10 min into the "future" gap.
    expect(followLiveEdge(atEdge, NOW - 300, NOW + 600)).toEqual({
      min: atEdge.min + 900,
      max: atEdge.max + 900,
    });
  });

  it('counts a right edge sitting exactly on the newest Sample as the live edge', () => {
    expect(followLiveEdge(atEdge, NOW, NOW + 900)).toEqual({
      min: atEdge.min + 900,
      max: atEdge.max + 900,
    });
  });

  it('leaves a view panned into the past untouched', () => {
    const panned = { min: NOW - 48 * 3600, max: NOW - 24 * 3600 };
    expect(followLiveEdge(panned, NOW - 300, NOW + 600)).toBe(panned);
  });

  it('leaves the view untouched when a Merge brought no newer Sample', () => {
    expect(followLiveEdge(atEdge, NOW - 300, NOW - 300)).toBe(atEdge);
    expect(followLiveEdge(atEdge, NOW - 300, NOW - 900)).toBe(atEdge);
  });

  it('leaves the view untouched when either end of the data is missing', () => {
    expect(followLiveEdge(atEdge, undefined, NOW)).toBe(atEdge);
    expect(followLiveEdge(atEdge, NOW - 300, undefined)).toBe(atEdge);
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
