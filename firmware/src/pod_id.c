/*
 * Pod ID — implementation.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * See pod_id.h for the contract. This is the hardware-facing seam (flash via the
 * settings subsystem, the hardware RNG), so — like the BLE plumbing — it is
 * verified on device, not under host ztests: "does it survive a reset unchanged"
 * is a property of real flash, not pure logic.
 *
 * The ID is stored under the settings key "kuuki/pod_id". On boot the caller
 * runs the settings load, which invokes pod_id_set() to restore a persisted ID;
 * pod_id_init() then mints one only if none was restored.
 */

#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/random/random.h>
#include <zephyr/settings/settings.h>

#include "pod_id.h"

LOG_MODULE_REGISTER(pod_id, LOG_LEVEL_INF);

#define POD_ID_SETTINGS_KEY "kuuki/pod_id"

static uint8_t pod_id[POD_ID_LEN];
static bool loaded; /* set once a valid ID is restored from flash or minted */

/* settings h_set: restore the persisted ID when settings_load walks "kuuki". */
static int pod_id_set(const char *name, size_t len, settings_read_cb read_cb,
		      void *cb_arg)
{
	if (!settings_name_steq(name, "pod_id", NULL)) {
		return -ENOENT;
	}

	if (len != POD_ID_LEN) {
		/* A stored ID of the wrong width is corrupt; ignore it so
		 * pod_id_init() mints a fresh one rather than serve garbage. */
		LOG_WRN("Stored Pod ID has wrong length (%u); reminting", len);
		return -EINVAL;
	}

	ssize_t rc = read_cb(cb_arg, pod_id, POD_ID_LEN);
	if (rc < 0) {
		return (int)rc;
	}

	loaded = true;
	return 0;
}

SETTINGS_STATIC_HANDLER_DEFINE(pod_id, "kuuki", NULL, pod_id_set, NULL, NULL);

int pod_id_init(void)
{
	int err = settings_subsys_init();
	if (err) {
		LOG_ERR("settings_subsys_init failed (%d)", err);
		return err;
	}

	/* Restores a persisted ID via pod_id_set() if one exists. */
	err = settings_load_subtree("kuuki");
	if (err) {
		LOG_ERR("settings_load_subtree failed (%d)", err);
		return err;
	}

	if (loaded) {
		LOG_INF("Pod ID loaded from flash");
		return 0;
	}

	/* First boot (or reminting after a corrupt store): mint and persist. */
	sys_rand_get(pod_id, POD_ID_LEN);
	loaded = true;

	err = settings_save_one(POD_ID_SETTINGS_KEY, pod_id, POD_ID_LEN);
	if (err) {
		LOG_ERR("Failed to persist minted Pod ID (%d)", err);
		return err;
	}

	LOG_INF("Pod ID minted and persisted");
	return 0;
}

void pod_id_get(uint8_t out[POD_ID_LEN])
{
	memcpy(out, pod_id, POD_ID_LEN);
}
