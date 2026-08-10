import { describe, expect, it } from 'vitest';
import {
  CO2_THRESHOLDS,
  co2Band,
  defaultView,
  followLiveEdge,
  nearestX,
  scaleDomains,
  toPlotData,
} from './dashboard';
import type { Sample } from './history';

// Pure view-support logic for the dashboard (ticket 10, reworked in 16a, 16b and 17).
// The Svelte shell and the uPlot wrapper are the untestable seams; these are the
// decisions worth pinning down: CO₂ colour-banding, the chart's visible window, the
// Sample a selection snaps to, the uPlot column transform, and the y-domains each
// series is drawn against.

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

describe('nearestX', () => {
  // Quarter-hour Samples, the x column a one-finger selection snaps into.
  const xs = [1000, 1900, 2800, 3700];

  it('snaps to the nearer of the two Samples straddling the point', () => {
    expect(nearestX(xs, 2000)).toBe(1900);
    expect(nearestX(xs, 2700)).toBe(2800);
  });

  it('snaps to the end Samples for a point outside the data', () => {
    expect(nearestX(xs, 0)).toBe(1000);
    expect(nearestX(xs, 99_999)).toBe(3700);
  });

  it('returns a Sample sitting exactly on the point', () => {
    expect(nearestX(xs, 2800)).toBe(2800);
  });

  it('has nothing to snap to in an empty History', () => {
    expect(nearestX([], 2000)).toBeUndefined();
  });
});

describe('scaleDomains', () => {
  // The Scale base is a resting y-domain that does not depend on the View: a gesture
  // only changes which slice of time is shown, never how tall a value looks. A base is
  // widened — never narrowed — where the *whole* History escapes it (ticket 17).

  /** A History from CO₂/temp/humidity triples, one Sample per quarter-hour. */
  function history(rows: [co2: number, temp: number, humidity: number][]) {
    return toPlotData(rows.map(([co2, temp, humidity], i) => sample(T0 + i * 900_000, co2, temp, humidity)));
  }

  it('rests on the bases when the whole History fits inside them', () => {
    const d = scaleDomains(history([[430, 2100, 4790], [780, 2250, 5500]]));

    expect(d.co2).toEqual([400, 2000]);
    expect(d['°C']).toEqual([18, 24]);
    expect(d['%RH']).toEqual([0, 100]);
  });

  it('widens only the side the History escapes, to a padded round number', () => {
    // A 3100 ppm cooking spike lifts the ceiling; the floor stays on the base.
    const d = scaleDomains(history([[405, 2100, 5000], [3100, 2100, 5000], [700, 2100, 5000]]));

    expect(d.co2).toEqual([400, 3400]);
  });

  it('widens the floor when the History dips below the base', () => {
    const d = scaleDomains(history([[380, 2100, 5000], [1500, 2100, 5000]]));

    expect(d.co2).toEqual([200, 2000]);
  });

  it('widens both sides when the History escapes both', () => {
    const d = scaleDomains(history([[380, 2100, 5000], [3100, 2100, 5000]]));

    expect(d.co2).toEqual([100, 3400]);
  });

  it('applies the same rule to temperature and humidity', () => {
    const d = scaleDomains(history([[600, 1550, 5000], [600, 2600, 10500]]));

    // Temperature escapes 18–24 on both sides; humidity only above 100 %RH.
    expect(d['°C']).toEqual([14, 28]);
    expect(d['%RH']).toEqual([0, 111]);
  });

  it('derives the extent from every Sample, not from any visible slice', () => {
    const spikeFirst = scaleDomains(history([[3100, 2100, 5000], [700, 2100, 5000]]));
    const spikeLast = scaleDomains(history([[700, 2100, 5000], [3100, 2100, 5000]]));

    expect(spikeFirst.co2).toEqual(spikeLast.co2);
    expect(spikeFirst.co2[1]).toBe(3400);
  });

  it('rests on the bases for a single-Sample and for a dead-flat History', () => {
    expect(scaleDomains(history([[600, 2100, 5000]])).co2).toEqual([400, 2000]);

    const flat = scaleDomains(history([[600, 2100, 5000], [600, 2100, 5000], [600, 2100, 5000]]));
    expect(flat.co2).toEqual([400, 2000]);
    expect(flat['°C']).toEqual([18, 24]);
    expect(flat['%RH']).toEqual([0, 100]);
  });

  it('rests on the bases for an empty History', () => {
    const d = scaleDomains(toPlotData([]));

    expect(d.co2).toEqual([400, 2000]);
    expect(d['°C']).toEqual([18, 24]);
    expect(d['%RH']).toEqual([0, 100]);
  });

  it('keeps both CO₂ band boundaries in frame at rest', () => {
    // The hero's colour verdict must agree with the line's height: 800 fair and 1200
    // poor both sit inside the drawn domain of a History that never escapes its base.
    const [lo, hi] = scaleDomains(history([[430, 2100, 5000], [780, 2100, 5000]])).co2;

    expect(lo).toBeLessThan(CO2_THRESHOLDS.fair);
    expect(hi).toBeGreaterThan(CO2_THRESHOLDS.poor);
  });
});
