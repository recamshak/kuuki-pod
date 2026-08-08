import { describe, expect, it } from 'vitest';
import { TouchGestures, widestView, type Finger, type PlotFrame } from './gestures';
import type { ChartView } from './dashboard';

// The chart's touch gesture machine (ticket 16b). This is the whole decision layer of
// the touch UX — which gesture is in progress, where the View lands, where the
// selection sits — so it is where the gestures are pinned down. Chart.svelte only
// feeds it finger positions and applies what it returns.

const NOW = 1_700_000_000; // unix seconds, the chart's x unit
const HOUR = 3600;
const WIDTH = 1000; // plot area, in CSS px

/** The full History: 30 days of Samples behind "now". */
const FULL: ChartView = { min: NOW - 720 * HOUR, max: NOW };

const NOTHING = { kind: 'none' };

function frame(view: ChartView, widest: ChartView = FULL): PlotFrame {
  return { width: WIDTH, view, widest };
}

function f(id: number, x: number): Finger {
  return { id, x };
}

/** Put two fingers down the way a browser does: one touchstart, then a second. */
function pinchStart(g: TouchGestures, fr: PlotFrame, ax: number, bx: number, atMs = 0): void {
  g.down([f(1, ax)], fr, atMs);
  g.down([f(1, ax), f(2, bx)], fr, atMs + 20);
}

describe('widestView', () => {
  const T0 = NOW * 1000;

  it('reaches from the oldest Sample to now', () => {
    const xs = [NOW - 100 * HOUR, NOW - 50 * HOUR, NOW - HOUR];
    expect(widestView(xs, T0)).toEqual({ min: NOW - 100 * HOUR, max: NOW });
  });

  it('never shrinks below the window the chart opens on', () => {
    // A Pod Synced for the first time: two hours of History must not collapse the View.
    expect(widestView([NOW - 2 * HOUR, NOW], T0)).toEqual({ min: NOW - 24 * HOUR, max: NOW });
  });

  it('is the opening window when there are no Samples at all', () => {
    expect(widestView([], T0)).toEqual({ min: NOW - 24 * HOUR, max: NOW });
  });
});

describe('one finger', () => {
  const view24 = frame({ min: NOW - 24 * HOUR, max: NOW });

  it('selects where a tap landed, on lift', () => {
    // Not on touchdown: an uncommitted touch is what lets a pinch start without
    // dragging the selection to its first finger.
    const g = new TouchGestures();
    expect(g.down([f(1, 200)], view24, 0)).toEqual(NOTHING);
    expect(g.up([], 80)).toEqual({ kind: 'select', x: 200 });
  });

  it('ignores a wobble within the tap slop', () => {
    const g = new TouchGestures();
    g.down([f(1, 200)], view24, 0);
    expect(g.move([f(1, 206)])).toEqual(NOTHING);
    expect(g.up([], 80)).toEqual({ kind: 'select', x: 200 });
  });

  it('sweeps the selection with the finger once it is a drag', () => {
    const g = new TouchGestures();
    g.down([f(1, 200)], view24, 0);
    expect(g.move([f(1, 350)])).toEqual({ kind: 'select', x: 350 });
    expect(g.move([f(1, 420)])).toEqual({ kind: 'select', x: 420 });
    // The last sweep already placed it; lifting only pins what is there.
    expect(g.up([], 200)).toEqual(NOTHING);
  });

  it('pins the selection on lift: nothing follows the lifted finger', () => {
    const g = new TouchGestures();
    g.down([f(1, 200)], view24, 0);
    g.move([f(1, 350)]);
    g.up([], 100);
    expect(g.move([f(1, 600)])).toEqual(NOTHING);
  });

  it('moves the pinned selection on the next touch', () => {
    const g = new TouchGestures();
    g.down([f(1, 200)], view24, 0);
    g.up([], 100);
    g.down([f(2, 700)], view24, 5000);
    expect(g.up([], 5080)).toEqual({ kind: 'select', x: 700 });
  });

  it('selects after a long press, without arming a double tap', () => {
    const g = new TouchGestures();
    g.down([f(1, 300)], view24, 0);
    expect(g.up([], 2000)).toEqual({ kind: 'select', x: 300 });
    g.down([f(2, 300)], view24, 2100);
    expect(g.up([], 2180)).toEqual({ kind: 'select', x: 300 });
  });

  it('never moves the View', () => {
    const g = new TouchGestures();
    g.down([f(1, 200)], view24, 0);
    expect(g.move([f(1, 900)])).toEqual({ kind: 'select', x: 900 });
  });
});

