#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
#
# Read the Pod's Live reading over BLE with a generic client — the manual,
# on-hardware check for ticket 06 (the Live reading is exercised off-board only
# as byte packing; the BLE plumbing is verified on device).
#
# Scans for the Pod by advertised name, reads the Pod ID, then reads and
# subscribes to the Live reading characteristic, decoding each 6-byte payload
# per docs/wire-contract.md (little-endian: co2 u16 ppm, temp i16 centi-C,
# humidity u16 centi-%RH). co2 == 0 is the "no Measurement yet" sentinel the Pod
# serves for the ~30 s after boot before the SCD40's first Measurement.
#
# Usage:
#   pip install bleak
#   ./live.py                 # scan for "kuuki-pod", read + stream for 90 s
#   ./live.py --name my-pod --seconds 30

import argparse
import asyncio
import struct

from bleak import BleakClient, BleakScanner

# Custom 128-bit UUIDs — must match src/ble.c (base spells "kuuki-pod").
POD_ID_UUID = "4b75756b-692d-706f-6400-000000000002"
LIVE_UUID = "4b75756b-692d-706f-6400-000000000003"


def format_live(data: bytes) -> str:
    """Decode a Live reading payload to a human line (docs/wire-contract.md)."""
    co2, temp, humidity = struct.unpack("<HhH", data)
    if co2 == 0:
        return "CO2 not available yet (no Measurement since boot)"
    return f"CO2={co2} ppm  temp={temp / 100:.2f} C  humidity={humidity / 100:.2f} %"


async def run(name: str, seconds: int) -> None:
    print(f"Scanning for {name!r}...")
    device = await BleakScanner.find_device_by_name(name, timeout=15)
    if device is None:
        raise SystemExit(f"{name!r} not found — is the Pod advertising in range?")

    async with BleakClient(device) as client:
        pod_id = await client.read_gatt_char(POD_ID_UUID)
        print(f"Connected. Pod ID: {pod_id.hex()}")

        print("Live:", format_live(await client.read_gatt_char(LIVE_UUID)))

        print(f"Subscribing to notifications for {seconds} s (Ctrl-C to stop)...")
        await client.start_notify(
            LIVE_UUID, lambda _, data: print("Live:", format_live(data))
        )
        await asyncio.sleep(seconds)


def main() -> None:
    parser = argparse.ArgumentParser(description="Read the Pod's Live reading over BLE.")
    parser.add_argument("--name", default="kuuki-pod", help="advertised device name")
    parser.add_argument(
        "--seconds", type=int, default=90, help="how long to stream notifications"
    )
    args = parser.parse_args()

    try:
        asyncio.run(run(args.name, args.seconds))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
