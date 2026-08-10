/*
 * Pure view-support logic for the one-screen dashboard (ticket 10, reworked in 16a,
 * 16b and 17).
 *
 * The Svelte shell and the uPlot wrapper are the untestable seams; the decisions live
 * in tested modules — this one and its gesture companion `gestures.ts`, which owns the
 * touch state machine and the View's zoom-and-pan limits. Here: how a CO₂ number maps
 * to a colour band, which slice of time the chart shows and when that window follows
 * fresh data, which Sample a selection snaps to, how stored Samples become uPlot's
 * column arrays, and the y-domain each series is drawn against.
 *
 * No DOM, no Bluetooth, no framework — Samples in, plain values out. The one import
 * with a life outside this module is `uplot`, for its static `rangeNum` padding helper;
 * it loads fine without a `document`, so this stays a plain node-testable module.
 */

import uPlot from 'uplot';
import type { Sample } from './history';

/** A CO₂ colour band: the traffic-light verdict shown behind the hero number. */
export interface Co2Band {
  level: 'good' | 'fair' | 'poor';
  /** Short human verdict, e.g. "Fresh". */
  label: string;
  /** CSS colour used for the hero number and the chart's CO₂ line. */
  color: string;
}

/**
 * ppm boundaries between bands. ~800/1200 ppm are the common indoor-air rules of
 * thumb (below ~800 is well-ventilated; above ~1200 is stuffy). `fair` is the
 * half-open span [FAIR, POOR); `poor` is FAIR-and-above… i.e. POOR-and-above.
 */
export const CO2_THRESHOLDS = { fair: 800, poor: 1200 } as const;

const BANDS: Record<Co2Band['level'], Co2Band> = {
  good: { level: 'good', label: 'Fresh', color: '#3fb950' },
  fair: { level: 'fair', label: 'Stuffy', color: '#d29922' },
  poor: { level: 'poor', label: 'Poor', color: '#f85149' },
};

/** Map a CO₂ reading (ppm) to its colour band. */
export function co2Band(co2: number): Co2Band {
  if (co2 >= CO2_THRESHOLDS.poor) return BANDS.poor;
  if (co2 >= CO2_THRESHOLDS.fair) return BANDS.fair;
  return BANDS.good;
}

/**
 * The chart's View: the visible x-range, in unix seconds (uPlot's time convention). The
 * whole History is always fed to the chart, so the View — never a pre-sliced subset of
 * Samples — is what the user sees.
 */
export interface ChartView {
  min: number;
  max: number;
}

/** The span the chart opens on and resets to: the last 24 h, the primary overnight View. */
export const DEFAULT_VIEW_SPAN_S = 24 * 3600;

/** The View the chart opens on and returns to: the last 24 h, right edge at `nowMs`. */
export function defaultView(nowMs: number): ChartView {
  const now = nowMs / 1000;
  return { min: now - DEFAULT_VIEW_SPAN_S, max: now };
}

/**
 * Where the view goes when a Merge appends Samples: forward with the data if the view
 * was parked at the live edge (its right edge at or past the newest Sample), keeping
 * its span and its distance from that edge. A view panned into the past is returned
 * as-is — a background Merge must never yank the viewport. `x` values are unix seconds;
 * a missing end (empty data) means there is nothing to follow.
 */
export function followLiveEdge(
  view: ChartView,
  newestBefore: number | undefined,
  newestAfter: number | undefined,
): ChartView {
  if (newestBefore === undefined || newestAfter === undefined) return view;
  const advanced = newestAfter - newestBefore;
  if (advanced <= 0 || view.max < newestBefore) return view;
  return { min: view.min + advanced, max: view.max + advanced };
}

/** uPlot's aligned column layout: [x, ...series], each an equal-length array. */
export type PlotData = [number[], number[], number[], number[]];

/**
 * Transform stored Samples into uPlot columns: x in unix seconds (uPlot's time
 * convention), CO₂ in ppm, temperature and humidity decoded from centi-units to
 * real °C / %RH. Samples are oldest-first, so x comes out ascending as uPlot needs.
 */
