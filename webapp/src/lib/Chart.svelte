<script lang="ts">
  /*
   * Thin hand-wrapped uPlot (ADR-0004): CO₂, temperature and humidity against time,
   * all three always drawn, each on its own scale. It is fed the whole History; what
   * the user sees is the *view* — the x-range — which is this component's state
   * (ticket 16a). All data-shaping and every view decision worth testing live in the
   * pure `dashboard.ts`; here is only the imperative uPlot lifecycle: create once,
   * push data without touching the view, follow the live edge, reset on double-click,
   * and resize to the container. It renders nothing testable, by design.
   */
  import { untrack } from 'svelte';
  import uPlot from 'uplot';
  import 'uplot/dist/uPlot.min.css';
  import { defaultView, followLiveEdge, type ChartView, type PlotData } from './dashboard';

  interface Props {
    data: PlotData;
    co2Color: string;
  }

  let { data, co2Color }: Props = $props();

  const HEIGHT = 260;

  let container: HTMLDivElement;
  let plot: uPlot | undefined;
  // The newest x the plot currently holds, and the band colour it draws CO₂ with. Plain
  // variables, deliberately not reactive: both are written from effects and read from a
  // uPlot callback that must not re-run those effects. `untrack` is what tells
  // svelte-check that capturing only the initial colour here is the intent — the effect
  // at the bottom keeps it current.
  let plottedX: number | undefined;
  let strokeCo2 = untrack(() => co2Color);

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
      scales: { x: { time: true }, co2: {}, '°C': {}, '%RH': {} },
      series: [
        {},
        // uPlot re-evaluates a stroke callback on every draw, so the band colour can
        // change with a redraw instead of a rebuild that would throw the view away.
        { label: 'CO₂', scale: 'co2', stroke: () => strokeCo2, width: 2, value: (_u, v) => fmt(v, 'ppm') },
        { label: 'Temp', scale: '°C', stroke: '#58a6ff', width: 1, value: (_u, v) => fmt(v, '°C') },
        { label: 'Humidity', scale: '%RH', stroke: '#a371f7', width: 1, value: (_u, v) => fmt(v, '%') },
      ],
      legend: { live: true },
      cursor: {
        drag: { x: true, y: false },
        // Replaces uPlot's built-in "double-click zooms out to the data extent" with the
        // app's reset — the escape hatch that took over from the deleted range buttons.
        // Browsers synthesise dblclick from a double-tap, so this covers touch too.
        bind: {
          dblclick: () => () => {
            plot?.setScale('x', defaultView(Date.now()));
            return null;
          },
        },
      },
    };
  }

  function fmt(v: number | null, unit: string): string {
    return v == null ? '--' : `${v} ${unit}`;
  }

  /** uPlot's current x-range, once it has one. */
  function viewOf(u: uPlot): ChartView | undefined {
    const { min, max } = u.scales.x;
    return min == null || max == null ? undefined : { min, max };
  }

  // Create the plot once, on mount, opening on the last 24 h. `untrack` keeps the props
  // out of this effect's dependencies: re-running it would destroy the uPlot instance and
  // with it the user's view, so data and colour are pushed imperatively by the effects
  // below instead. Tear down on unmount.
  $effect(() => {
    if (!container) return;
    const u = untrack(() => new uPlot(makeOptions(container.clientWidth), data, container));
    u.setScale('x', defaultView(Date.now()));
    plot = u;

    const ro = new ResizeObserver(() => {
      u.setSize({ width: container.clientWidth, height: HEIGHT });
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      u.destroy();
      plot = undefined;
    };
  });

  // Push the History a Merge just grew, keeping the view where it is — except at the live
  // edge, where it slides forward with the fresh Samples.
  $effect(() => {
    const next = data;
    const u = plot;
    if (!u) return;
    const view = viewOf(u);
    const before = plottedX;
    plottedX = next[0].at(-1); // the live edge: the newest x in the columns
    u.setData(next, false);
    if (view) u.setScale('x', followLiveEdge(view, before, plottedX));
  });

  // Recolour the CO₂ line when the live reading crosses a band, without a rebuild.
  // `redraw(false)` repaints from the cached paths — a bare `redraw()` would re-apply
  // the committed x-scale and stomp on a view change still queued in uPlot.
  $effect(() => {
    strokeCo2 = co2Color;
    plot?.redraw(false);
  });
</script>

<div class="chart" bind:this={container}></div>

<style>
  .chart {
    width: 100%;
  }

  /* uPlot's default legend sits inline; give it room and match the app palette. */
  .chart :global(.u-legend) {
    color: #8b949e;
    font-size: 0.85rem;
  }
</style>
