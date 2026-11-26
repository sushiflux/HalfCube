# Solver test, tracks "native-msvc" and "own-emscripten": planegcs (FreeCAD's sketch solver) built
# from the FreeCAD sources in ../_deps, plus a test driver that runs the solver-neutral catalogue.
#
# Nothing here is part of the product. Third-party sources are only read from ../_deps (never
# copied or edited); the build tree belongs in ../_build.
cmake_minimum_required(VERSION 3.20)
project(halfcube_solvertest_native LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(HCST_DEPS "${CMAKE_CURRENT_SOURCE_DIR}/../_deps" CACHE PATH "Folder with the fetched third-party sources")
set(HCST_FREECAD_DIR "${HCST_DEPS}/FreeCAD" CACHE PATH "FreeCAD checkout (sparse)")
set(HCST_EIGEN_DIR "${HCST_DEPS}/eigen-3.4.0" CACHE PATH "Eigen source folder (header only)")
set(HCST_BOOST_DIR "${HCST_DEPS}/boost-1.92.0" CACHE PATH "Boost folder that contains boost/ (header only)")
set(HCST_JSON_DIR "${HCST_DEPS}/nlohmann-json" CACHE PATH "nlohmann/json checkout")
set(HCST_TRACK "native-msvc" CACHE STRING "Track name written into the result file")
option(HCST_EIGEN_MPL2_ONLY "Define EIGEN_MPL2_ONLY (compile error if an LGPL part of Eigen is used)" ON)

set(PLANEGCS_DIR "${HCST_FREECAD_DIR}/src/Mod/Sketcher/App/planegcs")
foreach(f GCS.cpp Constraints.cpp Geo.cpp SubSystem.cpp qp_eq.cpp)
  if(NOT EXISTS "${PLANEGCS_DIR}/${f}")
    message(FATAL_ERROR "planegcs source missing: ${PLANEGCS_DIR}/${f} (run scripts/fetch-deps.ps1)")
  endif()
endforeach()
if(NOT EXISTS "${HCST_EIGEN_DIR}/Eigen/Core")
  message(FATAL_ERROR "Eigen not found in ${HCST_EIGEN_DIR}")
endif()
if(NOT EXISTS "${HCST_BOOST_DIR}/boost/version.hpp")
  message(FATAL_ERROR "Boost headers not found in ${HCST_BOOST_DIR}")
endif()
if(NOT EXISTS "${HCST_JSON_DIR}/single_include/nlohmann/json.hpp")
  message(FATAL_ERROR "nlohmann/json not found in ${HCST_JSON_DIR}")
endif()

# ---------------------------------------------------------------------------------------------
# planegcs as a static library. Include order matters: shim/ first, so that the shim headers
# (Base/Console.h, FCConfig.h, QtCore.h) win over anything else; then FreeCAD's src/ for the
# unchanged helper headers FCGlobal.h and boost_graph_adjacency_list.hpp.
# ---------------------------------------------------------------------------------------------
add_library(planegcs STATIC
  "${PLANEGCS_DIR}/GCS.cpp"
  "${PLANEGCS_DIR}/Constraints.cpp"
  "${PLANEGCS_DIR}/Geo.cpp"
  "${PLANEGCS_DIR}/SubSystem.cpp"
  "${PLANEGCS_DIR}/qp_eq.cpp"
)
target_include_directories(planegcs
  PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/shim"
    "${PLANEGCS_DIR}"
    "${HCST_FREECAD_DIR}/src"
  SYSTEM PUBLIC
    "${HCST_EIGEN_DIR}"
    "${HCST_BOOST_DIR}"
)
# SketcherExport: empty, so that planegcs is an ordinary static library (SketcherGlobal.h only
# defines it when it is not yet defined; otherwise it would become __declspec(dllimport) on Win64).
set(HCST_DEFINES SketcherExport=)
if(HCST_EIGEN_MPL2_ONLY)
  list(APPEND HCST_DEFINES EIGEN_MPL2_ONLY)
endif()
target_compile_definitions(planegcs PUBLIC ${HCST_DEFINES})
if(MSVC)
  # /bigobj: GCS.cpp has many template instantiations; /utf-8: sources are UTF-8.
  # Warnings of the unchanged third-party code are silenced (/w); our own driver keeps /W4.
  target_compile_options(planegcs PRIVATE /bigobj /utf-8 /w)
else()
  target_compile_options(planegcs PRIVATE -w)
endif()
# GCS.cpp starts std::async in System::diagnose (GCS.cpp:4903, 4980). Emscripten is built single-threaded
# here (no -pthread, so no SharedArrayBuffer requirement): Threads is not linked for it.
if(NOT EMSCRIPTEN)
  find_package(Threads)
  if(Threads_FOUND)
    target_link_libraries(planegcs PUBLIC Threads::Threads)
  endif()
endif()
# Extra link options (used by the Emscripten build: -fwasm-exceptions, -sNODERAWFS=1, ...); empty for the native build.
set(HCST_LINK_FLAGS "" CACHE STRING "Extra link flags, separated by spaces; also recorded in the result file")

# ---------------------------------------------------------------------------------------------
# build information that the driver writes into the result file
# ---------------------------------------------------------------------------------------------
find_package(Git QUIET)
set(HCST_FREECAD_COMMIT "unknown")
set(HCST_FREECAD_TAG "unknown")
if(GIT_FOUND)
  execute_process(COMMAND "${GIT_EXECUTABLE}" -C "${HCST_FREECAD_DIR}" rev-parse HEAD
    OUTPUT_VARIABLE HCST_FREECAD_COMMIT OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
  execute_process(COMMAND "${GIT_EXECUTABLE}" -C "${HCST_FREECAD_DIR}" describe --tags --exact-match
    OUTPUT_VARIABLE HCST_FREECAD_TAG OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
endif()
string(TOUPPER "${CMAKE_BUILD_TYPE}" HCST_BT)
string(STRIP "${CMAKE_CXX_FLAGS} ${CMAKE_CXX_FLAGS_${HCST_BT}} ${CMAKE_CXX20_STANDARD_COMPILE_OPTION}" HCST_FLAGS)
if(MSVC)
  # CMake's default MSVC runtime (CMAKE_MSVC_RUNTIME_LIBRARY unset) adds -MD
  string(APPEND HCST_FLAGS " -MD")
endif()
if(MSVC)
  set(HCST_LIB_FLAGS "/bigobj /utf-8 /w")
else()
  set(HCST_LIB_FLAGS "-w")
endif()
list(JOIN HCST_DEFINES " -D" HCST_DEFINES_STR)
set(HCST_FLAGS_ALL "CMAKE_CXX_STANDARD=20, build type ${CMAKE_BUILD_TYPE}: ${HCST_FLAGS}; planegcs: ${HCST_LIB_FLAGS} -D${HCST_DEFINES_STR}")
if(HCST_LINK_FLAGS)
  string(APPEND HCST_FLAGS_ALL "; link: ${HCST_LINK_FLAGS}")
endif()
set(HCST_COMPILER "${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}")
configure_file("${CMAKE_CURRENT_SOURCE_DIR}/src/build_info.h.in" "${CMAKE_CURRENT_BINARY_DIR}/generated/build_info.h" @ONLY)

# ---------------------------------------------------------------------------------------------
# the test driver
# ---------------------------------------------------------------------------------------------
add_executable(solvertest_driver "${CMAKE_CURRENT_SOURCE_DIR}/src/driver.cpp")
target_link_libraries(solvertest_driver PRIVATE planegcs)
if(HCST_LINK_FLAGS)
  separate_arguments(HCST_LINK_FLAGS_LIST UNIX_COMMAND "${HCST_LINK_FLAGS}")
  target_link_options(solvertest_driver PRIVATE ${HCST_LINK_FLAGS_LIST})
endif()
target_include_directories(solvertest_driver PRIVATE
  "${CMAKE_CURRENT_BINARY_DIR}/generated"
  "${HCST_JSON_DIR}/single_include")
if(MSVC)
  target_compile_options(solvertest_driver PRIVATE /W4 /utf-8 /bigobj)
else()
  target_compile_options(solvertest_driver PRIVATE -Wall -Wextra)
endif()