export function toPlotData(samples: Sample[]): PlotData {
  const xs: number[] = [];
  const co2: number[] = [];
  const temp: number[] = [];
  const humidity: number[] = [];
  for (const s of samples) {
    xs.push(s.t / 1000);
    co2.push(s.co2);
    temp.push(round2(s.temp / 100));
    humidity.push(round2(s.humidity / 100));
  }
  return [xs, co2, temp, humidity];
}

/** uPlot's key for each y-scale; also the axis label the series is drawn against. */
export type ScaleKey = 'co2' | '°C' | '%RH';

/** A y-domain in uPlot's `[min, max]` shape, ready to hand back from `scale.range`. */
export type YDomain = [min: number, max: number];

/**
 * The **Scale base** of each series: the resting y-domain it is drawn against, chosen
 * so the chart says something true about the quantity before any data arrives. It does
 * not depend on the View, so a gesture only ever changes *which slice of time* is
 * shown, never how tall a value looks.
 *
 * - CO₂ 400–2000 ppm: 400 is ambient outdoor air (the floor the SCD40 reports under
 *   ADR-0003's ASC assumption); 2000 clears the poor threshold, so both band
 *   boundaries stay in frame and the hero's colour always agrees with the line.
 * - Humidity 0–100 %RH: its definitional range.
 * - Temperature 18–24 °C: the band where "is this room comfortable?" is decided, so a
 *   typical 1–3 °C overnight swing fills a useful share of the panel.
 */
const SCALE_BASES: Record<ScaleKey, YDomain> = {
  co2: [400, 2000],
  '°C': [18, 24],
  '%RH': [0, 100],
};

/**
 * uPlot's own padding multiple for a numeric y-scale: widen by a tenth of the span and
 * snap outwards to a round number, so gridline labels stay legible and lines never
 * graze the frame.
 */
const PAD_MULT = 0.1;

/**
 * The y-domain each series is drawn against: its Scale base, widened — never narrowed —
 * on whichever side the *whole* History escapes it, out to a padded round number. The
 * extent comes from every Sample in the columns, not the visible ones, so the domains
 * are identical whatever the View is doing; only a Merge that breaks a record can move
 * an axis. An empty, single-Sample or dead-flat History lands squarely on its base, so
 * there is no degenerate zero-height case to special-case anywhere.
 */
export function scaleDomains(data: PlotData): Record<ScaleKey, YDomain> {
  const [, co2, temp, humidity] = data;
  return {
    co2: widenToFit(SCALE_BASES.co2, co2),
    '°C': widenToFit(SCALE_BASES['°C'], temp),
    '%RH': widenToFit(SCALE_BASES['%RH'], humidity),
  };
}

/**
 * `base`, widened to hold every value in `column`. Padding is applied only to the
 * escaping side: padding a side the data never reached would drift the floor below its
 * base for no reason (430…780 → 390 ppm) and would lose the base entirely for a flat
 * History (600…600 → 0 ppm).
 */
function widenToFit([baseLo, baseHi]: YDomain, column: number[]): YDomain {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of column) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo >= baseLo && hi <= baseHi) return [baseLo, baseHi];

  // `rangeNum`'s return type admits nulls; falling back to the bare extent keeps the
  // escaping Sample on screen, where falling back to the base would clip it away.
  const [padLo, padHi] = uPlot.rangeNum(lo, hi, PAD_MULT, true);
  return [lo < baseLo ? (padLo ?? lo) : baseLo, hi > baseHi ? (padHi ?? hi) : baseHi];
}

/**
 * The x of the Sample nearest `t` in an ascending x column — where a one-finger
 * selection lands, so the cursor marks a real Sample rather than the gap the finger
 * happened to cover. `undefined` when there are no Samples to snap to.
 */
export function nearestX(xs: number[], t: number): number | undefined {
  if (xs.length === 0) return undefined;

  let lo = 0;
  let hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < t) lo = mid + 1;
    else hi = mid;
  }

  // `lo` is the first x at or after `t`; the one before it may still be nearer.
  const after = xs[lo];
  const before = lo > 0 ? xs[lo - 1] : after;
  return t - before <= after - t ? before : after;
}

/** Round to 2 decimals, killing float dust from the centi-unit division. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
