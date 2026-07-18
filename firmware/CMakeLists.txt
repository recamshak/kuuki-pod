# SPDX-License-Identifier: Apache-2.0

cmake_minimum_required(VERSION 3.20.0)
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(kuuki_pod)

target_sources(app PRIVATE
  src/main.c
  src/buffer.c
  src/measurement.c
  src/sampler.c
  src/live.c
  src/sync.c
  src/pod_id.c
  src/ble.c
)
