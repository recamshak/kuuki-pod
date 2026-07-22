<script lang="ts">
  /*
   * The one-screen dashboard (ticket 10), now a thin presentation shell over the
   * Fleet seam (tickets 11b, 13). This is the untestable UI seam per ADR-0004: it
   * wires the tested pure modules together and owns nothing correctness-critical.
   * The whole multi-Pod lifecycle — known Pods keyed by ID, Live-reading fan-in,
   * disconnect handling, persistence load, persistent pairing, names, and the
   * connect/Sync/reconnect orchestration — lives in the tested `Fleet`. What remains
   * here is pure presentation: a trivial `selectedId`, the range/temp/humidity
   * preferences, the dashboard.ts transforms, text formatting, and the production
   * FleetDeps wiring.
   *   - Live reading  → CO₂-hero (colour-banded) + secondary temp/humidity.
   *   - Per-Pod History → uPlot timeseries over a selectable range.
   */
  import Chart from "./lib/Chart.svelte";
  import PodPicker from "./lib/PodPicker.svelte";
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
  // timer for the auto-sync loop, and the localStorage-backed Names it composes.
  const fleet = new Fleet({
    connectPod,
    reconnectPods: supported ? reconnectPods : () => {},
    listPodIds,
    makeHistory: (id) => new History(id),
    schedule: (cb, everyMs) => {
      const handle = setInterval(cb, everyMs);
      return () => clearInterval(handle);
    },
    names: new Names({ store: localStorage }),
    deleteHistory,
  });

  // Selection is the shell's trivial state (ticket 13): no persistence, no restore,
  // no focus-stealing rules. When it is null or points at a vanished Pod, `selected`
  // falls back to the first known Pod.
  let selectedId = $state<string | null>(null);

  // Map Fleet's two change signals to two $state counters. Only the History counter
  // feeds the chart's $derived — and only for the displayed Pod's Merge — so a Live
  // reading or a hidden Pod's background Merge refreshes nothing chart-shaped and
  // never resets uPlot's zoom.
  let historyVersion = $state(0); // bumps when the displayed Pod's Merge completes
  let stateVersion = $state(0); // bumps on membership/connection/live/name/busy/error
  fleet.onHistoryChange = (podId) => {
    if (podId === selected?.id) historyVersion++;
  };
  fleet.onChange = () => stateVersion++;

  let range = $state<Range>(RANGES[1]); // default to 24h
  let showTemp = $state(false);
  let showHumidity = $state(false);

  // The rich Pod list, re-read after every fleet change; everything the hero, chart
  // and picker show is read off `selected`, one object out of this list.
  const pods = $derived.by(() => {
    stateVersion; // touch the signal to establish the reactive dependency
    return fleet.pods;
  });
  const error = $derived.by(() => {
    stateVersion;
    return fleet.error;
  });
  const selected = $derived(
    pods.find((p) => p.id === selectedId) ?? pods[0] ?? null,
  );
  // Stable across pod-list rebuilds (same History object), so plotData below only
  // recomputes when the selection itself changes — not on every fleet change.
  const selectedHistory = $derived(selected?.history);

  // Connect → select → name (ticket 13): the returned id is the one genuinely-new-Pod
  // path, so select it and prompt for a name when it has none.
  async function connect(): Promise<void> {
    const id = await fleet.connect();
    if (id === null) return; // cancelled chooser or surfaced error
    selectedId = id;
    if (!fleet.hasName(id)) {
      const answer = window.prompt("Name this Pod");
      if (answer) fleet.rename(id, answer);
    }
  }

  // Rename lives in the shell (the picker only emits the intent, ticket 12e/12f):
  // prompt seeded with the current label; Fleet persists and signals the change.
  function renamePod(id: string): void {
    const answer = window.prompt(
      "Rename Pod",
      pods.find((p) => p.id === id)?.name,
    );
    if (answer === null) return; // cancelled
    fleet.rename(id, answer);
  }

  // Hero reads off the one selected Pod object (rich `PodView`, ticket 13).
  const live = $derived(selected?.live ?? null);
  const connected = $derived(selected?.connected ?? false);
  const syncing = $derived(selected?.syncing ?? false);

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
      {pods}
      selectedId={selected?.id ?? null}
      onSelect={(id) => (selectedId = id)}
      onConnect={connect}
      onForget={(id) => {
        // One-call forget (ticket 13): Fleet clears grant + History + name; the
        // shell only re-points selection, which falls back to the first Pod left.
        if (id === selectedId) selectedId = null;
        void fleet.remove(id);
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
