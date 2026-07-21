<script lang="ts">
  /*
   * The one-screen dashboard (ticket 10), now a thin presentation shell over the
   * Fleet seam (ticket 11b). This is the untestable UI seam per ADR-0004: it wires
   * the tested pure modules together and owns nothing correctness-critical. The whole
   * multi-Pod lifecycle — known Pods keyed by ID, auto-selection, Live-reading fan-in,
   * disconnect handling, persistence load, persistent pairing, and the
   * connect/Sync/reconnect orchestration — lives in the tested `Fleet`. What remains
   * here is pure presentation: the range/temp/humidity preferences, the dashboard.ts
   * transforms, text formatting, and the production FleetDeps wiring.
   *   - Live reading  → CO₂-hero (colour-banded) + secondary temp/humidity.
   *   - Per-Pod History → uPlot timeseries over a selectable range.
   */
  import Chart from "./lib/Chart.svelte";
  import {
    co2Band,
    RANGES,
    selectRange,
    toPlotData,
    type PlotData,
    type Range,
  } from "./lib/dashboard";
  import { deleteHistory, History, listPodIds } from "./lib/history";
  import { Fleet } from "./lib/fleet";
  import { connectPod, reconnectPods } from "./lib/transport";

  const supported =
    typeof navigator !== "undefined" && "bluetooth" in navigator;

  // The Fleet owns the whole multi-Pod lifecycle behind its tested interface. Wire it
  // with production FleetDeps: the real transport/history functions, a no-op reconnect
  // where Web Bluetooth is absent (the real one reaches for navigator), the ambient
  // timer for the auto-sync loop, and localStorage for selection persistence.
  const fleet = new Fleet({
    connectPod,
    reconnectPods: supported ? reconnectPods : () => {},
    listPodIds,
    makeHistory: (id) => new History(id),
    schedule: (cb, everyMs) => {
      const handle = setInterval(cb, everyMs);
      return () => clearInterval(handle);
    },
    selectionStore: localStorage,
    deleteHistory,
  });

  // Map Fleet's two change signals to two $state counters. Only the History counter
  // feeds the chart's $derived, so a Live reading refreshes the hero number without
  // rebuilding the chart or resetting uPlot's zoom.
  let historyVersion = $state(0); // bumps when a Merge completes
  let stateVersion = $state(0); // bumps on selection/connection/live/busy/error
  fleet.onHistoryChange = () => historyVersion++;
  fleet.onStateChange = () => stateVersion++;

  let range = $state<Range>(RANGES[1]); // default to 24h
  let showTemp = $state(false);
  let showHumidity = $state(false);

  // Read Fleet through its getters. `tracked` wraps a getter read so it first touches
  // stateVersion, re-reading the getter after every state change — the same "establish
  // the dependency" idiom the chart's plotData uses below for historyVersion.
  const tracked = <T,>(read: () => T): (() => T) => () => {
    stateVersion; // touch the state signal to establish the reactive dependency
    return read();
  };
  const knownPodIds = $derived.by(tracked(() => fleet.knownPodIds));
  const selectedPodId = $derived.by(tracked(() => fleet.selectedPodId));
  const selectedHistory = $derived.by(tracked(() => fleet.selectedHistory));
  const live = $derived.by(tracked(() => fleet.live));
  const connected = $derived.by(tracked(() => fleet.connected));
  const busy = $derived.by(tracked(() => fleet.busy));
  const error = $derived.by(tracked(() => fleet.error));

  const band = $derived(live ? co2Band(live.co2) : null);

  const plotData = $derived.by<PlotData>(() => {
    historyVersion; // establish the dependency: recompute after each Merge
    if (!selectedHistory) return [[], [], [], []];
    return toPlotData(
      selectRange(selectedHistory.samples(), range.ms, Date.now()),
    );
  });
  const hasHistory = $derived(plotData[0].length > 0);

  const co2Text = $derived(live ? String(live.co2) : "––");
  const tempText = $derived(live ? `${(live.temp / 100).toFixed(1)} °C` : "––");
  const humidityText = $derived(
    live ? `${Math.round(live.humidity / 100)} %` : "––",
  );