describe('two fingers', () => {
  it('zooms in around the point between the fingers', () => {
    // A 24 h View across 1000 px: the fingers hold NOW-14.4h and NOW-9.6h, and
    // spreading them from 200 px to 400 px apart halves the span to 12 h about their
    // unmoved midpoint (px 500, NOW-12h).
    const g = new TouchGestures();
    pinchStart(g, frame({ min: NOW - 24 * HOUR, max: NOW }), 400, 600);
    expect(g.move([f(1, 300), f(2, 700)])).toEqual({
      kind: 'view',
      view: { min: NOW - 18 * HOUR, max: NOW - 6 * HOUR },
    });
  });

  it('zooms out around the point between the fingers', () => {
    // The mirror image: 200 px apart down to 100 px doubles a 24 h span to 48 h.
    const g = new TouchGestures();
    pinchStart(g, frame({ min: NOW - 60 * HOUR, max: NOW - 36 * HOUR }), 400, 600);
    expect(g.move([f(1, 450), f(2, 550)])).toEqual({
      kind: 'view',
      view: { min: NOW - 72 * HOUR, max: NOW - 24 * HOUR },
    });
  });

  it('stops zooming in at the tightest 30-minute window', () => {
    // Fingers 720 s apart in a 1 h View, spread to 800 px: the raw span is 15 min, and
    // the clamped 30 min stays centred on the fingers' midpoint (px 500, NOW-1800).
    const g = new TouchGestures();
    pinchStart(g, frame({ min: NOW - HOUR, max: NOW }), 400, 600);
    expect(g.move([f(1, 100), f(2, 900)])).toEqual({
      kind: 'view',
      view: { min: NOW - 2700, max: NOW - 900 },
    });
  });

  it('stops zooming out at the widest View', () => {
    // Pinched down to 2 px apart the raw span is 2400 h; the History is 720 h, and a
    // View that wide can only be the History itself.
    const g = new TouchGestures();
    pinchStart(g, frame({ min: NOW - 24 * HOUR, max: NOW }), 400, 600);
    expect(g.move([f(1, 499), f(2, 501)])).toEqual({ kind: 'view', view: FULL });
  });

  it('pans by dragging both fingers, keeping the span', () => {
    // Both fingers 100 px right drags the data right: the View moves 2.4 h earlier.
    const g = new TouchGestures();
    pinchStart(g, frame({ min: NOW - 36 * HOUR, max: NOW - 12 * HOUR }), 400, 600);
    expect(g.move([f(1, 500), f(2, 700)])).toEqual({
      kind: 'view',
      view: { min: NOW - 38.4 * HOUR, max: NOW - 14.4 * HOUR },
    });
  });

  it('hard-stops the pan at "now"', () => {
    const g = new TouchGestures();
    pinchStart(g, frame({ min: NOW - 26 * HOUR, max: NOW - 2 * HOUR }), 400, 600);
    expect(g.move([f(1, 200), f(2, 400)])).toEqual({
      kind: 'view',
      view: { min: NOW - 24 * HOUR, max: NOW },
    });
  });

  it('hard-stops the pan at the oldest Sample', () => {
    const g = new TouchGestures();
    pinchStart(g, frame({ min: NOW - 716 * HOUR, max: NOW - 692 * HOUR }), 400, 600);
    expect(g.move([f(1, 800), f(2, 1000)])).toEqual({
      kind: 'view',
      view: { min: NOW - 720 * HOUR, max: NOW - 696 * HOUR },
    });
  });
});

