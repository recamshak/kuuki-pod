<script lang="ts">
  /*
   * The one-screen dashboard (ticket 10). This is the untestable UI seam: it wires
   * the tested pure modules together and owns nothing correctness-critical.
   *   - Live reading  → CO₂-hero (colour-banded) + secondary temp/humidity.
   *   - Per-Pod History → uPlot timeseries over a selectable range.
   *   - Multi-Pod: keyed by Pod ID, auto-selecting the sole known Pod.
   *   - Reload persistence: known Pods' History loads from localStorage with no
   *     connection, so the chart survives a reload without a re-Sync.
   * Merge, decode, transport, banding and windowing all live in ./lib under test.
   */
  import Chart from './lib/Chart.svelte';
  import { co2Band, RANGES, selectRange, toPlotData, type PlotData, type Range } from './lib/dashboard';
  import { History, listPodIds } from './lib/history';
  import type { LiveReading } from './lib/wire';
  import { connectPod, PodConnection } from './lib/transport';

  // Non-reactive registries keyed by Pod ID; reactivity is driven by the $state
  // below (selection, live readings, a data-version bump after each Merge).
  const histories = new Map<string, History>();
  const connections = new Map<string, PodConnection>();

  let knownPodIds = $state<string[]>([]);
  let selectedPodId = $state<string | null>(null);
  let liveByPod = $state<Record<string, LiveReading | null>>({});
  let dataVersion = $state(0); // bump to recompute the chart after an in-place Merge
  let range = $state<Range>(RANGES[1]); // default to 24h
  let showTemp = $state(false);
  let showHumidity = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  const supported = typeof navigator !== 'undefined' && 'bluetooth' in navigator;

  // Load persisted Pods up front so a reload shows the chart with no connection.
  const persistedIds = listPodIds();
  for (const id of persistedIds) histories.set(id, new History(id));
  knownPodIds = persistedIds;
  if (persistedIds.length === 1) selectedPodId = persistedIds[0];

  const selectedHistory = $derived(selectedPodId ? histories.get(selectedPodId) : undefined);
  const live = $derived(selectedPodId ? (liveByPod[selectedPodId] ?? null) : null);
  const band = $derived(live ? co2Band(live.co2) : null);
  const connected = $derived(selectedPodId ? connections.has(selectedPodId) : false);

  const plotData = $derived.by<PlotData>(() => {
    dataVersion; // establish the dependency: recompute after each Merge
    if (!selectedHistory) return [[], [], [], []];
    return toPlotData(selectRange(selectedHistory.samples(), range.ms, Date.now()));
  });
  const hasHistory = $derived(plotData[0].length > 0);

  /** Run an async action with the shared busy flag and error surfacing. */
  async function runBusy(action: () => Promise<void>): Promise<void> {
    error = null;
    busy = true;
    try {
      await action();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function connect(): Promise<void> {
    return runBusy(async () => {
      let conn: PodConnection;
      try {
        conn = await connectPod();
      } catch (e) {
        // A cancelled device chooser is a normal no-op, not an error to surface.
        if (e instanceof DOMException && e.name === 'NotFoundError') return;
        throw e;
      }
      const id = conn.podId;
      connections.set(id, conn);
      histories.set(id, conn.history);
      if (!knownPodIds.includes(id)) knownPodIds = [...knownPodIds, id];
      selectedPodId = id;
      liveByPod = { ...liveByPod, [id]: conn.liveReading };
      conn.onLiveReading = (r) => (liveByPod = { ...liveByPod, [id]: r });
      conn.onDisconnected = () => connections.delete(id);
      await conn.sync();
      dataVersion++;
    });
  }

  function sync(): Promise<void> {
    const conn = selectedPodId ? connections.get(selectedPodId) : undefined;
    if (!conn) return Promise.resolve();
    return runBusy(async () => {
      await conn.sync();
      dataVersion++;
    });
  }

  const co2Text = $derived(live ? String(live.co2) : '––');
  const tempText = $derived(live ? `${(live.temp / 100).toFixed(1)} °C` : '––');
  const humidityText = $derived(live ? `${Math.round(live.humidity / 100)} %` : '––');
</script>

<main>
  <header>
    <h1>kuuki-pod</h1>
    {#if knownPodIds.length > 1}
      <select bind:value={selectedPodId} aria-label="Pod">
        {#each knownPodIds as id (id)}
          <option value={id}>{id.slice(0, 8)}</option>
        {/each}
      </select>
    {/if}
  </header>

  {#if !supported}
    <p class="notice">Web Bluetooth isn't available in this browser. Use Chrome or Edge.</p>
  {/if}

  <section class="hero" style={band ? `--band: ${band.color}` : undefined}>
    <div class="co2">
      <span class="value">{co2Text}</span>
      <span class="unit">ppm CO₂</span>
    </div>
    {#if band}
      <span class="verdict">{band.label}</span>
    {:else}
      <span class="verdict muted">{connected ? 'Waiting for a reading…' : 'Not connected'}</span>
    {/if}
    <div class="secondary">
      <span>{tempText}</span>
      <span>{humidityText} RH</span>
    </div>
  </section>

  <section class="controls">
    <button onclick={connect} disabled={!supported || busy}>
      {busy ? 'Working…' : 'Connect a Pod'}
    </button>
    {#if connected}
      <button onclick={sync} disabled={busy}>Sync</button>
    {/if}
  </section>

  {#if error}
    <p class="notice error">{error}</p>
  {/if}

  <section class="chart-panel">
    <div class="range">
      {#each RANGES as r (r.label)}
        <button class:selected={r === range} onclick={() => (range = r)}>{r.label}</button>
      {/each}
      <label><input type="checkbox" bind:checked={showTemp} /> Temp</label>
      <label><input type="checkbox" bind:checked={showHumidity} /> Humidity</label>
    </div>
    {#if hasHistory}
      <Chart data={plotData} co2Color={band?.color ?? '#3fb950'} {showTemp} {showHumidity} />
    {:else}
      <p class="notice muted">No history yet — Connect a Pod and Sync to build the chart.</p>
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

  h1 {
    margin: 0;
    font-size: 1.5rem;
    letter-spacing: -0.02em;
    opacity: 0.85;
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
