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

#include <zephyr/bluetooth/att.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/sys/util.h>

#include "ble.h"
#include "buffer.h"
#include "live.h"
#include "pod_id.h"
#include "sync.h"

LOG_MODULE_REGISTER(ble, LOG_LEVEL_INF);

/*
 * Custom 128-bit UUIDs. The base spells "kuuki-pod" in ASCII (4b 75 75 6b =
 * "Kuuk", 69 2d = "i-", 70 6f = "po", 64 = "d") so it is recognisable in a
 * generic client; the trailing 16-bit field selects the service and each
 * characteristic. 0x0004 is the Sync control (client writes its High-water mark
 * to begin a Sync); 0x0005 is the Sync data stream (records notified back).
 */
#define KUUKI_SVC_UUID_VAL \
	BT_UUID_128_ENCODE(0x4b75756b, 0x692d, 0x706f, 0x6400, 0x000000000001)
#define KUUKI_POD_ID_UUID_VAL \
	BT_UUID_128_ENCODE(0x4b75756b, 0x692d, 0x706f, 0x6400, 0x000000000002)
#define KUUKI_LIVE_UUID_VAL \
	BT_UUID_128_ENCODE(0x4b75756b, 0x692d, 0x706f, 0x6400, 0x000000000003)
#define KUUKI_SYNC_CTRL_UUID_VAL \
	BT_UUID_128_ENCODE(0x4b75756b, 0x692d, 0x706f, 0x6400, 0x000000000004)
#define KUUKI_SYNC_DATA_UUID_VAL \
	BT_UUID_128_ENCODE(0x4b75756b, 0x692d, 0x706f, 0x6400, 0x000000000005)

static const struct bt_uuid_128 kuuki_svc_uuid = BT_UUID_INIT_128(KUUKI_SVC_UUID_VAL);
static const struct bt_uuid_128 pod_id_uuid = BT_UUID_INIT_128(KUUKI_POD_ID_UUID_VAL);
static const struct bt_uuid_128 live_uuid = BT_UUID_INIT_128(KUUKI_LIVE_UUID_VAL);
static const struct bt_uuid_128 sync_ctrl_uuid = BT_UUID_INIT_128(KUUKI_SYNC_CTRL_UUID_VAL);
static const struct bt_uuid_128 sync_data_uuid = BT_UUID_INIT_128(KUUKI_SYNC_DATA_UUID_VAL);

/* The most recent Live reading, kept encoded and ready to serve on a read or
 * notify. Seeded all-zero until the first Measurement is published: co2 == 0 is
 * the wire contract's "no Measurement yet" sentinel, so a client that reads in
 * the ~30 s before the first Measurement sees "not available" rather than a
 * bogus 0-ppm reading (docs/wire-contract.md, Live reading characteristic). */
static uint8_t live_value[LIVE_READING_SIZE];

/* Whether a client has subscribed to Live reading notifications. */
static bool live_notify_enabled;

/*
 * Sync (ticket 07) state. The Buffer and its lock are borrowed from the
 * application for the Pod's lifetime; collect() reads the Buffer under the lock
 * so the sampler's concurrent buffer_put() is never observed half-written.
 */
static struct buffer *sync_buffer;
static struct k_mutex *sync_buffer_lock;

/* Whether a client has subscribed to Sync data notifications. */
static bool sync_notify_enabled;

/*
 * The pending Sync's parameters, published by the Sync control write and
 * consumed by the sync thread. latch_uptime is the single Latched read instant
 * for the batch (CONTEXT.md): every record's Age is measured against it. The two
 * fields are written and snapshotted as a unit under the scheduler lock, so a
 * second control write racing the consumer can never split a new latch onto an
 * old mark — last write wins, and a client Syncs one batch at a time anyway.
 */
static struct {
	uint32_t latch_uptime;
	uint32_t mark;
} sync_request;

/* Signals the sync thread that a Sync control write is pending. */
static K_SEM_DEFINE(sync_pending, 0, 1);

/*
 * The one active connection (CONFIG_BT_MAX_CONN == 1), ref-held between connect
 * and disconnect. The sync thread needs it for the negotiated MTU and as the
 * notify target; tracking it lets a mid-Sync disconnect abort the stream.
 */
static struct bt_conn *active_conn;

/*
 * Scratch for one Sync, owned solely by the sync thread. The record set is
 * materialised here by collect() (up to the whole Buffer), then encoded a
 * notification at a time into ntf_payload. Static, not on the thread stack:
 * together they are ~34 KB. ntf_payload is sized for the largest configured
 * notification so a runtime MTU (never larger) always fits.
 */