</script>

<main>
  <header>
    {#if knownPodIds.length > 1}
      <select
        value={selectedPodId}
        onchange={(e) => fleet.select(e.currentTarget.value)}
        aria-label="Pod"
      >
        {#each knownPodIds as id (id)}
          <option value={id}>{id.slice(0, 8)}</option>
        {/each}
      </select>
    {/if}
  </header>

  {#if !supported}
    <p class="notice">
      Web Bluetooth isn't available in this browser. Use Chrome or Edge.
    </p>
  {/if}

  <section class="hero" style={band ? `--band: ${band.color}` : undefined}>
    <div class="co2">
      <span class="value">{co2Text}</span>
      <span class="unit">ppm CO₂</span>
    </div>
    {#if band}
      <span class="verdict">{band.label}</span>
    {:else}
      <span class="verdict muted"
        >{connected ? "Waiting for a reading…" : "Not connected"}</span
      >
    {/if}
    <div class="secondary">
      <span>{tempText}</span>
      <span>{humidityText} RH</span>
    </div>
  </section>

  <section class="controls">
    <button onclick={() => fleet.connect()} disabled={!supported || busy}>
      {busy ? "Working…" : "Connect a Pod"}
    </button>
    {#if connected}
      <button onclick={() => fleet.sync()} disabled={busy}>Sync</button>
    {/if}
  </section>

  {#if error}
    <p class="notice error">{error}</p>
  {/if}

  <section class="chart-panel">
    <div class="range">
      {#each RANGES as r (r.label)}
        <button
          class:selected={r.label === range.label}
          onclick={() => (range = r)}>{r.label}</button
        >
      {/each}
      <label><input type="checkbox" bind:checked={showTemp} /> Temp</label>
      <label
        ><input type="checkbox" bind:checked={showHumidity} /> Humidity</label
      >
    </div>
    {#if hasHistory}
      <Chart
        data={plotData}
        co2Color={band?.color ?? "#3fb950"}
        {showTemp}
        {showHumidity}
      />
    {:else}
      <p class="notice muted">
        No history yet — Connect a Pod and Sync to build the chart.
      </p>
    {/if}
  </section>
</main>

<style>
  main {
    width: min(720px, 92vw);
    padding: 1.5rem 0 2.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
  }

  select {
    background: #161b22;
    color: #e6edf3;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 0.25rem 0.5rem;
  }

  .hero {
    --band: #8b949e;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.4rem;
    padding: 1.5rem 1rem;
    background: #0f141b;
    border: 1px solid #21262d;
    border-radius: 14px;
  }

  .co2 {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }

  .value {
    font-size: 4.5rem;
    font-weight: 700;
    line-height: 1;
    color: var(--band);
    font-variant-numeric: tabular-nums;
  }

  .unit {
    font-size: 1rem;
    opacity: 0.65;
  }

  .verdict {
    font-size: 1rem;
    font-weight: 600;
    color: var(--band);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .secondary {
    display: flex;
    gap: 1.5rem;
    margin-top: 0.4rem;
    opacity: 0.75;
    font-variant-numeric: tabular-nums;
  }

  .controls {
    display: flex;
    gap: 0.75rem;
    justify-content: center;
  }

  button {
    background: #21262d;
    color: #e6edf3;
    border: 1px solid #30363d;
    border-radius: 8px;
    padding: 0.5rem 1rem;
    font-size: 0.95rem;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    background: #2a3038;
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .chart-panel {
    background: #0f141b;
    border: 1px solid #21262d;
    border-radius: 14px;
    padding: 1rem;
  }

  .range {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .range button {
    padding: 0.3rem 0.7rem;
    font-size: 0.85rem;
  }

  .range button.selected {
    border-color: #58a6ff;
    color: #58a6ff;
  }

  .range label {
    font-size: 0.85rem;
    opacity: 0.8;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    margin-left: 0.25rem;
  }

  .notice {
    text-align: center;
    margin: 0;
    opacity: 0.8;
  }

  .notice.error {
    color: #f85149;
  }

  .muted {
    opacity: 0.55;
  }
</style>
