cmake_minimum_required(VERSION 3.21)
project(kerntest_occt LANGUAGES CXX)

# Kernel test for OCCT. Point OpenCASCADE_DIR at the "cmake" folder of an OCCT installation.
option(KT_WITH_STEP "Build with STEP support (TKDESTEP)" ON)
option(KT_WASM_EH "WebAssembly: native wasm exceptions (-fwasm-exceptions) instead of JavaScript-based ones" OFF)
set(KT_WASM_EXTRA_FLAGS "" CACHE STRING "WebAssembly: extra compile and link flags, e.g. -sWASM_LEGACY_EXCEPTIONS=0")
# A small start size makes the peak of the (only growing) linear memory meaningful.
set(KT_WASM_INITIAL_MEMORY "16MB" CACHE STRING "WebAssembly: initial linear memory")

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# OCCT installs its version file with the ExactVersion strategy.
find_package(OpenCASCADE 8.0.2 EXACT CONFIG REQUIRED)

set(KT_OCCT_LIBS
    TKernel TKMath TKG2d TKG3d TKGeomBase TKBRep
    TKGeomAlgo TKTopAlgo TKPrim TKBO TKShHealing TKBool TKFillet TKOffset TKMesh TKHelix)
if(KT_WITH_STEP)
    list(APPEND KT_OCCT_LIBS TKDE TKXSBase TKDESTEP)
endif()

add_executable(kerntest_occt src/main.cpp src/parts.cpp src/kt_util.cpp)
target_include_directories(kerntest_occt PRIVATE ${OpenCASCADE_INCLUDE_DIR})
target_link_libraries(kerntest_occt PRIVATE ${KT_OCCT_LIBS})
if(KT_WITH_STEP)
    target_compile_definitions(kerntest_occt PRIVATE KT_WITH_STEP)
endif()

if(MSVC)
    # OCCT itself is built with /EHa so that structured exceptions become C++ exceptions; drop the default /EHsc.
    string(REPLACE "/EHsc" "" CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS}")
    set(KT_TARGET_FLAGS /W4 /EHa /permissive- /utf-8 /Zc:__cplusplus)
    set(KT_PLATFORM "windows-x64")
elseif(EMSCRIPTEN)
    set(KT_PLATFORM "wasm32-emscripten")
    if(KT_WASM_EH)
        set(KT_TARGET_FLAGS -fwasm-exceptions)
    else()
        set(KT_TARGET_FLAGS -fexceptions)
    endif()
    if(KT_WASM_EXTRA_FLAGS)
        separate_arguments(_kt_wasm_extra UNIX_COMMAND "${KT_WASM_EXTRA_FLAGS}")
        list(APPEND KT_TARGET_FLAGS ${_kt_wasm_extra})
    endif()
    target_compile_definitions(kerntest_occt PRIVATE OCC_CONVERT_SIGNALS)
else()
    set(KT_TARGET_FLAGS -Wall -Wextra)
    # OCCT is built with OCC_CONVERT_SIGNALS on non-MSVC targets; OCC_CATCH_SIGNALS needs it as well.
    target_compile_definitions(kerntest_occt PRIVATE OCC_CONVERT_SIGNALS)
    set(KT_PLATFORM "${CMAKE_SYSTEM_NAME}-${CMAKE_SYSTEM_PROCESSOR}")
endif()

target_compile_options(kerntest_occt PRIVATE ${KT_TARGET_FLAGS})
string(TOUPPER "${CMAKE_BUILD_TYPE}" _kt_cfg)
list(JOIN KT_TARGET_FLAGS " " _kt_target_flags)
set(KT_BUILD_FLAGS "${CMAKE_CXX_FLAGS} ${CMAKE_CXX_FLAGS_${_kt_cfg}} ${_kt_target_flags} (C++${CMAKE_CXX_STANDARD})")
string(STRIP "${KT_BUILD_FLAGS}" KT_BUILD_FLAGS)
target_compile_definitions(kerntest_occt PRIVATE KT_BUILD_FLAGS="${KT_BUILD_FLAGS}" KT_PLATFORM="${KT_PLATFORM}")

if(EMSCRIPTEN)
    # Node.js test build: real file system access for STEP files, growable memory, exceptions enabled.
    set_target_properties(kerntest_occt PROPERTIES SUFFIX ".js")
    target_link_options(kerntest_occt PRIVATE
        ${KT_TARGET_FLAGS}
        -sALLOW_MEMORY_GROWTH=1
        -sINITIAL_MEMORY=${KT_WASM_INITIAL_MEMORY}
        -sMAXIMUM_MEMORY=4GB
        -sSTACK_SIZE=4MB
        -sNODERAWFS=1
        -sEXIT_RUNTIME=0
        -sMODULARIZE=1
        -sEXPORT_NAME=createKerntest
        -sINVOKE_RUN=0
        -sEXPORTED_RUNTIME_METHODS=callMain,HEAPU8)
endif()

# Minimal STEP read/write program: size of OCCT when it is used only for STEP (hybrid case).
if(KT_WITH_STEP)
    add_executable(kerntest_occt_steponly src/step_only.cpp)
    target_include_directories(kerntest_occt_steponly PRIVATE ${OpenCASCADE_INCLUDE_DIR})
    target_link_libraries(kerntest_occt_steponly PRIVATE TKDESTEP TKXSBase TKDE TKTopAlgo TKBRep TKMath TKernel)
    target_compile_options(kerntest_occt_steponly PRIVATE ${KT_TARGET_FLAGS})
    if(EMSCRIPTEN)
        set_target_properties(kerntest_occt_steponly PROPERTIES SUFFIX ".js")
        target_link_options(kerntest_occt_steponly PRIVATE ${KT_TARGET_FLAGS}
            -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=${KT_WASM_INITIAL_MEMORY} -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=4MB
            -sNODERAWFS=1 -sEXIT_RUNTIME=0 -sMODULARIZE=1 -sEXPORT_NAME=createSteponly -sINVOKE_RUN=0
            -sEXPORTED_RUNTIME_METHODS=callMain,HEAPU8)
    endif()
endif()