static struct sync_record sync_records[BUFFER_CAPACITY];
static uint8_t ntf_payload[CONFIG_BT_L2CAP_TX_MTU - ATT_NTF_OVERHEAD];

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
 * A client begins a Sync by writing its High-water mark (a 4-byte Age, or the
 * sentinel) to the Sync control characteristic. We latch exactly one read
 * instant for the whole batch here — the moment of the write — and hand the mark
 * to the sync thread, which computes and streams the record set. The write
 * returns immediately; the potentially long notify stream runs off this thread.
 */
static ssize_t write_sync_control(struct bt_conn *conn, const struct bt_gatt_attr *attr,
				  const void *buf, uint16_t len, uint16_t offset,
				  uint8_t flags)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(attr);
	ARG_UNUSED(flags);

	if (offset != 0) {
		return BT_GATT_ERR(BT_ATT_ERR_INVALID_OFFSET);
	}
	if (len != sizeof(uint32_t)) {
		return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
	}

	/* Latch the single read instant for this batch before anything else, so
	 * transfer latency shifts the whole series uniformly (CONTEXT.md). Publish
	 * it with the mark as a unit, so the sync thread never reads a torn pair. */
	k_sched_lock();
	sync_request.latch_uptime = (uint32_t)(k_uptime_get() / 1000);
	sync_request.mark = sys_get_le32(buf);
	k_sched_unlock();

	k_sem_give(&sync_pending);

	return len;
}

static void sync_ccc_changed(const struct bt_gatt_attr *attr, uint16_t value)
{
	ARG_UNUSED(attr);

	sync_notify_enabled = (value == BT_GATT_CCC_NOTIFY);
	LOG_INF("Sync data notifications %s",
		sync_notify_enabled ? "enabled" : "disabled");
}

/*
 * The single custom service. Attribute order is fixed by this macro. Two value
 * attributes are referenced by handle for bt_gatt_notify():
 *   [0] service        [1] Pod ID decl    [2] Pod ID value
 *   [3] Live decl      [4] Live value     [5] Live CCC
 *   [6] Sync ctrl decl [7] Sync ctrl val  [8] Sync data decl
 *   [9] Sync data val  [10] Sync data CCC
 * Live value is index 4, Sync data value is index 9.
 */
