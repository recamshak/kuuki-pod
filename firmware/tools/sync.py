#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
#
# Run a Sync against the Pod with a generic BLE client — the manual,
# on-hardware check for ticket 07 (the record packing and MTU math are exercised
# off-board as pure functions; the BLE Sync plumbing is verified on device).
#
# Subscribes to the Sync data characteristic, writes a High-water mark to the
# Sync control characteristic to begin a Sync, then decodes each 10-byte record
# oldest-first per docs/wire-contract.md (little-endian: age u32 s, co2 u16 ppm,
# temp i16 centi-C, humidity u16 centi-%RH) until the zero-length end-of-batch
# marker. A Sync with no records newer than the mark ends with only the marker.
#
# The High-water mark on the wire is an Age (seconds ago), but you pass it as a
# wall-clock --since datetime: the Age depends on when you run, an absolute time
# does not. --since takes the same 'YYYY-MM-DD HH:MM:SS' shape printed for each
# Sample, so you can copy a line's time straight back in; it is converted to
# now - since at the moment of the write.
#
# Because records stream oldest-first (ADR-0002), interrupting a Sync (Ctrl-C,
# or moving out of range) and re-running re-fetches only the tail that did not
# arrive — the on-device self-healing check. Re-run with --since set to the
# newest time you already received.
#
# Usage:
#   pip install bleak
#   ./sync.py                              # scan for "kuuki-pod", Sync everything
#   ./sync.py --since '2026-07-19 07:30:00'  # only Samples newer than that
#   ./sync.py --name my-pod

import argparse
import asyncio
import struct
import time
from datetime import datetime

from bleak import BleakClient, BleakScanner

# Custom 128-bit UUIDs — must match src/ble.c (base spells "kuuki-pod").
POD_ID_UUID = "4b75756b-692d-706f-6400-000000000002"
SYNC_CTRL_UUID = "4b75756b-692d-706f-6400-000000000004"
SYNC_DATA_UUID = "4b75756b-692d-706f-6400-000000000005"

RECORD_SIZE = 10  # docs/wire-contract.md
MARK_SENTINEL = 0xFFFFFFFF  # "I have nothing — send everything."

# One format shared by the per-Sample printout and --since, so output pastes
# straight back into the argument.
TIME_FORMAT = "%Y-%m-%d %H:%M:%S"


def parse_since(s: str) -> int:
    """Convert a --since datetime to a High-water mark (Age in seconds).

    Accepts the same TIME_FORMAT shape printed for each Sample, so a line's time
    can be pasted straight back in. Returns now - since in seconds, the Age the
    Pod keys Samples by — computed here so an absolute time stays fixed however
    long you wait before running.
    """
    try:
        dt = datetime.strptime(s.strip(), TIME_FORMAT)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"{s!r} is not a datetime like '2026-07-19 07:30:00'")

    age = (datetime.now() - dt).total_seconds()
    if age < 0:
        raise argparse.ArgumentTypeError(f"{s!r} is in the future")
    return int(age)


def decode_records(payload: bytes) -> list[tuple]:
    """Split a notification into whole 10-byte records (wire-contract.md)."""
    records = []
    for off in range(0, len(payload), RECORD_SIZE):
        age, co2, temp, humidity = struct.unpack_from("<IHhH", payload, off)
        records.append((age, co2, temp / 100, humidity / 100))
    return records


async def run(name: str, mark: int, timeout: float) -> None:
    print(f"Scanning for {name!r}...")
    device = await BleakScanner.find_device_by_name(name, timeout=15)
    if device is None:
        raise SystemExit(f"{name!r} not found — is the Pod advertising in range?")

    done = asyncio.Event()
    count = 0

    def on_data(_, payload: bytes) -> None:
        nonlocal count
        if len(payload) == 0:
            print("End-of-batch marker received — Sync complete.")
            done.set()
            return
        if len(payload) % RECORD_SIZE != 0:
            print(f"WARNING: {len(payload)}-byte notification is not a whole "
                  f"number of {RECORD_SIZE}-byte records")
        for age, co2, temp, humidity in decode_records(payload):
            count += 1
            wall = datetime.fromtimestamp(time.time() - age).strftime(TIME_FORMAT)
            print(f"  #{count:<4} age={age:>7}s (~{wall})  "
                  f"co2={co2} ppm  temp={temp:.2f} C  humidity={humidity:.2f} %")

    async with BleakClient(device) as client:
        pod_id = await client.read_gatt_char(POD_ID_UUID)
        print(f"Connected. Pod ID: {pod_id.hex()}")

        # Subscribe before writing the control mark, so no record is missed.
        await client.start_notify(SYNC_DATA_UUID, on_data)

        mark_label = "sentinel (everything)" if mark == MARK_SENTINEL else f"{mark}s ago"
        print(f"Beginning Sync with High-water mark = {mark_label}...")
        await client.write_gatt_char(SYNC_CTRL_UUID, struct.pack("<I", mark),
                                     response=True)

        try:
            await asyncio.wait_for(done.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            print(f"No end-of-batch marker within {timeout:.0f}s — Sync "
                  f"incomplete ({count} records so far). Re-run to self-heal.")
            return

        print(f"Streamed {count} record(s).")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a Sync against the Pod over BLE.")
    parser.add_argument("--name", default="kuuki-pod", help="advertised device name")
    parser.add_argument(
        "--since", type=parse_since, default=None,
        help="only Sync Samples newer than this datetime, in the same "
             "'2026-07-19 07:30:00' shape printed per Sample. Default: everything.",
    )
    parser.add_argument(
        "--timeout", type=float, default=60.0,
        help="seconds to wait for the end-of-batch marker before giving up",
    )
    args = parser.parse_args()

    mark = MARK_SENTINEL if args.since is None else args.since

    try:
        asyncio.run(run(args.name, mark, args.timeout))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
