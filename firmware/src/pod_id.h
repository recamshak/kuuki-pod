/*
 * Pod ID — a stable random identifier minted once and persisted in flash.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Pod ID is the one thing (besides any future BLE keys) that must survive a
 * reset: the webapp keys each room's History by it, so a reboot, a re-flash, or
 * a second Pod never cross-contaminates series (CONTEXT.md). Unlike the RAM-only
 * Buffer it lives in flash via the settings subsystem. Minted on first boot from
 * the hardware RNG; loaded verbatim on every boot thereafter. Exposed read-only
 * over the BLE service (ticket 06).
 */

#ifndef KUUKI_POD_ID_H
#define KUUKI_POD_ID_H

#include <stdint.h>

/* Pod ID width, bytes: a 128-bit random value — wide enough that independently
 * minted Pods never collide, and read by the webapp as a stable opaque key. */
#define POD_ID_LEN 16

/*
 * Load the Pod ID from flash, minting and persisting a fresh random one if this
 * is the first boot (no stored ID). Idempotent across the process lifetime: once
 * it returns 0 the ID is available from pod_id_get() and is stable across
 * resets. Returns a negative errno if the settings subsystem or RNG fails.
 */
int pod_id_init(void);

/* Copy the current Pod ID into out. Valid only after pod_id_init() returns 0. */
void pod_id_get(uint8_t out[POD_ID_LEN]);

#endif /* KUUKI_POD_ID_H */
