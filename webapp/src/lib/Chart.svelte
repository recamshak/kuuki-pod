<script lang="ts">
  /*
   * Thin hand-wrapped uPlot (ADR-0004): a CO₂-vs-time line with temperature and
   * humidity as secondary, toggleable series. All data-shaping is done upstream
   * in the pure `toPlotData` (dashboard.ts); this component only owns the imperative
   * uPlot lifecycle — create once, `setData` on new data, `setSeries` on a toggle,
   * and resize to its container. It renders nothing testable, by design.
   */
  import uPlot from 'uplot';
  import 'uplot/dist/uPlot.min.css';
  import type { PlotData } from './dashboard';

  interface Props {
    data: PlotData;
    co2Color: string;
    showTemp: boolean;
    showHumidity: boolean;
  }

  let { data, co2Color, showTemp, showHumidity }: Props = $props();

  // Series indices into the aligned columns: 0 is x (time), then the three values.
  const CO2 = 1;
  const TEMP = 2;
  const RH = 3;

  let container: HTMLDivElement;
  let plot: uPlot | undefined;

  function makeOptions(width: number): uPlot.Options {
    return {
      width,
      height: 260,
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
        { label: 'CO₂', scale: 'co2', stroke: co2Color, width: 2, value: (_u, v) => fmt(v, 'ppm') },
        {
          label: 'Temp',
          scale: '°C',
          stroke: '#58a6ff',
          width: 1,
          show: showTemp,
          value: (_u, v) => fmt(v, '°C'),
        },
        {
          label: 'Humidity',
          scale: '%RH',
          stroke: '#a371f7',
          width: 1,
          show: showHumidity,
          value: (_u, v) => fmt(v, '%'),
        },
      ],
      legend: { live: true },
      cursor: { drag: { x: true, y: false } },
    };
  }

  function fmt(v: number | null, unit: string): string {
    return v == null ? '--' : `${v} ${unit}`;
  }

  // Create the plot once the container exists; tear it down on unmount.
  $effect(() => {
    if (!container) return;
    plot = new uPlot(makeOptions(container.clientWidth), data, container);

    const ro = new ResizeObserver(() => {
      if (plot) plot.setSize({ width: container.clientWidth, height: 260 });
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      plot?.destroy();
      plot = undefined;
    };
  });

  // Push new History data without recreating the plot (keeps zoom/cursor state).
  $effect(() => {
    plot?.setData(data);
  });

  // Reflect secondary-series toggles.
  $effect(() => {
    plot?.setSeries(TEMP, { show: showTemp });
    plot?.setSeries(RH, { show: showHumidity });
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
