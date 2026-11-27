cmake_minimum_required(VERSION 3.24)
project(halfcube_engine LANGUAGES CXX)

# HalfCube engine: one C++20 code base built as
#   - halfcube-engine          native process (stdio frames), Windows now, Linux compile-only for CI
#   - halfcube-engine-tests    C++ unit tests
# Third-party sources come from engine/_deps (scripts/fetch-deps.ps1 or scripts/fetch-deps.sh); OCCT is found
# through OpenCASCADE_DIR (the "cmake" folder of an OCCT 8.0.2 installation, built as shared libraries).

option(HALFCUBE_TEST_COMMANDS "Build the test commands diagnostics.crash and diagnostics.hang" OFF)
option(HALFCUBE_BUILD_TESTS "Build the C++ unit tests" ON)
option(HALFCUBE_WARNINGS_AS_ERRORS "Treat warnings in HalfCube's own code as errors" ON)
set(HALFCUBE_DEPS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/_deps" CACHE PATH "Folder with the fetched third-party sources")

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
if(NOT CMAKE_CONFIGURATION_TYPES AND NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

set(HC_REPO_DIR "${CMAKE_CURRENT_SOURCE_DIR}/..")
set(HC_MANIFEST "${HC_REPO_DIR}/third_party/manifest.json")
include(cmake/HalfCubeDeps.cmake)

# ------------------------------------------------------------------------------------------------ version and build facts

set(HC_VERSION "v0.0.0-dev")
set(HC_VERSION_FULL "v0.0.0-dev")
if(EXISTS "${HC_REPO_DIR}/version.txt")
    file(STRINGS "${HC_REPO_DIR}/version.txt" _hc_version_lines LIMIT_COUNT 2)
    list(LENGTH _hc_version_lines _hc_n)
    if(_hc_n GREATER_EQUAL 1)
        list(GET _hc_version_lines 0 HC_VERSION)
        set(HC_VERSION_FULL "${HC_VERSION}")
    endif()
    if(_hc_n GREATER_EQUAL 2)
        list(GET _hc_version_lines 1 HC_VERSION_FULL)
    endif()
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${HC_REPO_DIR}/version.txt")
endif()

if(WIN32)
    set(HC_PLATFORM "native")
    if(CMAKE_SIZEOF_VOID_P EQUAL 8)
        set(HC_OS "windows-x64")
    else()
        set(HC_OS "windows-x86")
    endif()
else()
    set(HC_PLATFORM "native")
    string(TOLOWER "${CMAKE_SYSTEM_NAME}-${CMAKE_SYSTEM_PROCESSOR}" HC_OS)
    string(REPLACE "x86_64" "x64" HC_OS "${HC_OS}")
endif()
set(HC_COMPILER "${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}")
if(HALFCUBE_TEST_COMMANDS)
    set(HC_TEST_COMMANDS_CXX "true")
else()
    set(HC_TEST_COMMANDS_CXX "false")
endif()
configure_file(src/core/build_info.hpp.in "${CMAKE_BINARY_DIR}/generated/halfcube/build_info.hpp" @ONLY)

# ------------------------------------------------------------------------------------------------ OCCT

find_package(OpenCASCADE 8.0.2 EXACT CONFIG REQUIRED)
set(HC_OCCT_LIBS TKernel TKMath TKG2d TKG3d TKGeomBase TKBRep TKGeomAlgo TKTopAlgo TKPrim TKBO TKShHealing TKBool
    TKFillet TKOffset TKMesh)

# ------------------------------------------------------------------------------------------------ compile flags

# Flags of HalfCube's own code. Third-party code is compiled without warnings (see cmake/HalfCubeDeps.cmake) and
# included as SYSTEM headers, so its warnings do not show up here.
if(MSVC)
    # /EHsc on purpose: hardware faults (access violation, division by zero) must not be caught by catch (...);
    # they end the native process and the desktop supervisor restarts it. OCCT itself is built with /EHa.
    set(HC_WARNING_FLAGS /W4 /permissive- /utf-8 /Zc:__cplusplus /EHsc /bigobj)
    if(HALFCUBE_WARNINGS_AS_ERRORS)
        list(APPEND HC_WARNING_FLAGS /WX)
    endif()
else()
    set(HC_WARNING_FLAGS -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wsign-conversion -Wnon-virtual-dtor
        -Woverloaded-virtual)
    if(HALFCUBE_WARNINGS_AS_ERRORS)
        list(APPEND HC_WARNING_FLAGS -Werror)
    endif()
endif()

if(NOT MSVC)
    # OCCT builds with OCC_CONVERT_SIGNALS on non-MSVC native targets; its headers must see the same setting.
    set(HC_PLATFORM_FLAGS -DOCC_CONVERT_SIGNALS)
endif()

# ------------------------------------------------------------------------------------------------ engine core library

add_library(halfcube_engine_core STATIC
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
target_include_directories(halfcube_engine_core PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
    "${CMAKE_BINARY_DIR}/generated")
target_include_directories(halfcube_engine_core SYSTEM PUBLIC ${OpenCASCADE_INCLUDE_DIR})
target_link_libraries(halfcube_engine_core PUBLIC ${HC_OCCT_LIBS} hc::json PRIVATE hc::planegcs)
target_compile_options(halfcube_engine_core PRIVATE ${HC_WARNING_FLAGS} PUBLIC ${HC_PLATFORM_FLAGS})
target_compile_definitions(halfcube_engine_core PRIVATE "HC_BUILD_TYPE=\"$<CONFIG>\""
    PUBLIC $<$<BOOL:${HALFCUBE_TEST_COMMANDS}>:HALFCUBE_TEST_COMMANDS=1>)
find_package(Threads REQUIRED)
target_link_libraries(halfcube_engine_core PUBLIC Threads::Threads)

# Linux: binaries in the build tree find the OCCT shared libraries without LD_LIBRARY_PATH. DT_RPATH instead of the
# default DT_RUNPATH, because only DT_RPATH also applies to the OCCT libraries loading each other.
function(hc_linux_build_rpath target)
    set_target_properties(${target} PROPERTIES BUILD_RPATH "${OpenCASCADE_LIBRARY_DIR}")
    target_link_options(${target} PRIVATE "LINKER:--disable-new-dtags")
endfunction()

# ------------------------------------------------------------------------------------------------ engine executable

add_executable(halfcube-engine src/platform/main_native.cpp)
target_link_libraries(halfcube-engine PRIVATE halfcube_engine_core)
target_compile_options(halfcube-engine PRIVATE ${HC_WARNING_FLAGS})

if(WIN32)
    # The OCCT DLLs go next to the executable so the engine starts without PATH changes.
    add_custom_command(TARGET halfcube-engine POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_RUNTIME_DLLS:halfcube-engine> $<TARGET_FILE_DIR:halfcube-engine>
        COMMAND_EXPAND_LISTS)
endif()

# ------------------------------------------------------------------------------------------------ unit tests

if(HALFCUBE_BUILD_TESTS)
    enable_testing()
    add_executable(halfcube-engine-tests
        tests/unit/main.cpp
        tests/unit/frame_test.cpp
        tests/unit/engine_test.cpp
        tests/unit/kernel_test.cpp
        tests/unit/sketch_solver_test.cpp
        tests/unit/model_test.cpp)
    target_link_libraries(halfcube-engine-tests PRIVATE halfcube_engine_core hc::doctest)
    target_compile_options(halfcube-engine-tests PRIVATE ${HC_WARNING_FLAGS})
    if(WIN32)
        add_custom_command(TARGET halfcube-engine-tests POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_RUNTIME_DLLS:halfcube-engine-tests> $<TARGET_FILE_DIR:halfcube-engine-tests>
            COMMAND_EXPAND_LISTS)
    elseif(UNIX)
        hc_linux_build_rpath(halfcube-engine-tests)
    endif()
    add_test(NAME engine-unit-tests COMMAND halfcube-engine-tests)
endif()

if(UNIX)
    hc_linux_build_rpath(halfcube-engine)
endif()

message(STATUS "HalfCube engine ${HC_VERSION_FULL}: platform ${HC_PLATFORM} (${HC_OS}), test commands ${HALFCUBE_TEST_COMMANDS}, "
    "OCCT ${OpenCASCADE_VERSION}, planegcs ${HC_PLANEGCS_SOURCE} ${HC_PLANEGCS_COMMIT}")
