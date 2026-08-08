/*
 * The chart's touch gesture machine (ticket 16b): the decision half of the touch UX,
 * kept pure so it can be tested without a browser (ADR-0004). Chart.svelte owns the
 * DOM half — it reads finger positions off TouchEvents, hands them here, and applies
 * whatever comes back to uPlot.
 *
 * Three gestures, and they never overlap:
 *   - one finger selects a Sample — a tap picks one, a drag sweeps the selection,
 *     lifting pins it (there is no deselect: the next touch just moves it);
 *   - two fingers move the View — pinch zooms, dragging pans, both at once falls out
 *     of the same solve;
 *   - a double tap resets to the default View (the touch twin of the desktop
 *     double-click).
 *
 * A one-finger touch does not select the moment it lands: it commits either when it
 * drags past the tap slop or when it lifts. That is what keeps the first finger of a
 * pinch — which always lands a few milliseconds before the second — from dragging the
 * Selection somewhere the user never pointed at.
 *
 * The rest of the handoffs are equally fiddly, so they are explicit too: a second
 * finger landing escalates to the View gesture at once and freezes the selection where
 * it got to, and any finger lifting mid-gesture ends the gesture cold — the surviving
 * finger is inert until the chart is clear, so a two-finger release can never fling the
 * selection.
 *
 * Two fingers are solved as one transform rather than a zoom plus a pan: each finger
 * grabs the instant it was over when it landed and keeps holding it, so the View is
 * simply whichever window puts both instants back under both fingers. Zoom about the
 * midpoint and finger-tracked panning are then the same equation, and there is no
 * momentum to model.
 */

import { DEFAULT_VIEW_SPAN_S, type ChartView } from './dashboard';

/** The tightest View a pinch can reach: below ~30 min a 15-minute Sample tick shows nothing. */
const MIN_VIEW_SPAN_S = 30 * 60;

/** Longest a touch can last and still count as a tap. */
const TAP_MS = 300;

/** Longest gap between two taps for the second to be a double tap. */
const DOUBLE_TAP_MS = 300;

/** How far a touch may wander, in px, and still count as a tap rather than a scrub. */
const TAP_SLOP_PX = 10;

/** One finger on the chart: its identity, and its x in CSS px from the plot area's left edge. */
export interface Finger {
  id: number;
  x: number;
}

/** What the chart looks like at the instant a gesture begins. */
export interface PlotFrame {
  /** Plot area width, in CSS px. */
  width: number;
  /** The View the gesture starts from. */
  view: ChartView;
  /** The widest View the gesture may reach — see `widestView`. */
  widest: ChartView;
}

/** What a touch asks the chart to do. */
export type GestureEffect =
  | { kind: 'none' }
  | { kind: 'select'; x: number }
  | { kind: 'view'; view: ChartView }
  | { kind: 'reset' };

const NOTHING: GestureEffect = { kind: 'none' };

/**
 * How far out a gesture may zoom, and how far either way it may pan: the whole
 * History, oldest Sample to now. Never narrower than the window the chart opens on,
 * though — a Pod whose History is younger than a day would otherwise have its opening
 * View collapse onto its handful of Samples the moment it was panned.
 */
export function widestView(xs: number[], nowMs: number): ChartView {
  const now = nowMs / 1000;
  return { min: Math.min(xs.at(0) ?? now, now - DEFAULT_VIEW_SPAN_S), max: now };
}

/** A finger and the instant it grabbed, held for as long as the two-finger gesture lasts. */
interface Grip {
  id: number;
  t: number;
}

/** Two fingers on the View, each holding the instant it landed on. */
interface MovePhase {
  name: 'move';
  frame: PlotFrame;
  a: Grip;
  b: Grip;
}

type Phase =
  | { name: 'idle' }
  /** One finger down, not yet committed to being a tap or a scrub. */
  | { name: 'select'; id: number; startX: number; startMs: number; moved: boolean }
  | MovePhase
  /** A double tap took this touch; it will not select, but a second finger may still pinch. */
  | { name: 'reset' }
  /** The gesture is over but fingers are still down; they do nothing until the chart clears. */
  | { name: 'spent' };

/** A completed tap, kept only long enough for the next touch to make a double tap of it. */
interface Tap {
  x: number;
  ms: number;
}

/**
 * The touch state machine. One per chart; fed the *full* current touch list on every
 * event (exactly what `TouchEvent.touches` carries) plus the event's timestamp, and
 * the chart's frame whenever a finger lands.
 */
export class TouchGestures {
  private phase: Phase = { name: 'idle' };
  private lastTap: Tap | undefined;