BT_GATT_SERVICE_DEFINE(kuuki_svc,
	BT_GATT_PRIMARY_SERVICE(&kuuki_svc_uuid),
	BT_GATT_CHARACTERISTIC(&pod_id_uuid.uuid, BT_GATT_CHRC_READ,
			       BT_GATT_PERM_READ, read_pod_id, NULL, NULL),
	BT_GATT_CHARACTERISTIC(&live_uuid.uuid,
			       BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_READ, read_live, NULL, NULL),
	BT_GATT_CCC(live_ccc_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
	BT_GATT_CHARACTERISTIC(&sync_ctrl_uuid.uuid, BT_GATT_CHRC_WRITE,
			       BT_GATT_PERM_WRITE, NULL, write_sync_control, NULL),
	BT_GATT_CHARACTERISTIC(&sync_data_uuid.uuid, BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_NONE, NULL, NULL, NULL),
	BT_GATT_CCC(sync_ccc_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
);

#define LIVE_VALUE_ATTR (&kuuki_svc.attrs[4])
#define SYNC_DATA_VALUE_ATTR (&kuuki_svc.attrs[9])

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
	/* Drop our reference so a sync thread that snapshotted the connection
	 * sees it go away and aborts a mid-Sync stream (which the next Sync's
	 * advanced High-water mark re-fetches, ADR-0002). */
	if (active_conn == conn) {
		bt_conn_unref(active_conn);
		active_conn = NULL;
	}

	LOG_INF("Disconnected (reason 0x%02x); resuming advertising", reason);
	k_work_submit(&advertise_work);
}

static void on_connected(struct bt_conn *conn, uint8_t err)
{
	if (err) {
		LOG_WRN("Connection failed (0x%02x)", err);
		return;
	}

	active_conn = bt_conn_ref(conn);
	LOG_INF("Connected");
}

BT_CONN_CB_DEFINE(conn_callbacks) = {
	.connected = on_connected,
	.disconnected = on_disconnected,
};

#define SYNC_STACK_SIZE 2048
#define SYNC_PRIORITY   7

static K_THREAD_STACK_DEFINE(sync_stack, SYNC_STACK_SIZE);
static struct k_thread sync_thread;

/*
 * Send one Sync data notification, blocking until the stack accepts it. GATT TX
 * buffers are a small pool, so a burst of notifications transiently exhausts it
 * (-ENOMEM); we back off and retry rather than drop records. Any other error —
 * notably the connection dropping — ends the stream: the batch is left
 * unterminated (no end-of-batch marker), which is exactly the client's
 * "incomplete Sync" signal (docs/wire-contract.md). len == 0 sends the
 * end-of-batch marker itself.
 */
static int sync_notify(struct bt_conn *conn, const void *data, uint16_t len)
{
	int err;

	while ((err = bt_gatt_notify(conn, SYNC_DATA_VALUE_ATTR, data, len)) == -ENOMEM) {
		k_sleep(K_MSEC(10));
	}
	return err;
}

/*
 * Encode the count collected records into notifications and stream them
 * oldest-first over conn, packing as many whole records per notification as the
 * negotiated MTU allows, then send the zero-length end-of-batch marker. count
 * may be 0 — an up-to-date client gets only the marker (a valid, empty Sync).
 */
static void stream_batch(struct bt_conn *conn, size_t count)
{
	uint16_t mtu = bt_gatt_get_mtu(conn);
	size_t per_ntf = sync_records_per_notification(mtu);

	if (per_ntf == 0) {
		LOG_WRN("Negotiated MTU %u too small for a Sync record; aborting", mtu);
		return;
	}

	for (size_t sent = 0; sent < count; sent += per_ntf) {
		size_t chunk = MIN(per_ntf, count - sent);

		for (size_t i = 0; i < chunk; i++) {
			sync_encode_record(&sync_records[sent + i],
					   &ntf_payload[i * RECORD_SIZE]);
		}

		if (sync_notify(conn, ntf_payload, chunk * RECORD_SIZE)) {
			LOG_WRN("Sync stream interrupted after %zu/%zu records; "
				"next Sync self-heals", sent, count);
			return;
		}
	}

	if (sync_notify(conn, ntf_payload, 0)) {
		LOG_WRN("Sync end-of-batch marker not delivered; next Sync self-heals");
		return;
	}

	LOG_INF("Sync complete: %zu records streamed", count);
}

static void sync_thread_run(void *p1, void *p2, void *p3)
{
	ARG_UNUSED(p1);
	ARG_UNUSED(p2);
	ARG_UNUSED(p3);

	for (;;) {
		k_sem_take(&sync_pending, K_FOREVER);

		if (!sync_notify_enabled) {
			LOG_WRN("Sync control written without subscribing to Sync "
				"data; nothing to stream to");
			continue;
		}

		/* Snapshot the pending request and take our own reference to the
		 * connection as one unit: under the scheduler lock neither the
		 * control write (updating the request) nor the disconnect callback
		 * (freeing the connection) can run mid-snapshot. Our own ref keeps
		 * the connection alive even if it drops mid-stream. */
		k_sched_lock();
		uint32_t latch_uptime = sync_request.latch_uptime;
		uint32_t mark = sync_request.mark;
		struct bt_conn *conn = active_conn ? bt_conn_ref(active_conn) : NULL;
		k_sched_unlock();

		if (!conn) {
			continue;
		}

		/* Compute the record set under the lock so collect() never reads
		 * a Buffer the sampler is mid-write on; release before the slow
		 * notify streaming so a Sample tick isn't stalled by it. */
		k_mutex_lock(sync_buffer_lock, K_FOREVER);
		size_t count = buffer_collect(sync_buffer, latch_uptime, mark,
					      sync_records, BUFFER_CAPACITY);
		k_mutex_unlock(sync_buffer_lock);

		stream_batch(conn, count);
		bt_conn_unref(conn);
	}
}

void ble_live_update(const struct sample *s)
{
	live_encode(s, live_value);

	if (live_notify_enabled) {
		bt_gatt_notify(NULL, LIVE_VALUE_ATTR, live_value,
			       sizeof(live_value));
	}
}

int ble_start(struct buffer *buf, struct k_mutex *buf_lock)
{
	sync_buffer = buf;
	sync_buffer_lock = buf_lock;

	int err = bt_enable(NULL);
	if (err) {
		LOG_ERR("bt_enable failed (%d)", err);
		return err;
	}

	/* The sync thread streams a Sync off the BLE RX path: the Sync control
	 * write only latches and signals, so a long stream never blocks it. */
	k_thread_create(&sync_thread, sync_stack, SYNC_STACK_SIZE, sync_thread_run,
			NULL, NULL, NULL, SYNC_PRIORITY, 0, K_NO_WAIT);
	k_thread_name_set(&sync_thread, "ble_sync");

	err = start_advertising();
	if (err) {
		LOG_ERR("Advertising failed to start (%d)", err);
		return err;
	}

	LOG_INF("Advertising started; Pod is connectable");
	return 0;
}
