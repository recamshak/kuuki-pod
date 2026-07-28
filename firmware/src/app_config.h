/*
 * The Buffer's capacity, derived from the firmware's project parameters.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Sample tick cadence and the Buffer's retention target are product
 * decisions, configured in Kconfig (see ../Kconfig) as
 * CONFIG_KUUKI_SAMPLE_INTERVAL_SEC and CONFIG_KUUKI_RETENTION_SEC. This header
 * is the one place the ring's capacity is derived from the pair, and the
 * application layer is the only layer that reads it: main.c sizes the Buffer's
 * backing array from it and ble.c its Sync scratch, while the modules below
 * them take the interval and the capacity as parameters (CONTEXT.md's Sample
 * tick and Buffer).
 */

#ifndef KUUKI_APP_CONFIG_H
#define KUUKI_APP_CONFIG_H

#include <zephyr/toolchain.h>

/*
 * The Buffer's capacity in Samples, *derived* from the configured parameters —
 * never a hard-coded Sample count. Changing the Sample interval resizes the
 * ring so it still spans the retention target.
 */
#define KUUKI_BUFFER_CAPACITY \
	(CONFIG_KUUKI_RETENTION_SEC / CONFIG_KUUKI_SAMPLE_INTERVAL_SEC)

/* An interval that does not divide the retention target would leave the ring
 * spanning less time than configured — the derivation quietly floors. */
BUILD_ASSERT(CONFIG_KUUKI_RETENTION_SEC % CONFIG_KUUKI_SAMPLE_INTERVAL_SEC == 0,
	     "Retention target must be a whole number of Sample intervals");

#endif /* KUUKI_APP_CONFIG_H */
