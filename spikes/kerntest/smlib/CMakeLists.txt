# Kernel test, track SMLib: builds the USD BRep kernel layers (SMLib + SM_API) without
# OpenUSD, Python, Hydra or TBB, plus the test program. One CMake build for MSVC, GCC
# and Emscripten. The upstream premake build is not used here.
cmake_minimum_required(VERSION 3.24)
project(halfcube_kerntest_smlib LANGUAGES CXX)

set(SMLIB_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../_deps/usd-brep" CACHE PATH "usd-brep source checkout")
if(NOT EXISTS "${SMLIB_ROOT}/source/SMLib/inc/SmBrep.h")
  message(FATAL_ERROR "usd-brep sources not found at ${SMLIB_ROOT}; run scripts/fetch-sources.ps1 or fetch-sources.sh")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()
# Release optimisation as in the upstream premake build ("optimize On": /O2 resp. -O2).
if(MSVC)
  set(CMAKE_CXX_FLAGS_RELEASE "/O2 /Ob2 /DNDEBUG")
else()
  set(CMAKE_CXX_FLAGS_RELEASE "-O2 -DNDEBUG")
endif()

if(EMSCRIPTEN)
  set(_default_shared OFF)
else()
  set(_default_shared ON)
endif()
option(SMLIB_SHARED "Build SMLib and SM_API as shared libraries (as upstream does)" ${_default_shared})
option(SMLIB_PCH "Use StdAfx.h as precompiled header (upstream does this on Windows)" ON)
if(SMLIB_SHARED)
  set(_kind SHARED)
else()
  set(_kind STATIC)
endif()

file(GLOB SMLIB_SOURCES CONFIGURE_DEPENDS "${SMLIB_ROOT}/source/SMLib/src/*.cpp")
file(GLOB SMAPI_SOURCES CONFIGURE_DEPENDS "${SMLIB_ROOT}/source/SM_API/src/*.cpp")

# Defines of the upstream release configuration (premake5.lua), minus TBB.
set(_common_defs NDEBUG NOMINMAX SM_GRAPHICS_CALLBACKS=1)

function(smlib_apply_flags tgt)
  target_compile_definitions(${tgt} PRIVATE ${_common_defs})
  if(MSVC)
    # Upstream: CharacterSet Unicode, /utf-8 /bigobj, the same warning suppressions.
    target_compile_definitions(${tgt} PRIVATE UNICODE _UNICODE NL_DEBUG_CODE _SCL_SECURE_NO_WARNINGS)
    target_compile_options(${tgt} PRIVATE /utf-8 /bigobj /W4 /wd4244 /wd4305 /wd4267 /EHsc /GR)
  else()
    target_compile_options(${tgt} PRIVATE -Wall -Wno-write-strings)
  endif()
endfunction()

add_library(SMLib ${_kind} ${SMLIB_SOURCES})
target_include_directories(SMLib PUBLIC "${SMLIB_ROOT}/source/SMLib/inc")
smlib_apply_flags(SMLib)
if(SMLIB_PCH)
  target_precompile_headers(SMLib PRIVATE "${SMLIB_ROOT}/source/SMLib/inc/StdAfx.h")
endif()

add_library(SM_API ${_kind} ${SMAPI_SOURCES})
target_include_directories(SM_API PUBLIC "${SMLIB_ROOT}/source/SM_API/inc")
target_link_libraries(SM_API PUBLIC SMLib)
target_compile_definitions(SM_API PRIVATE SM_API_EXPORTS)
smlib_apply_flags(SM_API)
if(SMLIB_PCH)
  target_precompile_headers(SM_API PRIVATE "${SMLIB_ROOT}/source/SM_API/inc/StdAfx.h")
endif()

if(UNIX AND NOT EMSCRIPTEN)
  find_package(Threads REQUIRED)
  target_link_libraries(SMLib PUBLIC Threads::Threads ${CMAKE_DL_LIBS})
endif()

# Test program
add_executable(smlib_kerntest src/main.cpp src/cases.cpp src/report.cpp src/kt.h)
target_link_libraries(smlib_kerntest PRIVATE SM_API SMLib)
file(READ "${SMLIB_ROOT}/VERSION" _usd_brep_version)
string(STRIP "${_usd_brep_version}" _usd_brep_version)
string(TOUPPER "${CMAKE_BUILD_TYPE}" _bt)
target_compile_definitions(smlib_kerntest PRIVATE ${_common_defs}
  KT_USD_BREP_VERSION="${_usd_brep_version}"
  KT_CXX_FLAGS="${CMAKE_CXX_FLAGS} ${CMAKE_CXX_FLAGS_${_bt}}")
if(MSVC)
  target_compile_definitions(smlib_kerntest PRIVATE UNICODE _UNICODE)
  target_compile_options(smlib_kerntest PRIVATE /utf-8 /bigobj /W4 /wd4244 /wd4305 /wd4267 /EHsc /Zc:__cplusplus)
endif()

if(EMSCRIPTEN)
  # Node.js target. The module is loaded with MODULARIZE so the runner (scripts/run-wasm.mjs)
  # can time instantiation; the runtime stays alive after main so the runner can read the
  # final (= peak, memory only grows) linear memory size.
  # Exceptions: SMLib reports memory errors with C++ exceptions (SmConfig.h, SM_USE_EXCEPTIONS).
  # KT_WASM_EH=wasm uses native WebAssembly exception handling, =js the older JS-based one.
  set(KT_WASM_EH "wasm" CACHE STRING "wasm or js exception handling")
  # Start size of linear memory; a small value makes the grown size show the real peak.
  set(KT_WASM_INITIAL_MEMORY "64MB" CACHE STRING "initial linear memory")
  if(KT_WASM_EH STREQUAL "wasm")
    set(_eh -fwasm-exceptions)
  else()
    set(_eh -fexceptions)
  endif()
  target_link_options(smlib_kerntest PRIVATE
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=${KT_WASM_INITIAL_MEMORY}
    -sMAXIMUM_MEMORY=4GB
    -sSTACK_SIZE=8MB
    -sEXIT_RUNTIME=0
    -sENVIRONMENT=node
    -sNODERAWFS=1
    -sMODULARIZE=1
    -sEXPORT_NAME=createKerntest
    -sINVOKE_RUN=0
    -sEXPORTED_RUNTIME_METHODS=callMain,HEAPU8
    ${_eh})
  target_compile_options(smlib_kerntest PRIVATE ${_eh})
  target_compile_options(SMLib PRIVATE ${_eh})
  target_compile_options(SM_API PRIVATE ${_eh})
  set_target_properties(smlib_kerntest PROPERTIES SUFFIX ".js")
endif()
