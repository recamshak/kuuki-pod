/*
 * kuuki-pod firmware — application entry point.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * v1 skeleton: brings the board up and logs a boot banner. Sampling, the
 * in-RAM Buffer, and the BLE GATT service land in later tickets. The
 * correctness-critical logic (e.g. the Buffer collect() query) is developed
 * off-board as pure modules under tests/, run on the host via native_sim.
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(kuuki_pod, LOG_LEVEL_INF);

int main(void)
{
	LOG_INF("kuuki-pod firmware skeleton booted");
	return 0;
}
