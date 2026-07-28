# kuuki-pod firmware

nRF Connect SDK (Zephyr) firmware for the Pod — a XIAO nRF52840 + SCD40 that
samples air quality, buffers Samples in RAM, and serves them over BLE. See
`../CONTEXT.md` for the domain vocabulary and `../docs/specs/0001-kuuki-pod-v1.md`
for the spec.

It boots, then logs the SCD40 into the in-RAM Buffer at each Sample tick (a
project parameter, 15 min by default); the sensor runs in low-power periodic mode
on I²C, and the BLE GATT service serves the Pod ID, the Live reading, and Syncs
of the Buffer. Correctness-critical logic — the Buffer snapshot, the Sync
`sync_collect()` query, and the Measurement→Sample scaling — is developed
off-board as pure modules under `tests/`, run on the host via `native_sim`; the
SCD40 I²C bring-up and the sampling loop are hardware-verified.

## Project parameters

The two product decisions the firmware is built around live in `Kconfig`, not in
the modules that use them:

| Option                             | Default           | Meaning                                        |
| ---------------------------------- | ----------------- | ---------------------------------------------- |
| `CONFIG_KUUKI_SAMPLE_INTERVAL_SEC` | 900 (15 min)      | Sample tick cadence                            |
| `CONFIG_KUUKI_RETENTION_SEC`       | 2592000 (30 days) | How far back the Buffer keeps Samples          |

`src/app_config.h` derives the ring's capacity in Samples from the two
(`retention / interval`, which must divide evenly); `main.c` owns the backing
array sized from it and hands it to `buffer_init()`. Changing the interval
therefore resizes the ring instead of shortening the span it covers. Override
either at build time, e.g.
`west build -b xiao_ble . -- -DCONFIG_KUUKI_SAMPLE_INTERVAL_SEC=300`.

Mind the RAM: the ring is paid for twice (the Buffer plus `ble.c`'s Sync
scratch) at 12 bytes per Sample, so the defaults' 2880 Samples cost ~69 KB of
the nRF52840's 256 KB — 43% of RAM in total — and a 5-minute tick takes that
to 96%.

## Prerequisites

The nRF Connect SDK v3.4.0 toolchain and Zephyr environment. The repo's `.envrc`
sets it up (`direnv allow`, or `source ../.envrc`).

## Run the host test suite

Run from this `firmware/` directory (the `-T tests` path is relative to cwd):

```sh
west twister -T tests -p native_sim
```

Builds and runs every ztest suite under `tests/` on the host. This is the
reference command for TDD'ing Pod logic off-board; it exits green.

## Build for the target board

From this `firmware/` directory:

```sh
west build -b xiao_ble .
```

Flash the resulting `build/firmware/zephyr/zephyr.uf2` by copying it to the
board's UF2 bootloader drive (double-tap reset to enter the bootloader).
