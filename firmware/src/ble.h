/*
 * The Pod's BLE presence: advertising + the single custom GATT service.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Ticket 06 makes the Pod discoverable and glanceable without a Sync: it
 * advertises continuously at a slow interval, is connectable at any time (open,
 * no bonding), and hosts one custom service exposing the stable Pod ID and the
 * Live reading (the most recent Measurement). The Sync control + Sync data
 * characteristics land on this same service in ticket 07. This is BLE plumbing —
 * hardware-verified, not host-tested; the pure byte packing it delegates to
 * (live_encode(), ticket 06) is the tested seam. Vocabulary (Pod ID, Live
 * reading, Sync) follows CONTEXT.md.
 */

#ifndef KUUKI_BLE_H
#define KUUKI_BLE_H

struct sample;

/*
 * Bring up Bluetooth and start advertising the Pod's service. Requires the Pod
 * ID to be initialised first (pod_id_init()), since the service serves it.
 * Returns 0 once advertising is running, or a negative errno on failure.
 */
int ble_start(void);

/*
 * Publish s as the current Live reading: update the readable characteristic
 * value and notify any subscribed client. Safe to call before a client connects
 * (the value is simply cached for the next read). Only the Measurement fields of
 * s are used; capture_uptime is ignored (a Live reading is always "now").
 */
void ble_live_update(const struct sample *s);

#endif /* KUUKI_BLE_H */
