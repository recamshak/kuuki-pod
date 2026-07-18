/*
 * Pure view-support logic for the one-screen dashboard (ticket 10).
 *
 * The Svelte shell and the uPlot wrapper are the untestable seams; everything
 * with a decision in it lives here, under test: how a CO₂ number maps to a
 * colour band, which time windows the range selector offers, how a window is
 * applied to History, and how stored Samples become uPlot's column arrays.
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

/** A selectable chart window: a label and its span in milliseconds. */
export interface Range {
  label: string;
  ms: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The range choices, from a single night up to a week (spec: "a night to several days"). */
export const RANGES: readonly Range[] = [
  { label: 'Night', ms: 12 * HOUR },
  { label: '24h', ms: DAY },
  { label: '3d', ms: 3 * DAY },
  { label: 'Week', ms: 7 * DAY },
];

/**
 * The Samples falling within the last `windowMs` before `nowMs`, order preserved.
 * History is oldest-first, so the result is too.
 */
export function selectRange(samples: Sample[], windowMs: number, nowMs: number): Sample[] {
  const cutoff = nowMs - windowMs;
  return samples.filter((s) => s.t >= cutoff);
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

/** Round to 2 decimals, killing float dust from the centi-unit division. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
