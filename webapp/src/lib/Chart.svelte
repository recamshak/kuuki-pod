<script lang="ts">
  /*
   * Thin hand-wrapped uPlot (ADR-0004): CO₂, temperature and humidity against time,
   * all three always drawn, each on its own scale. It is fed the whole History; what
   * the user sees is the *view* — the x-range — which is this component's state
   * (ticket 16a), moved by gestures (ticket 16b). All data-shaping and every decision
   * worth testing lives in the pure `dashboard.ts` and `gestures.ts`; here is only the
   * imperative uPlot lifecycle: create once, push data without touching the view,
   * follow the live edge, turn touches into gestures, resize to the container, and
   * hand the CO₂ colour ramp to canvas as a gradient (ticket 18). It renders nothing
   * testable, by design.
   */
  import { untrack } from 'svelte';
  import uPlot from 'uplot';
  import 'uplot/dist/uPlot.min.css';
  import {
    CO2_RAMP,
    CO2_SWATCH_COLOR,
    defaultView,
    followLiveEdge,
    nearestX,
    scaleDomains,
    type ChartView,
    type PlotData,
  } from './dashboard';
  import { TouchGestures, widestView, type Finger, type GestureEffect, type PlotFrame } from './gestures';

  interface Props {
    data: PlotData;
  }

  let { data }: Props = $props();

  const HEIGHT = 260;
  const TEMP_COLOR = '#58a6ff';
  const HUMIDITY_COLOR = '#a371f7';

  /**
   * The flat colour each series shows wherever a gradient cannot go, keyed by uPlot's
   * series index (0 is the x series, which has no swatch). The legend key and the
   * selection dot are both DOM, where a `CanvasGradient` stringifies to `[object
   * CanvasGradient]` and the style assignment is dropped — leaving CO₂'s key an empty
   * box and its dot invisible. CO₂ sends the ramp's amber anchor; the other two send
   * the constant they are stroked with, which is what uPlot would have read anyway.
   */
  const SWATCH_COLORS: Record<number, string> = {
    1: CO2_SWATCH_COLOR,
    2: TEMP_COLOR,
    3: HUMIDITY_COLOR,
  };

  let container: HTMLDivElement;
  let plot: uPlot | undefined;
  // What the plot currently holds and how it draws it: the x column (whose last entry
  // is the live edge, and into which a selection snaps), the y-domain each series is
  // drawn against, and the selected Sample's x. Plain variables, deliberately not
  // reactive: all are written from effects or touch handlers and read from uPlot
  // callbacks that must not re-run those effects. `untrack` is what tells svelte-check
  // that capturing only the initial props here is the intent — the effects at the
  // bottom keep them current.
  let plottedXs: number[] = untrack(() => data[0]);
  // Recomputed once per Merge by the data effect below, never during a gesture: uPlot
  // asks for a range on every re-range, and scanning three full columns on each frame
  // of a pinch would be both wasteful and a decision living in this untestable seam.
  let yDomains = untrack(() => scaleDomains(data));
  let selectedX: number | undefined;

  function makeOptions(width: number): uPlot.Options {
    return {
      width,
      height: HEIGHT,
      // A dark, unobtrusive grid to match the app shell.
      axes: [
        { stroke: '#8b949e', grid: { stroke: '#21262d' }, ticks: { stroke: '#21262d' } },
        {
          scale: 'co2',
          stroke: '#8b949e',
          grid: { stroke: '#21262d' },
          ticks: { stroke: '#21262d' },
        },
        { scale: '°C', side: 1, stroke: '#8b949e', grid: { show: false }, ticks: { stroke: '#21262d' } },
      ],
      // Each y-scale rests on its Scale base and only a Merge can move it (ticket 17),
      // so a pan or a pinch changes which slice of time is shown, never how tall a
      // value looks. The domains are decided in `dashboard.ts`; here we only read them.
      scales: {
        x: { time: true },
        co2: { range: () => yDomains.co2 },
        '°C': { range: () => yDomains['°C'] },
        '%RH': { range: () => yDomains['%RH'] },
      },
      series: [
        {},
        { label: 'CO₂', scale: 'co2', stroke: co2Gradient, width: 2, value: (_u, v) => fmt(v, 'ppm') },
        { label: 'Temp', scale: '°C', stroke: TEMP_COLOR, width: 1, value: (_u, v) => fmt(v, '°C') },
        {
          label: 'Humidity',
          scale: '%RH',
          stroke: HUMIDITY_COLOR,
          width: 1,
          value: (_u, v) => fmt(v, '%'),
        },
      ],
      // uPlot builds each key as a CSS border *string*, so the series' own stroke would
      // reach it as `[object CanvasGradient]`; hand it the swatch colour instead.
      legend: { live: true, markers: { stroke: (_u, i) => SWATCH_COLORS[i] } },
      cursor: {
        // No horizontal crosshair: across three independent y-scales it marks nothing,
        // and a pinned touch selection would strand it at whatever height the finger
        // was lifted from.
        y: false,
        drag: { x: true, y: false },
        // The selection dots are DOM too, and default to the series' cached stroke.
        points: { fill: (_u, i) => SWATCH_COLORS[i], stroke: (_u, i) => SWATCH_COLORS[i] },
        // Replaces uPlot's built-in "double-click zooms out to the data extent" with the
        // app's reset — the escape hatch that took over from the deleted range buttons.
        // Its touch twin, the double-tap, is detected in gestures.ts instead: swallowing
        // touchstart means the browser never synthesises a dblclick from one.
        bind: {
          dblclick: () => () => {
            if (plot) resetView(plot);
            return null;
          },
        },
      },
      hooks: {
        // Re-place a pinned selection on every draw: it marks a Sample, not a pixel, so
        // after a pan or a zoom the cursor must follow the Sample the user picked rather
        // than whatever has slid under it.
        draw: [showSelection],
      },
    };
  }

  function fmt(v: number | null, unit: string): string {
    return v == null ? '--' : `${v} ${unit}`;
  }

  /**
   * The CO₂ line's colour: the ramp painted in **value space**, so a Sample's colour
   * follows its ppm and nothing else — the gradient moves with the axis, and a pan or a
   * zoom cannot recolour a point. uPlot calls this from `drawSeries`, after the
   * geometry is settled, and rebuilding it on every draw is what keeps it correct
   * across a resize or a re-range with no cache to go stale. Canvas gradients extend
   * their end stops, so the ramp's clamp comes free even when a record spike widens the
   * domain past 2000 ppm.
   */
  function co2Gradient(u: uPlot): CanvasGradient {
    const lo = CO2_RAMP[0];
    const hi = CO2_RAMP[CO2_RAMP.length - 1];
    const gradient = u.ctx.createLinearGradient(
      0,
      u.valToPos(lo.ppm, 'co2', true),
      0,
      u.valToPos(hi.ppm, 'co2', true),
    );
    for (const stop of CO2_RAMP) gradient.addColorStop(stop.offset, stop.color);
    return gradient;
  }

  /** uPlot's current x-range, once it has one. */
  function viewOf(u: uPlot): ChartView | undefined {
    const { min, max } = u.scales.x;
    return min == null || max == null ? undefined : { min, max };
  }

  /** Back to the window the chart opens on: the last 24 h, right edge at "now". */
  function resetView(u: uPlot): void {
    u.setScale('x', defaultView(Date.now()));
  }

  /**
   * Put uPlot's cursor on the selected Sample: vertical line, per-series dots, and the
   * legend's values. Nothing ever clears it — the selection is sticky, and the next
   * one-finger touch simply moves it.
   */
  function showSelection(u: uPlot): void {
    if (selectedX === undefined) return;
    u.setCursor({ left: u.valToPos(selectedX, 'x'), top: u.over.clientHeight / 2 }, false);
  }

  /** Carry out what the gesture machine decided. */
  function apply(u: uPlot, effect: GestureEffect): void {
    switch (effect.kind) {
      case 'select':
        selectedX = nearestX(plottedXs, u.posToVal(effect.x, 'x'));
        showSelection(u);
        break;
      case 'view':
        u.setScale('x', effect.view);
        break;
      case 'reset':
        resetView(u);
        break;
      case 'none':
        break;
    }
  }

  /**
   * Hang the touch layer (gestures.ts) off uPlot's overlay; returns the detach. Touches
   * are swallowed, not merely handled: `preventDefault` on touchstart and touchmove is
   * what keeps the page from scrolling or zooming under a gesture, and what stops the
   * browser synthesising the compatibility mouse events that would otherwise feed a
   * one-finger touch to uPlot's mouse-only drag-zoom.
   */
  function attachTouch(u: uPlot): () => void {
    const gestures = new TouchGestures();
    const over = u.over;

    function fingers(e: TouchEvent): Finger[] {
      const { left } = over.getBoundingClientRect();
      return Array.from(e.touches, (t) => ({ id: t.identifier, x: t.clientX - left }));
    }

    function frame(): PlotFrame {
      return {
        width: over.clientWidth,
        view: viewOf(u) ?? defaultView(Date.now()),
        widest: widestView(plottedXs, Date.now()),
      };
    }

    function onStart(e: TouchEvent): void {
      e.preventDefault();
      apply(u, gestures.down(fingers(e), frame(), e.timeStamp));
    }

    function onMove(e: TouchEvent): void {
      e.preventDefault();
      apply(u, gestures.move(fingers(e)));
    }

    function onEnd(e: TouchEvent): void {
      apply(u, gestures.up(fingers(e), e.timeStamp));
    }

    over.addEventListener('touchstart', onStart, { passive: false });
    over.addEventListener('touchmove', onMove, { passive: false });
    over.addEventListener('touchend', onEnd);
    over.addEventListener('touchcancel', onEnd);

    return () => {
      over.removeEventListener('touchstart', onStart);
      over.removeEventListener('touchmove', onMove);
      over.removeEventListener('touchend', onEnd);
      over.removeEventListener('touchcancel', onEnd);
    };
  }

  // Create the plot once, on mount, opening on the last 24 h. `untrack` keeps the props
  // out of this effect's dependencies: re-running it would destroy the uPlot instance and
  // with it the user's view, so data and colour are pushed imperatively by the effects
  // below instead. Tear down on unmount.
  $effect(() => {
    if (!container) return;
    const u = untrack(() => new uPlot(makeOptions(container.clientWidth), data, container));
    resetView(u);
    plot = u;

    const detachTouch = attachTouch(u);
    const ro = new ResizeObserver(() => {
      u.setSize({ width: container.clientWidth, height: HEIGHT });
    });
    ro.observe(container);

    return () => {
      detachTouch();
      ro.disconnect();
      u.destroy();
      plot = undefined;
    };
  });

  // Push the History a Merge just grew, keeping the view where it is — except at the live
  // edge, where it slides forward with the fresh Samples. The one writer of the y-domain
  // cache, so it can never go stale relative to the data it was computed from; setting
  // the x-scale is also what makes uPlot ask the y-scales for their range again.
  $effect(() => {
    const next = data;
    const u = plot;
    if (!u) return;
    const view = viewOf(u);
    const before = plottedXs.at(-1); // the live edge: the newest x the plot held
    plottedXs = next[0];
    yDomains = scaleDomains(next);
    u.setData(next, false);
    if (view) u.setScale('x', followLiveEdge(view, before, plottedXs.at(-1)));
  });
</script>

<div class="chart" bind:this={container}></div>

<style>
  .chart {
    width: 100%;
    /* Gestures belong to the chart: the browser must not scroll or zoom the page under
       a pinch, a two-finger drag, or a scrub. */
    touch-action: none;
  }

  /* uPlot's default legend sits inline; give it room and match the app palette. */
  .chart :global(.u-legend) {
    color: #8b949e;
    font-size: 0.85rem;
  }
</style>
