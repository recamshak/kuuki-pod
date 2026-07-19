# kuuki-pod

A small battery-powered device (the **Pod**) that logs air-quality measurements from an SCD40 and hands them to a browser webapp over BLE. No backend: the Pod is the source of truth for buffered data, the webapp keeps history in localStorage.

Primary use: sits in a bedroom (mainly to watch CO₂ overnight); the user Syncs in the morning. Samples are buffered in **RAM only** — a reset or brownout costs at most the unsynced samples since the last Sync, which is acceptable. Because RAM and the monotonic clock reset together, buffered Samples are always internally consistent (no cross-reset timing anchor needed).

## Language

**Pod**:
The physical device: a XIAO nRF52840 + SCD40 running nRF Connect SDK firmware. It samples, buffers, and serves data over BLE. The system is multi-Pod: several Pods (one per room) can coexist, each owning its own history.
_Avoid_: sensor, node, station

**Pod ID**:
A stable random identifier minted once on a Pod's first boot and persisted in flash (unlike the RAM-only Buffer, this must survive resets). Exposed over the GATT service; the webapp keys each room's history by Pod ID so a reboot, a re-flash, or a second Pod never cross-contaminates series.
_Avoid_: device id, serial, name (the BLE name is for humans; the Pod ID is the key)

**History**:
The webapp's per-Pod localStorage copy of Samples, keyed by Pod ID and built up by Merge across many Syncs. The long-lived record; the Pod's Buffer is only the recent-and-unsynced tail of it.
_Avoid_: log, archive

**Fleet**:
The set of Pods the webapp currently knows about — connected or merely persisted — keyed by Pod ID, together with which one is selected. The webapp-side counterpart to the multi-Pod world; owns selection, Live-reading fan-in, and the Pod connection lifecycle.
_Avoid_: registry, store, list

**Sample**:
One CO₂/temperature/humidity data point stored in the Pod's buffer at a 15-minute **Sample tick**, plus the timing needed to place it on a wall clock. The atomic unit of logged data.
_Avoid_: reading, datapoint, record

**Measurement**:
A raw reading the SCD40 produces on its own cadence (~every 30 s in low-power periodic). The Pod discards most of these; it promotes one to a Sample at each Sample tick. A Measurement is not a Sample.
_Avoid_: reading

**Sample tick**:
The 15-minute cadence on which the MCU wakes, grabs the SCD40's latest Measurement, and stores it as a Sample. Distinct from the SCD40's internal ~30 s measurement cadence.

**Buffer**:
The Pod's in-RAM ring of Samples, sized to hold ~30 days. When full it overwrites the oldest Sample, so it always holds the most recent ~30 days regardless of when the user last Synced. Each Sample carries its device capture time so Ages stay exact even if a Sample tick slips.
_Avoid_: log, store, queue, history (history is the webapp's localStorage copy)

**Sync**:
The act of a connected webapp pulling accumulated Samples from the Pod over the BLE GATT service. Streamed oldest-first so a dropped connection self-heals via the High-water mark. The only path buffered data leaves the Pod.
_Avoid_: download, fetch, upload, dump

**Live reading**:
The Pod's most recent Measurement (current CO₂/temp/humidity), exposed as its own BLE characteristic separate from the Sync stream, so the webapp can show "right now" the instant it connects without waiting for a Sync. A Live reading is not a Sample (it is never buffered as history through this path).
_Avoid_: current sample, latest sample

**Age**:
A Sample's offset (in the past) from the single read instant latched at the start of a Sync — e.g. "780 seconds ago". The Pod sends Age; the webapp converts it to wall-clock time via `Date.now() − Age`. The Pod itself has no notion of wall-clock time.
_Avoid_: timestamp, offset, delta

**Latched read instant**:
The one reference "now" the Pod fixes at the start of a Sync, against which every Age in that batch is measured. Latched once per Sync so transfer latency shifts the whole series uniformly instead of smearing it.

**High-water mark**:
The Age of the client's newest already-known Sample, sent *to* the Pod at the start of a Sync (Age flows both directions). The Pod returns only Samples newer than the matched 15-min slot; a sentinel value means "I have nothing, send everything." The mark is a bandwidth optimization only — it is not persisted on the Pod and correctness never depends on it.
_Avoid_: cursor, offset, checkpoint

**Merge**:
The webapp's idempotent folding of Synced Samples into its per-Pod History, keyed by 15-minute **slot** (each Sample snapped to its nearest quarter-hour, keyed by UTC epoch so DST never duplicates or drops slots; local time is only for display). Re-Syncing the same Sample is harmless. This — not the High-water mark — is what makes Syncs correct and repeatable.
_Avoid_: import, sync (Sync is the transfer; Merge is the reconcile)