describe('handoffs', () => {
  const view24 = frame({ min: NOW - 24 * HOUR, max: NOW });

  it('leaves the selection alone when a pinch begins', () => {
    // The two fingers of a pinch never land at the same instant; the first must not
    // drag the selection on its way to becoming half a pinch.
    const g = new TouchGestures();
    expect(g.down([f(1, 400)], view24, 0)).toEqual(NOTHING);
    expect(g.move([f(1, 404)])).toEqual(NOTHING);
    expect(g.down([f(1, 404), f(2, 620)], view24, 30)).toEqual(NOTHING);
    expect(g.move([f(1, 404), f(2, 720)])).toMatchObject({ kind: 'view' });
  });

  it('freezes a scrub the moment a second finger lands', () => {
    const g = new TouchGestures();
    g.down([f(1, 400)], view24, 0);
    expect(g.move([f(1, 420)])).toEqual({ kind: 'select', x: 420 });
    expect(g.down([f(1, 420), f(2, 620)], view24, 30)).toEqual(NOTHING);
    // From here the fingers only move the View; the selection stays where it froze.
    expect(g.move([f(1, 420), f(2, 720)])).toMatchObject({ kind: 'view' });
  });

  it('ends the gesture when a finger lifts: the survivor never scrubs', () => {
    const g = new TouchGestures();
    pinchStart(g, view24, 400, 600);
    expect(g.move([f(1, 300), f(2, 700)])).toMatchObject({ kind: 'view' });
    expect(g.up([f(1, 300)], 200)).toEqual(NOTHING);
    expect(g.move([f(1, 100)])).toEqual(NOTHING);
    expect(g.up([], 260)).toEqual(NOTHING);
  });

  it('starts fresh once every finger is off the chart', () => {
    const g = new TouchGestures();
    pinchStart(g, view24, 400, 600);
    g.move([f(1, 300), f(2, 700)]);
    g.up([f(1, 300)], 200);
    g.up([], 260);
    g.down([f(3, 500)], view24, 5000);
    expect(g.up([], 5080)).toEqual({ kind: 'select', x: 500 });
  });

  it('ignores a finger landing after the gesture has ended', () => {
    const g = new TouchGestures();
    pinchStart(g, view24, 400, 600);
    g.up([f(1, 400)], 200);
    expect(g.down([f(1, 400), f(4, 800)], view24, 220)).toEqual(NOTHING);
    expect(g.move([f(1, 300), f(4, 900)])).toEqual(NOTHING);
  });
});

describe('double tap', () => {
  const view24 = frame({ min: NOW - 24 * HOUR, max: NOW });

  it('resets the View, without selecting or scrubbing', () => {
    const g = new TouchGestures();
    g.down([f(1, 300)], view24, 0);
    g.up([], 60);
    expect(g.down([f(2, 304)], view24, 200)).toEqual({ kind: 'reset' });
    expect(g.move([f(2, 500)])).toEqual(NOTHING);
    expect(g.up([], 260)).toEqual(NOTHING);
  });

  it('does not chain into a third tap', () => {
    const g = new TouchGestures();
    g.down([f(1, 300)], view24, 0);
    g.up([], 60);
    g.down([f(2, 300)], view24, 200);
    g.up([], 260);
    g.down([f(3, 300)], view24, 400);
    expect(g.up([], 460)).toEqual({ kind: 'select', x: 300 });
  });

  it('still lets a second finger pinch out of the reset', () => {
    const g = new TouchGestures();
    g.down([f(1, 300)], view24, 0);
    g.up([], 60);
    expect(g.down([f(2, 300)], view24, 200)).toEqual({ kind: 'reset' });
    expect(g.down([f(2, 300), f(3, 500)], view24, 230)).toEqual(NOTHING);
    expect(g.move([f(2, 200), f(3, 600)])).toMatchObject({ kind: 'view' });
  });

  it('treats a slow second tap as a new selection', () => {
    const g = new TouchGestures();
    g.down([f(1, 300)], view24, 0);
    g.up([], 60);
    g.down([f(2, 300)], view24, 900);
    expect(g.up([], 960)).toEqual({ kind: 'select', x: 300 });
  });

  it('treats a second tap elsewhere as a new selection', () => {
    const g = new TouchGestures();
    g.down([f(1, 300)], view24, 0);
    g.up([], 60);
    g.down([f(2, 400)], view24, 200);
    expect(g.up([], 260)).toEqual({ kind: 'select', x: 400 });
  });

  it('is not armed by a scrub that ends where it began', () => {
    const g = new TouchGestures();
    g.down([f(1, 300)], view24, 0);
    g.move([f(1, 500)]);
    g.move([f(1, 302)]);
    g.up([], 60);
    g.down([f(2, 300)], view24, 200);
    expect(g.up([], 260)).toEqual({ kind: 'select', x: 300 });
  });
});
