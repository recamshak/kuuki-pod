# Sync wire contract

The byte-exact framing of the **Sync** stream and its **Sync control** trigger, plus the
**Live reading** characteristic's payload (ticket 06). This is the single source of truth for
the on-wire format: firmware (tickets 06, 07) and webapp (tickets 09, 10) each encode/decode
against **this** document and must not redefine the layout anywhere else. Any constant either
side names in code (e.g. `RECORD_SIZE`, `LIVE_READING_SIZE`) takes its value from the tables
below.

Vocabulary follows `CONTEXT.md` (Sample, Sync, Age, High-water mark, Latched read instant,
Live reading, Measurement).
Ordering rationale is `docs/adr/0002-oldest-first-sync-transfer.md`.

## Conventions

- **Endianness: little-endian for every multi-byte field**, on both the Sync control write and
  the Sync data records. This matches the Bluetooth GATT convention and Web Bluetooth's natural
  `DataView` little-endian reads.
- **Packed, no padding, no alignment.** Fields sit back-to-back in the order listed; a record is
  exactly the sum of its field widths (10 bytes), never padded to a power of two.
- All values are unsigned unless the field type says `int` (only `temp` is signed).

## Sync control write (client → Pod)

Written by the client to the Sync control characteristic to begin a Sync. It carries the
client's **High-water mark**: the Age of the newest Sample the client already holds for this
Pod. Writing it latches the Pod's single **Latched read instant** and selects the record set.

| Offset | Field  | Type   | Units   | Notes                                                     |
| -----: | ------ | ------ | ------- | --------------------------------------------------------- |
|      0 | `mark` | uint32 | seconds | High-water mark, an Age. Same width/endianness as record `age`. |

Total: **4 bytes**, little-endian.

- **Sentinel `mark = 0xFFFFFFFF` (`UINT32_MAX`) means "I have nothing — send everything."** The
  client uses it when it holds no Samples for this Pod. Any real Age is far below this
  (~30-day Buffer ⇒ max Age ≈ 2.6 M seconds), so the sentinel never collides with a real mark.
- The mark only trims transfer volume; it is not persisted on the Pod and correctness never
  depends on it being exact (the webapp's slot-keyed Merge is the correctness guarantee). A Pod
  returns the Samples strictly newer than the sample-interval slot matched by `mark`.

## Sync data record (Pod → client)

Each Sample is streamed as one fixed 10-byte record, oldest-first (ascending time / descending
Age, per ADR-0002).

| Offset | Field      | Type   | Units       | Range described                          |
| -----: | ---------- | ------ | ----------- | ---------------------------------------- |
|      0 | `age`      | uint32 | seconds     | Age = `latch_uptime − capture_uptime`    |
|      4 | `co2`      | uint16 | ppm         | 0 – 65535 (SCD40 tops out ~40000)        |
|      6 | `temp`     | int16  | centi-°C    | −327.68 – 327.67 °C (e.g. 2143 = 21.43 °C) |
|      8 | `humidity` | uint16 | centi-%RH   | 0 – 655.35 %RH (0 – 100 in practice)     |

**`RECORD_SIZE = 10` bytes.** The client computes each Sample's wall-clock time as
`t = now_ms_at_latch − age × 1000`, where `now_ms_at_latch` is `Date.now()` captured once at
Sync start (the client-side mirror of the Pod's single latch).

## Notification packing

Records are streamed over GATT notifications on the Sync data characteristic, using the
negotiated large ATT MTU.

- Usable notification payload = **`ATT_MTU − 3`** bytes (3 = 1-byte ATT opcode + 2-byte handle
  of `ATT_HANDLE_VALUE_NTF`).
- Records per notification = **`floor((ATT_MTU − 3) / RECORD_SIZE)`**. A record is **never split
  across notifications**; each notification carries a whole number of records.
- Notifications are filled greedily to that maximum; only the **last** data notification of a
  batch may carry fewer records.
- With the target `ATT_MTU = 247`: `floor((247 − 3) / 10) = 24` records ⇒ 240-byte payloads.
  The formula is normative; 24 is the expected concrete value for the negotiated MTU.

## End-of-batch marker

**A zero-length notification on the Sync data characteristic terminates the batch.** The reader
knows the Sync is complete when it receives a notification with an empty (0-byte) payload.

- Every data-bearing notification carries at least one record, so its length is a positive
  multiple of `RECORD_SIZE` (10). A length of 0 is therefore unambiguous as the terminator.
- When the client is already up to date (nothing newer than `mark`), the Pod sends **only** the
  zero-length end-of-batch marker — a valid, empty Sync.
- A connection dropping before the marker arrives means the batch was **truncated**; because
  records are oldest-first, the client keeps the contiguous prefix it received and the next
  Sync's advanced High-water mark re-fetches exactly the lost tail (ADR-0002). Absence of the
  marker is precisely the "incomplete Sync" signal.

## Live reading characteristic (Pod → client)

The **Live reading** is exposed as its own BLE characteristic (read + notify), separate from the
Sync stream, so a client sees "right now" the instant it connects (CONTEXT.md). Its payload is
the Sync data record's three Measurement fields **without** the `age`: a Live reading is always
"now", so it carries no Age and is never buffered as a Sample.

| Offset | Field      | Type   | Units       | Range described                            |
| -----: | ---------- | ------ | ----------- | ------------------------------------------ |
|      0 | `co2`      | uint16 | ppm         | 0 – 65535 (SCD40 tops out ~40000)          |
|      2 | `temp`     | int16  | centi-°C    | −327.68 – 327.67 °C (e.g. 2143 = 21.43 °C) |
|      4 | `humidity` | uint16 | centi-%RH   | 0 – 655.35 %RH (0 – 100 in practice)       |

**`LIVE_READING_SIZE = 6` bytes**, little-endian, packed — `RECORD_SIZE` minus the 4-byte `age`.

- **`co2 == 0` means "no Measurement yet".** A real room is never 0 ppm CO₂, so the Pod uses 0 as
  the sentinel for the brief window after boot before the SCD40's first Measurement (~30 s); the
  client treats a Live reading with `co2 == 0` as "not available yet" rather than displaying it.
  This is the same guard that keeps a bogus 0-ppm Measurement out of the Buffer as a Sample.
- A read returns the most recent Measurement; a notification is sent on each new Measurement to
  any subscribed client, independent of any Sync.

## Canonical constants

Both sides name these with these values; no other document or module redefines them.

| Name              | Value        | Meaning                                          |
| ----------------- | ------------ | ------------------------------------------------ |
| `RECORD_SIZE`     | `10`         | Bytes per Sync data record                       |
| `LIVE_READING_SIZE`| `6`         | Bytes of the Live reading characteristic payload |
| `ATT_NTF_OVERHEAD`| `3`          | ATT bytes subtracted from MTU for a notification |
| `MARK_SENTINEL`   | `0xFFFFFFFF` | High-water mark meaning "send everything"        |
