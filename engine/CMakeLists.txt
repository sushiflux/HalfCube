cmake_minimum_required(VERSION 3.24)
project(partcraft_engine LANGUAGES CXX)

# Partcraft engine: one C++20 code base built as
#   - partcraft-engine          native process (stdio frames), Windows now, Linux compile-only for CI
#   - partcraft-engine.mjs/.wasm WebAssembly module for the browser's Web Worker (Emscripten)
#   - partcraft-engine-tests    C++ unit tests (native only)
# Third-party sources come from engine/_deps (scripts/fetch-deps.ps1 or scripts/fetch-deps.sh); OCCT is found
# through OpenCASCADE_DIR (the "cmake" folder of an OCCT 8.0.2 installation: shared on Windows and Linux, static for
# WebAssembly with the flags of scripts/build-wasm.ps1).

option(PARTCRAFT_TEST_COMMANDS "Build the test commands diagnostics.crash and diagnostics.hang" OFF)
option(PARTCRAFT_BUILD_TESTS "Build the C++ unit tests (not for WebAssembly)" ON)
option(PARTCRAFT_WARNINGS_AS_ERRORS "Treat warnings in Partcraft's own code as errors" ON)
set(PARTCRAFT_DEPS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/_deps" CACHE PATH "Folder with the fetched third-party sources")

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
if(NOT CMAKE_CONFIGURATION_TYPES AND NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

set(PC_REPO_DIR "${CMAKE_CURRENT_SOURCE_DIR}/..")
set(PC_MANIFEST "${PC_REPO_DIR}/third_party/manifest.json")
include(cmake/PartcraftDeps.cmake)

# ------------------------------------------------------------------------------------------------ version and build facts

set(PC_VERSION "v0.0.0-dev")
set(PC_VERSION_FULL "v0.0.0-dev")
if(EXISTS "${PC_REPO_DIR}/version.txt")
    file(STRINGS "${PC_REPO_DIR}/version.txt" _pc_version_lines LIMIT_COUNT 2)
    list(LENGTH _pc_version_lines _pc_n)
    if(_pc_n GREATER_EQUAL 1)
        list(GET _pc_version_lines 0 PC_VERSION)
        set(PC_VERSION_FULL "${PC_VERSION}")
    endif()
    if(_pc_n GREATER_EQUAL 2)
        list(GET _pc_version_lines 1 PC_VERSION_FULL)
    endif()
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${PC_REPO_DIR}/version.txt")
endif()

if(EMSCRIPTEN)
    set(PC_PLATFORM "wasm")
    set(PC_OS "wasm32")
elseif(WIN32)
    set(PC_PLATFORM "native")
    if(CMAKE_SIZEOF_VOID_P EQUAL 8)
        set(PC_OS "windows-x64")
    else()
        set(PC_OS "windows-x86")
    endif()
else()
    set(PC_PLATFORM "native")
    string(TOLOWER "${CMAKE_SYSTEM_NAME}-${CMAKE_SYSTEM_PROCESSOR}" PC_OS)
    string(REPLACE "x86_64" "x64" PC_OS "${PC_OS}")
endif()
set(PC_COMPILER "${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}")
if(PARTCRAFT_TEST_COMMANDS)
    set(PC_TEST_COMMANDS_CXX "true")
else()
    set(PC_TEST_COMMANDS_CXX "false")
endif()
configure_file(src/core/build_info.hpp.in "${CMAKE_BINARY_DIR}/generated/partcraft/build_info.hpp" @ONLY)

# ------------------------------------------------------------------------------------------------ OCCT

find_package(OpenCASCADE 8.0.2 EXACT CONFIG REQUIRED)
set(PC_OCCT_LIBS TKernel TKMath TKG2d TKG3d TKGeomBase TKBRep TKGeomAlgo TKTopAlgo TKPrim TKBO TKShHealing TKBool
    TKFillet TKOffset TKMesh)

# ------------------------------------------------------------------------------------------------ compile flags

# Flags of Partcraft's own code. Third-party code is compiled without warnings (see cmake/PartcraftDeps.cmake) and
# included as SYSTEM headers, so its warnings do not show up here.
if(MSVC)
    # /EHsc on purpose: hardware faults (access violation, division by zero) must not be caught by catch (...);
    # they end the native process and the desktop supervisor restarts it. OCCT itself is built with /EHa.
    set(PC_WARNING_FLAGS /W4 /permissive- /utf-8 /Zc:__cplusplus /EHsc /bigobj)
    if(PARTCRAFT_WARNINGS_AS_ERRORS)
        list(APPEND PC_WARNING_FLAGS /WX)
    endif()
else()
    set(PC_WARNING_FLAGS -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wsign-conversion -Wnon-virtual-dtor
        -Woverloaded-virtual)
    if(PARTCRAFT_WARNINGS_AS_ERRORS)
        list(APPEND PC_WARNING_FLAGS -Werror)
    endif()
endif()

if(EMSCRIPTEN)
    # Must match the static OCCT build: native WebAssembly exceptions, OCCT's signal conversion off (with it the
    # -fwasm-exceptions link fails in wasm-opt). "-include mutex" is only needed to compile OCCT itself.
    set(PC_PLATFORM_FLAGS -fwasm-exceptions -UOCC_CONVERT_SIGNALS)
elseif(NOT MSVC)
    # OCCT builds with OCC_CONVERT_SIGNALS on non-MSVC native targets; its headers must see the same setting.
    set(PC_PLATFORM_FLAGS -DOCC_CONVERT_SIGNALS)
endif()

# ------------------------------------------------------------------------------------------------ engine core library

add_library(partcraft_engine_core STATIC
    src/core/engine.cpp
    src/core/errors.cpp
    src/core/frame.cpp
    src/kernel/shape_check.cpp
    src/kernel/kernel_selftest.cpp
    src/model/document.cpp
    src/model/profiles.cpp
    src/model/geometry.cpp
    src/model/model.cpp
    src/sketch/sketch.cpp
    src/sketch/sketch_solver.cpp
    src/sketch/sketch_check.cpp
    src/sketch/sketch_freedom.cpp
    src/sketch/solver_selftest.cpp
    src/diagnostics/test_commands.cpp)
target_include_directories(partcraft_engine_core PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
    "${CMAKE_BINARY_DIR}/generated")
target_include_directories(partcraft_engine_core SYSTEM PUBLIC ${OpenCASCADE_INCLUDE_DIR})
target_link_libraries(partcraft_engine_core PUBLIC ${PC_OCCT_LIBS} pc::json PRIVATE pc::planegcs)
target_compile_options(partcraft_engine_core PRIVATE ${PC_WARNING_FLAGS} PUBLIC ${PC_PLATFORM_FLAGS})
target_compile_definitions(partcraft_engine_core PRIVATE "PC_BUILD_TYPE=\"$<CONFIG>\""
    PUBLIC $<$<BOOL:${PARTCRAFT_TEST_COMMANDS}>:PARTCRAFT_TEST_COMMANDS=1>)
if(NOT EMSCRIPTEN)
    find_package(Threads REQUIRED)
    target_link_libraries(partcraft_engine_core PUBLIC Threads::Threads)
endif()

# Linux: binaries in the build tree find the OCCT shared libraries without LD_LIBRARY_PATH. DT_RPATH instead of the
# default DT_RUNPATH, because only DT_RPATH also applies to the OCCT libraries loading each other.
function(pc_linux_build_rpath target)
    set_target_properties(${target} PROPERTIES BUILD_RPATH "${OpenCASCADE_LIBRARY_DIR}")
    target_link_options(${target} PRIVATE "LINKER:--disable-new-dtags")
endfunction()

# ------------------------------------------------------------------------------------------------ engine executable

if(EMSCRIPTEN)
    add_executable(partcraft-engine src/platform/main_wasm.cpp)
    set_target_properties(partcraft-engine PROPERTIES SUFFIX ".mjs")
    target_link_options(partcraft-engine PRIVATE
        -fwasm-exceptions
        -sMODULARIZE=1
        -sEXPORT_ES6=1
        -sEXPORT_NAME=createEngineModule
        -sENVIRONMENT=web,worker,node
        # Memory grows on demand so large sketches and bodies fit; 4 GB is the wasm32 limit.
        -sALLOW_MEMORY_GROWTH=1
        -sINITIAL_MEMORY=32MB
        -sMAXIMUM_MEMORY=4GB
        # Explicit stack: the solver needs more than Emscripten's default of 64 KB for interactive sketch solving;
        # 4 MB leaves room for large sketches and the kernel's recursion on bodies.
        -sSTACK_SIZE=4MB
        -sEXIT_RUNTIME=0
        -sINVOKE_RUN=0
        -sEXPORTED_FUNCTIONS=_pc_init,_pc_handle,_malloc,_free
        -sEXPORTED_RUNTIME_METHODS=HEAPU8)
else()
    add_executable(partcraft-engine src/platform/main_native.cpp)
endif()
target_link_libraries(partcraft-engine PRIVATE partcraft_engine_core)
target_compile_options(partcraft-engine PRIVATE ${PC_WARNING_FLAGS})

if(WIN32)
    # The OCCT DLLs go next to the executable so the engine starts without PATH changes.
    add_custom_command(TARGET partcraft-engine POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_RUNTIME_DLLS:partcraft-engine> $<TARGET_FILE_DIR:partcraft-engine>
        COMMAND_EXPAND_LISTS)
endif()

# ------------------------------------------------------------------------------------------------ unit tests

if(PARTCRAFT_BUILD_TESTS AND NOT EMSCRIPTEN)
    enable_testing()
    add_executable(partcraft-engine-tests
        tests/unit/main.cpp
        tests/unit/frame_test.cpp
        tests/unit/engine_test.cpp
        tests/unit/kernel_test.cpp
        tests/unit/sketch_solver_test.cpp
        tests/unit/model_test.cpp)
    target_link_libraries(partcraft-engine-tests PRIVATE partcraft_engine_core pc::doctest)
    target_compile_options(partcraft-engine-tests PRIVATE ${PC_WARNING_FLAGS})
    if(WIN32)
        add_custom_command(TARGET partcraft-engine-tests POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_RUNTIME_DLLS:partcraft-engine-tests> $<TARGET_FILE_DIR:partcraft-engine-tests>
            COMMAND_EXPAND_LISTS)
    elseif(UNIX)
        pc_linux_build_rpath(partcraft-engine-tests)
    endif()
    add_test(NAME engine-unit-tests COMMAND partcraft-engine-tests)
endif()

if(UNIX AND NOT EMSCRIPTEN)
    pc_linux_build_rpath(partcraft-engine)
endif()

message(STATUS "Partcraft engine ${PC_VERSION_FULL}: platform ${PC_PLATFORM} (${PC_OS}), test commands ${PARTCRAFT_TEST_COMMANDS}, "
    "OCCT ${OpenCASCADE_VERSION}, planegcs ${PC_PLANEGCS_SOURCE} ${PC_PLANEGCS_COMMIT}")
