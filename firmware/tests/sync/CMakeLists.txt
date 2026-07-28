# SPDX-License-Identifier: Apache-2.0

cmake_minimum_required(VERSION 3.20.0)
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(kuuki_pod_sync_test)

# The whole Sync seam is pure: compile the production sources straight into the
# host test binary and exercise them through their public API. buffer.c comes
# along because sync_collect() answers a Sync over a real Buffer — the trim is
# tested through the Buffer's public snapshot, never a stubbed one.
set(KUUKI_SRC ${CMAKE_CURRENT_SOURCE_DIR}/../../src)
target_include_directories(app PRIVATE ${KUUKI_SRC})
target_sources(app PRIVATE
  src/main.c
  ${KUUKI_SRC}/sync.c
  ${KUUKI_SRC}/buffer.c
)
