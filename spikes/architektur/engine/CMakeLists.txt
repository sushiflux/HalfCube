cmake_minimum_required(VERSION 3.21)
project(halfcube_engine LANGUAGES CXX)

# Architecture spike: the HalfCube engine service. One C++20 core, built as a native process (stdio frames)
# and as a WebAssembly module for a Web Worker. Point OpenCASCADE_DIR at the "cmake" folder of an OCCT 8.0.2
# installation (shared on Windows, static for WebAssembly).

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(OpenCASCADE 8.0.2 EXACT CONFIG REQUIRED)

set(HC_OCCT_LIBS TKernel TKMath TKG2d TKG3d TKGeomBase TKBRep TKGeomAlgo TKTopAlgo TKPrim TKBO TKShHealing
    TKBool TKFillet TKOffset TKMesh)

set(HC_CORE_SOURCES src/json.cpp src/model.cpp src/mesh.cpp src/engine.cpp)

if(EMSCRIPTEN)
    # Same flags as the OCCT build of the kernel test: native wasm exceptions; OCCT's signal conversion
    # (setjmp per OCC_CATCH_SIGNALS) is switched off because it breaks the -fwasm-exceptions link.
    set(HC_FLAGS -fwasm-exceptions -UOCC_CONVERT_SIGNALS)
    add_executable(halfcube_engine ${HC_CORE_SOURCES} src/main_wasm.cpp)
    set_target_properties(halfcube_engine PROPERTIES OUTPUT_NAME "halfcube-engine" SUFFIX ".mjs")
    target_link_options(halfcube_engine PRIVATE
        ${HC_FLAGS}
        -sMODULARIZE=1
        -sEXPORT_ES6=1
        -sEXPORT_NAME=createEngineModule
        -sENVIRONMENT=web,worker,node
        -sALLOW_MEMORY_GROWTH=1
        -sINITIAL_MEMORY=32MB
        -sMAXIMUM_MEMORY=4GB
        -sSTACK_SIZE=4MB
        -sEXIT_RUNTIME=0
        -sINVOKE_RUN=0
        -sEXPORTED_FUNCTIONS=_hc_init,_hc_handle,_malloc,_free
        -sEXPORTED_RUNTIME_METHODS=HEAPU8)
    set(HC_PLATFORM_FLAGS_TEXT "-O3 -fwasm-exceptions -UOCC_CONVERT_SIGNALS")
elseif(MSVC)
    # /EHsc on purpose: hardware faults must not be caught by catch (...) in the engine; they end the process.
    set(HC_FLAGS /W4 /EHsc /permissive- /utf-8 /Zc:__cplusplus /wd4996)
    add_executable(halfcube_engine ${HC_CORE_SOURCES} src/main_native.cpp)
    set_target_properties(halfcube_engine PROPERTIES OUTPUT_NAME "halfcube-engine")
    set(HC_PLATFORM_FLAGS_TEXT "/O2 /EHsc")
    # Copy the OCCT DLLs next to the executable so it starts without PATH changes.
    add_custom_command(TARGET halfcube_engine POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_RUNTIME_DLLS:halfcube_engine> $<TARGET_FILE_DIR:halfcube_engine>
        COMMAND_EXPAND_LISTS)
else()
    set(HC_FLAGS -Wall -Wextra)
    add_executable(halfcube_engine ${HC_CORE_SOURCES} src/main_native.cpp)
    set_target_properties(halfcube_engine PROPERTIES OUTPUT_NAME "halfcube-engine")
    find_package(Threads REQUIRED)
    target_link_libraries(halfcube_engine PRIVATE Threads::Threads)
    set(HC_PLATFORM_FLAGS_TEXT "-O2")
endif()

target_include_directories(halfcube_engine PRIVATE ${OpenCASCADE_INCLUDE_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/../protocol)
target_link_libraries(halfcube_engine PRIVATE ${HC_OCCT_LIBS})
target_compile_options(halfcube_engine PRIVATE ${HC_FLAGS})
target_compile_definitions(halfcube_engine PRIVATE HC_BUILD_FLAGS="${HC_PLATFORM_FLAGS_TEXT}")
