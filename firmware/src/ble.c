/*
 * BLE advertising + custom GATT service — implementation.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * See ble.h for the contract. This is the hardware-facing seam: the Bluetooth
 * stack, GATT attribute plumbing, and advertising live here and are verified on
 * device with a generic BLE client. The correctness-critical byte packing is
 * delegated to live_encode() (host-tested); nothing subtle lives on this side.
 */

#include <string.h>

#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "ble.h"
#include "live.h"
#include "pod_id.h"

LOG_MODULE_REGISTER(ble, LOG_LEVEL_INF);

/*
 * Custom 128-bit UUIDs. The base spells "kuuki-pod" in ASCII (4b 75 75 6b =
 * "Kuuk", 69 2d = "i-", 70 6f = "po", 64 = "d") so it is recognisable in a
 * generic client; the trailing 16-bit field selects the service and each
 * characteristic. 0x0004/0x0005 are reserved for the Sync control + Sync data
 * characteristics added to this same service in ticket 07.
 */
#define KUUKI_SVC_UUID_VAL \
	BT_UUID_128_ENCODE(0x4b75756b, 0x692d, 0x706f, 0x6400, 0x000000000001)
#define KUUKI_POD_ID_UUID_VAL \
	BT_UUID_128_ENCODE(0x4b75756b, 0x692d, 0x706f, 0x6400, 0x000000000002)
#define KUUKI_LIVE_UUID_VAL \
	BT_UUID_128_ENCODE(0x4b75756b, 0x692d, 0x706f, 0x6400, 0x000000000003)

static const struct bt_uuid_128 kuuki_svc_uuid = BT_UUID_INIT_128(KUUKI_SVC_UUID_VAL);
static const struct bt_uuid_128 pod_id_uuid = BT_UUID_INIT_128(KUUKI_POD_ID_UUID_VAL);
static const struct bt_uuid_128 live_uuid = BT_UUID_INIT_128(KUUKI_LIVE_UUID_VAL);

/* The most recent Live reading, kept encoded and ready to serve on a read or
 * notify. Seeded all-zero until the first Measurement is published: co2 == 0 is
 * the wire contract's "no Measurement yet" sentinel, so a client that reads in
 * the ~30 s before the first Measurement sees "not available" rather than a
 * bogus 0-ppm reading (docs/wire-contract.md, Live reading characteristic). */
static uint8_t live_value[LIVE_READING_SIZE];

/* Whether a client has subscribed to Live reading notifications. */
static bool live_notify_enabled;

static ssize_t read_pod_id(struct bt_conn *conn, const struct bt_gatt_attr *attr,
			   void *buf, uint16_t len, uint16_t offset)
{
	uint8_t id[POD_ID_LEN];

	pod_id_get(id);
	return bt_gatt_attr_read(conn, attr, buf, len, offset, id, sizeof(id));
}

static ssize_t read_live(struct bt_conn *conn, const struct bt_gatt_attr *attr,
			 void *buf, uint16_t len, uint16_t offset)
{
	return bt_gatt_attr_read(conn, attr, buf, len, offset, live_value,
				 sizeof(live_value));
}

static void live_ccc_changed(const struct bt_gatt_attr *attr, uint16_t value)
{
	live_notify_enabled = (value == BT_GATT_CCC_NOTIFY);
	LOG_INF("Live reading notifications %s",
		live_notify_enabled ? "enabled" : "disabled");
}

/*
 * The single custom service. Attribute order is fixed by this macro; the Live
 * reading's value attribute — the one bt_gatt_notify() references — is the 5th
 * (index 4): [0] service, [1] Pod ID decl, [2] Pod ID value, [3] Live decl,
 * [4] Live value, [5] Live CCC.
 */
BT_GATT_SERVICE_DEFINE(kuuki_svc,
	BT_GATT_PRIMARY_SERVICE(&kuuki_svc_uuid),
	BT_GATT_CHARACTERISTIC(&pod_id_uuid.uuid, BT_GATT_CHRC_READ,
			       BT_GATT_PERM_READ, read_pod_id, NULL, NULL),
	BT_GATT_CHARACTERISTIC(&live_uuid.uuid,
			       BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_READ, read_live, NULL, NULL),
	BT_GATT_CCC(live_ccc_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
);

#define LIVE_VALUE_ATTR (&kuuki_svc.attrs[4])

/* Name in the advertising data; the 128-bit service UUID (16 bytes) goes in the
 * scan response, where it fits alongside without crowding the 31-byte AD. */
static const struct bt_data ad[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
	BT_DATA(BT_DATA_NAME_COMPLETE, CONFIG_BT_DEVICE_NAME,
		sizeof(CONFIG_BT_DEVICE_NAME) - 1),
};

static const struct bt_data sd[] = {
	BT_DATA_BYTES(BT_DATA_UUID128_ALL, KUUKI_SVC_UUID_VAL),
};

/*
 * Connectable advertising at the slow interval (1.28–1.92 s): the Pod is always
 * reachable but sips power between adverts, matching the overnight-glance use
 * case. Open — no bonding, no privacy (v1 GATT is open, per the spec).
 */
static const struct bt_le_adv_param adv_param = BT_LE_ADV_PARAM_INIT(
	BT_LE_ADV_OPT_CONN, BT_GAP_ADV_SLOW_INT_MIN, BT_GAP_ADV_SLOW_INT_MAX, NULL);

static int start_advertising(void)
{
	return bt_le_adv_start(&adv_param, ad, ARRAY_SIZE(ad), sd, ARRAY_SIZE(sd));
}

static void advertise_work_handler(struct k_work *work)
{
	ARG_UNUSED(work);

	int err = start_advertising();
	if (err) {
		LOG_ERR("Advertising failed to resume (%d)", err);
	}
}

static K_WORK_DEFINE(advertise_work, advertise_work_handler);

/*
 * Connectable advertising stops the instant a client connects, so on disconnect
 * we restart it — otherwise the Pod goes silent after its first Sync and is
 * never reachable again. This is what keeps it "connectable any time" (ticket
 * 06) across repeated visits from one or several clients.
 *
 * The restart is deferred to the system workqueue rather than run inline: the
 * disconnected connection object is not recycled until this callback returns, so
 * starting a connectable advertiser here races it and fails with -ENOMEM.
 */
static void on_disconnected(struct bt_conn *conn, uint8_t reason)
{
	ARG_UNUSED(conn);

	LOG_INF("Disconnected (reason 0x%02x); resuming advertising", reason);
	k_work_submit(&advertise_work);
}

static void on_connected(struct bt_conn *conn, uint8_t err)
{
	ARG_UNUSED(conn);

	if (err) {
		LOG_WRN("Connection failed (0x%02x)", err);
		return;
	}

	LOG_INF("Connected");
}

BT_CONN_CB_DEFINE(conn_callbacks) = {
	.connected = on_connected,
	.disconnected = on_disconnected,
};

void ble_live_update(const struct sample *s)
{
	live_encode(s, live_value);

	if (live_notify_enabled) {
		bt_gatt_notify(NULL, LIVE_VALUE_ATTR, live_value,
			       sizeof(live_value));
	}
}

int ble_start(void)
{
	int err = bt_enable(NULL);
	if (err) {
		LOG_ERR("bt_enable failed (%d)", err);
		return err;
	}

	err = start_advertising();
	if (err) {
		LOG_ERR("Advertising failed to start (%d)", err);
		return err;
	}

	LOG_INF("Advertising started; Pod is connectable");
	return 0;
}