  /** A finger landed. */
  down(fingers: Finger[], frame: PlotFrame, atMs: number): GestureEffect {
    const [a, b] = fingers;
    if (a === undefined) return NOTHING;

    if (b !== undefined) {
      // A second finger takes over the gesture, whatever the first one was doing —
      // unless the gesture is already moving the View, or already spent.
      if (this.phase.name === 'move' || this.phase.name === 'spent') return NOTHING;
      this.lastTap = undefined;
      this.phase = { name: 'move', frame, a: gripAt(a, frame), b: gripAt(b, frame) };
      return NOTHING;
    }

    if (this.phase.name !== 'idle') return NOTHING;

    if (this.isDoubleTap(a, atMs)) {
      // The reset owns this touch: it will not select, and it cannot chain into a third tap.
      this.lastTap = undefined;
      this.phase = { name: 'reset' };
      return { kind: 'reset' };
    }

    this.phase = { name: 'select', id: a.id, startX: a.x, startMs: atMs, moved: false };
    return NOTHING;
  }

  /** The fingers moved. */
  move(fingers: Finger[]): GestureEffect {
    const phase = this.phase;

    if (phase.name === 'select') {
      const finger = fingers.find((f) => f.id === phase.id);
      if (finger === undefined) return NOTHING;
      // Inside the slop this is still a tap in the making, and a tap commits on lift.
      if (!phase.moved && Math.abs(finger.x - phase.startX) <= TAP_SLOP_PX) return NOTHING;
      phase.moved = true;
      return { kind: 'select', x: finger.x };
    }

    if (phase.name === 'move') {
      const a = fingers.find((f) => f.id === phase.a.id);
      const b = fingers.find((f) => f.id === phase.b.id);
      if (a === undefined || b === undefined) return NOTHING;
      return { kind: 'view', view: movedView(phase, a, b) };
    }

    return NOTHING;
  }

  /** A finger lifted (or its touch was cancelled). */
  up(fingers: Finger[], atMs: number): GestureEffect {
    const phase = this.phase;

    if (fingers.length > 0) {
      // Losing a finger ends the gesture; the rest are inert until the chart clears.
      if (phase.name !== 'idle') this.phase = { name: 'spent' };
      this.lastTap = undefined;
      return NOTHING;
    }

    this.phase = { name: 'idle' };
    // A scrub has already placed the selection; only an unmoved touch still owes one.
    const tap = phase.name === 'select' && !phase.moved;
    // A long press still selects, but it is too slow to be half of a double tap.
    this.lastTap = tap && atMs - phase.startMs <= TAP_MS ? { x: phase.startX, ms: atMs } : undefined;
    return tap ? { kind: 'select', x: phase.startX } : NOTHING;
  }

  private isDoubleTap(finger: Finger, atMs: number): boolean {
    const tap = this.lastTap;
    return (
      tap !== undefined &&
      atMs - tap.ms <= DOUBLE_TAP_MS &&
      Math.abs(finger.x - tap.x) <= TAP_SLOP_PX
    );
  }
}

/** The instant a finger lands on, which it then holds for the rest of the gesture. */
function gripAt(finger: Finger, frame: PlotFrame): Grip {
  const { view, width } = frame;
  return { id: finger.id, t: view.min + (finger.x / width) * (view.max - view.min) };
}

/**
 * The View that puts both grips back under their fingers: the fingers' distance apart
 * fixes the span (further apart = tighter window), and their midpoint fixes where that
 * span sits. Clamped to the zoom limits, then slid back inside the data.
 */
function movedView(phase: MovePhase, a: Finger, b: Finger): ChartView {
  const { frame } = phase;
  const apartPx = Math.abs(b.x - a.x);
  // Fingers on top of each other carry no scale information; hold the span they had.
  const rawSpan =
    apartPx < 1
      ? frame.view.max - frame.view.min
      : (Math.abs(phase.b.t - phase.a.t) / apartPx) * frame.width;

  const span = clampSpan(rawSpan, frame.widest);
  const midT = (phase.a.t + phase.b.t) / 2;
  const midPx = (a.x + b.x) / 2;
  return slideInside(midT - (midPx / frame.width) * span, span, frame.widest);
}

/** Zoom limits: 30 minutes at the tightest, the widest View at the widest. */
function clampSpan(span: number, widest: ChartView): number {
  const most = Math.max(widest.max - widest.min, MIN_VIEW_SPAN_S);
  return Math.min(Math.max(span, MIN_VIEW_SPAN_S), most);
}

/** The pan hard-stop: slide a span of View back inside the data, never resizing it. */
function slideInside(min: number, span: number, widest: ChartView): ChartView {
  const latest = Math.max(widest.min, widest.max - span);
  const start = Math.min(Math.max(min, widest.min), latest);
  return { min: start, max: start + span };
}
