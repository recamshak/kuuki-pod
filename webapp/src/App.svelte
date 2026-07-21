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
  import PodPicker, { type PickerPod } from "./lib/PodPicker.svelte";
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
  import { Names } from "./lib/names";
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

  // Per-Pod human-readable labels (names.ts), built alongside the Fleet with the same
  // production localStorage. Resolving a name reads localStorage, which Svelte can't
  // track, so a rename/first-name bumps `namesVersion` to recompute the picker list.
  const names = new Names({ store: localStorage });
  let namesVersion = $state(0);

  // Map Fleet's two change signals to two $state counters. Only the History counter
  // feeds the chart's $derived, so a Live reading refreshes the hero number without
  // rebuilding the chart or resetting uPlot's zoom.
  let historyVersion = $state(0); // bumps when a Merge completes
  let stateVersion = $state(0); // bumps on selection/connection/live/busy/error
  fleet.onHistoryChange = () => historyVersion++;
  fleet.onStateChange = () => stateVersion++;

  // First-connect naming: the one time a genuinely new Pod registers, prompt for a
  // name. Fleet fires this exactly once per new Pod (never on reload of a persisted-
  // but-unnamed Pod), so a plain prompt here is enough; guard on hasName so a Pod the
  // user already named some other way is left alone.
  fleet.onNewPod = (id) => {
    if (names.hasName(id)) return;
    const answer = window.prompt("Name this Pod");
    if (answer) {
      names.setName(id, answer);
      namesVersion++;
    }
  };

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
  const fleetPods = $derived.by(tracked(() => fleet.pods));
  const selectedPodId = $derived.by(tracked(() => fleet.selectedPodId));
  const selectedHistory = $derived.by(tracked(() => fleet.selectedHistory));
  const live = $derived.by(tracked(() => fleet.live));
  const connected = $derived.by(tracked(() => fleet.connected));
  const syncing = $derived.by(tracked(() => fleet.syncing));
  const error = $derived.by(tracked(() => fleet.error));

  const pickerPods = $derived.by<PickerPod[]>(() => {
    namesVersion; // establish the dependency: recompute after a rename
    return fleetPods.map((p) => ({
      id: p.id,
      name: names.getName(p.id),
      connected: p.connected,
    }));
  });

  // Rename lives in the parent (the picker only emits the intent, ticket 12e/12f):
  // prompt seeded with the current label, persist a non-blank answer, and recompute.
  function renamePod(id: string): void {
    const answer = window.prompt("Rename Pod", names.getName(id));
    if (answer === null) return; // cancelled
    names.setName(id, answer);
    namesVersion++;
  }

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
    <PodPicker
      pods={pickerPods}
      selectedId={selectedPodId}
      onSelect={(id) => fleet.select(id)}
      onConnect={() => fleet.connect()}
      onForget={(id) => {
        fleet.remove(id);
        names.forget(id);
      }}
      onRename={renamePod}
    />
  </header>

  {#if !supported}
    <p class="notice">
      Web Bluetooth isn't available in this browser. Use Chrome or Edge.
    </p>
  {/if}

  <section
    class="hero"
    class:stale={!connected}
    style={band ? `--band: ${band.color}` : undefined}
  >
    {#if syncing}
      <span class="sync" title="Syncing…" aria-label="Syncing">
        <span class="spinner" aria-hidden="true"></span>
      </span>
    {/if}
    <div class="co2">
      <span class="value">{co2Text}</span>
      <span class="unit">ppm CO₂</span>
    </div>
    {#if !connected}
      <span class="verdict muted">Not connected</span>
    {:else if band}
      <span class="verdict">{band.label}</span>
    {:else}
      <span class="verdict muted">Waiting for a reading…</span>
    {/if}
    <div class="secondary">
      <span>{tempText}</span>
      <span>{humidityText} RH</span>
    </div>
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
        No history yet — connect a Pod to build the chart.
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

  .hero {
    --band: #8b949e;
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.4rem;
    padding: 1.5rem 1rem;
    background: #0f141b;
    border: 1px solid #21262d;
    border-radius: 14px;
  }

  /* Disconnected: the last reading stays on screen but visibly stale. */
  .hero.stale .co2,
  .hero.stale .secondary {
    opacity: 0.4;
  }

  /* Small spinner in the hero corner, only while the selected Pod is mid-sync. */
  .sync {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    display: inline-flex;
  }

  .spinner {
    width: 0.9rem;
    height: 0.9rem;
    border: 2px solid #30363d;
    border-top-color: #58a6ff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
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
