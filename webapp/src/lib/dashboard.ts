/*
 * Pure view-support logic for the one-screen dashboard (ticket 10, reworked in 16a
 * and 16b).
 *
 * The Svelte shell and the uPlot wrapper are the untestable seams; the decisions live
 * in tested modules — this one and its gesture companion `gestures.ts`, which owns the
 * touch state machine and the View's zoom-and-pan limits. Here: how a CO₂ number maps
 * to a colour band, which slice of time the chart shows and when that window follows
 * fresh data, which Sample a selection snaps to, and how stored Samples become uPlot's
 * column arrays.
 *
 * No DOM, no Bluetooth, no framework — Samples in, plain values out.
 */

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
