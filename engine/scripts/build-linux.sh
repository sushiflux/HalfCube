#!/usr/bin/env bash
# Compiles the native engine on Linux (GCC or Clang, Release). Linux is a compile check for now: it shows code that
# only builds on Windows early, without packaging. The unit tests are run with --test.
#
#   bash engine/scripts/build-linux.sh [--test] [--test-commands] [--occt-dir <dir>] [--jobs <n>] [--fetch]
#
#   --occt-dir <dir>  use an existing shared OCCT 8.0.2 installation (also HALFCUBE_OCCT_DIR). Without it OCCT is
#                     built from engine/_deps/occt-src into engine/_build/occt-linux-install once and reused.
#   --fetch           run engine/scripts/fetch-deps.sh first
#   --test            run the C++ unit tests after building
#   --test-commands   build with diagnostics.crash and diagnostics.hang (separate build folder)
#
# Needs cmake 3.24 or newer, a C++20 compiler and make or ninja.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
engine=$(cd "$here/.." && pwd)
build_root="$engine/_build"
occt_dir="${HALFCUBE_OCCT_DIR:-}"
jobs=$(nproc 2>/dev/null || echo 4)
run_tests=0; test_commands=OFF; fetch=0
while [ $# -gt 0 ]; do
  case "$1" in
    --occt-dir) occt_dir="$2"; shift 2 ;;
    --jobs) jobs="$2"; shift 2 ;;
    --test) run_tests=1; shift ;;
    --test-commands) test_commands=ON; shift ;;
    --fetch) fetch=1; shift ;;
    *) echo "build-linux.sh: unknown argument '$1'" >&2; exit 64 ;;
  esac
done

if [ -n "$occt_dir" ]; then
  [ -d "$occt_dir" ] || { echo "build-linux.sh: OCCT folder '$occt_dir' does not exist." >&2; exit 1; }
  # CMake does not resolve a relative OpenCASCADE_DIR against the working directory, so it gets an absolute path.
  occt_dir=$(cd "$occt_dir" && pwd)
fi

gen="Unix Makefiles"; command -v ninja >/dev/null 2>&1 && gen=Ninja
[ "$fetch" = 1 ] && sh "$here/fetch-deps.sh"
start=$(date +%s)

# Same OCCT modules and switches as the Windows build.
occt_stamp="OCCT 8.0.2 shared linux Release C++20"
if [ -z "$occt_dir" ]; then
  occt_dir="$build_root/occt-linux-install"
  if [ ! -f "$occt_dir/.halfcube-occt" ] || [ "$(cat "$occt_dir/.halfcube-occt")" != "$occt_stamp" ]; then
    [ -f "$engine/_deps/occt-src/.halfcube-pin" ] || { echo "build-linux.sh: engine/_deps/occt-src is missing; run engine/scripts/fetch-deps.sh first." >&2; exit 1; }
    rm -rf "$occt_dir" "$build_root/occt-linux-build"
    cmake -S "$engine/_deps/occt-src" -B "$build_root/occt-linux-build" -G "$gen" \
      -DCMAKE_BUILD_TYPE=Release -DBUILD_LIBRARY_TYPE=Shared -DBUILD_CPP_STANDARD=C++20 -DINSTALL_DIR="$occt_dir" \
      -DBUILD_MODULE_FoundationClasses=ON -DBUILD_MODULE_ModelingData=ON -DBUILD_MODULE_ModelingAlgorithms=ON \
      -DBUILD_MODULE_DataExchange=ON -DBUILD_MODULE_Visualization=OFF -DBUILD_MODULE_ApplicationFramework=OFF \
      -DBUILD_MODULE_Draw=OFF -DBUILD_DOC_Overview=OFF -DBUILD_GTEST=OFF \
      -DUSE_FREETYPE=OFF -DUSE_TK=OFF -DUSE_XLIB=OFF -DUSE_OPENGL=OFF -DUSE_GLES2=OFF \
      -DUSE_FREEIMAGE=OFF -DUSE_FFMPEG=OFF -DUSE_OPENVR=OFF -DUSE_RAPIDJSON=OFF -DUSE_DRACO=OFF \
      -DUSE_TBB=OFF -DUSE_VTK=OFF -DUSE_EIGEN=OFF
    cmake --build "$build_root/occt-linux-build" -j "$jobs"
    cmake --install "$build_root/occt-linux-build"
    echo "$occt_stamp" > "$occt_dir/.halfcube-occt"
  fi
fi
occt_done=$(date +%s)
cfg=$(dirname "$(find "$occt_dir" -name OpenCASCADEConfig.cmake | head -1)")
[ -n "$cfg" ] && [ "$cfg" != "." ] || { echo "build-linux.sh: no OpenCASCADEConfig.cmake below $occt_dir." >&2; exit 1; }

build="$build_root/linux-release"; [ "$test_commands" = ON ] && build="$build_root/linux-release-testing"
cmake -S "$engine" -B "$build" -G "$gen" -DCMAKE_BUILD_TYPE=Release -DOpenCASCADE_DIR="$cfg" \
  -DHALFCUBE_TEST_COMMANDS="$test_commands" -DHALFCUBE_BUILD_TESTS=ON
cmake --build "$build" -j "$jobs"
end=$(date +%s)
if [ "$run_tests" = 1 ]; then "$build/bin/halfcube-engine-tests"; fi
echo "built $build/bin/halfcube-engine ($(stat -c %s "$build/bin/halfcube-engine") bytes)"
echo "times: occt_build_s=$((occt_done - start)) engine_build_s=$((end - occt_done))"
