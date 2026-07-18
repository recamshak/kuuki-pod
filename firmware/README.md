# kuuki-pod firmware

nRF Connect SDK (Zephyr) firmware for the Pod — a XIAO nRF52840 + SCD40 that
samples air quality, buffers Samples in RAM, and serves them over BLE. See
`../CONTEXT.md` for the domain vocabulary and `../docs/specs/0001-kuuki-pod-v1.md`
for the spec.

It boots, then logs the SCD40 into the in-RAM Buffer at each Sample tick (a
firmware constant, 15 min for v1); the sensor runs in low-power periodic mode on
I²C. The BLE GATT service that Syncs the Buffer arrives in a later ticket.
Correctness-critical logic — the Buffer `collect()` query and the
Measurement→Sample scaling — is developed off-board as pure modules under
`tests/`, run on the host via `native_sim`; the SCD40 I²C bring-up and the
sampling loop are hardware-verified.

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
