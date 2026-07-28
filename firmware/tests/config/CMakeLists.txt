# SPDX-License-Identifier: Apache-2.0

cmake_minimum_required(VERSION 3.20.0)

# Build against the application's own Kconfig tree, so this suite sees the real
# CONFIG_KUUKI_* parameters (and their defaults) rather than a test-local copy.
set(KCONFIG_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../../Kconfig)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(kuuki_pod_config_test)

# app_config.h is a header-only derivation over CONFIG_KUUKI_*: nothing to
# compile but the test itself.
set(KUUKI_SRC ${CMAKE_CURRENT_SOURCE_DIR}/../../src)
target_include_directories(app PRIVATE ${KUUKI_SRC})
target_sources(app PRIVATE
  src/main.c
)
