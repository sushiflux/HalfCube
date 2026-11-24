#!/bin/bash
# Runs inside an emscripten/emsdk container: builds OCCT as static WebAssembly libraries (Release, C++20) and
# links the kernel test twice, with and without STEP. Expects /work/occt-src and /work/kt; results in /work/out.
set -euo pipefail
JOBS="${JOBS:-12}"
mkdir -p /work/out
exec > >(tee /work/out/wasm-build.log) 2>&1

emcc --version | head -1
cmake --version | head -1 || true
GEN="Unix Makefiles"; BUILD_TOOL=(make -j "$JOBS")
if command -v ninja >/dev/null; then GEN=Ninja; BUILD_TOOL=(ninja -j "$JOBS"); fi
echo "generator: $GEN"

if [ -f /work/occt-install/.prebuilt ]; then
  echo "using the prebuilt OCCT in /work/occt-install"
else
  # OCCT 8.0.2 uses std::lock_guard in NCollection_IncAllocator.cxx but only includes <shared_mutex>; with
  # libc++ (Emscripten) <mutex> is not pulled in transitively, so it is force-included instead of patching OCCT.
  OCCT_EXTRA_CXX_FLAGS="${OCCT_EXTRA_CXX_FLAGS:--include mutex}"
  # WASM_EH=1: native WebAssembly exception handling for OCCT and the test (default: Emscripten JS-based).
  if [ "${WASM_EH:-0}" = 1 ]; then OCCT_EXTRA_CXX_FLAGS="$OCCT_EXTRA_CXX_FLAGS -fwasm-exceptions"; fi
  # WASM_EXTRA: further compile+link settings for OCCT and the test, e.g. -sWASM_LEGACY_EXCEPTIONS=0.
  if [ -n "${WASM_EXTRA:-}" ]; then OCCT_EXTRA_CXX_FLAGS="$OCCT_EXTRA_CXX_FLAGS $WASM_EXTRA"; fi
  t0=$(date +%s.%N)
  emcmake cmake -S /work/occt-src -B /work/occt-build -G "$GEN" \
    -DCMAKE_CXX_FLAGS="$OCCT_EXTRA_CXX_FLAGS" \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_LIBRARY_TYPE=Static -DBUILD_CPP_STANDARD=C++20 \
    -DINSTALL_DIR=/work/occt-install \
    -DBUILD_MODULE_FoundationClasses=ON -DBUILD_MODULE_ModelingData=ON -DBUILD_MODULE_ModelingAlgorithms=ON \
    -DBUILD_MODULE_DataExchange=ON -DBUILD_MODULE_Visualization=OFF -DBUILD_MODULE_ApplicationFramework=OFF \
    -DBUILD_MODULE_Draw=OFF -DBUILD_DOC_Overview=OFF -DBUILD_GTEST=OFF \
    -DUSE_FREETYPE=OFF -DUSE_TK=OFF -DUSE_XLIB=OFF -DUSE_OPENGL=OFF -DUSE_GLES2=OFF \
    -DUSE_FREEIMAGE=OFF -DUSE_FFMPEG=OFF -DUSE_OPENVR=OFF -DUSE_RAPIDJSON=OFF -DUSE_DRACO=OFF \
    -DUSE_TBB=OFF -DUSE_VTK=OFF -DUSE_EIGEN=OFF > /work/out/occt-configure.log
  t1=$(date +%s.%N)
  ( cd /work/occt-build && "${BUILD_TOOL[@]}" ) > /work/out/occt-build.log 2>&1 || { tail -50 /work/out/occt-build.log; exit 1; }
  t2=$(date +%s.%N)
  ( cd /work/occt-build && cmake --install . ) > /work/out/occt-install.log
  awk "BEGIN{printf \"occt_configure_s=%.1f\nocct_build_s=%.1f\n\", $t1-$t0, $t2-$t1}" | tee /work/out/occt-times.txt
  grep -c "warning:" /work/out/occt-build.log > /work/out/occt-warning-count.txt || true
  grep -o "\[-W[a-z0-9=-]*\]" /work/out/occt-build.log | sort | uniq -c | sort -rn > /work/out/occt-warning-kinds.txt || true
  grep -E "CMAKE_CXX_FLAGS(_RELEASE)?:|CMAKE_EXE_LINKER_FLAGS(_RELEASE)?:" /work/occt-build/CMakeCache.txt > /work/out/occt-flags.txt
  ( cd /work/occt-install && find . -name 'libTK*.a' -exec stat -c "%s %n" {} + ) > /work/out/lib-sizes.txt

fi

CFG=$(dirname "$(find /work/occt-install -name OpenCASCADEConfig.cmake | head -1)")
for variant in step nostep; do
  step=ON; [ "$variant" = nostep ] && step=OFF
  emcmake cmake -S /work/kt -B /work/kt-build-$variant -G "$GEN" -DCMAKE_BUILD_TYPE=Release \
    -DOpenCASCADE_DIR="$CFG" -DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=BOTH -DKT_WITH_STEP=$step \
    -DKT_WASM_EH=$([ "${WASM_EH:-0}" = 1 ] && echo ON || echo OFF) -DKT_WASM_EXTRA_FLAGS="${WASM_EXTRA:-}" \
    > /work/out/kt-configure-$variant.log
  t3=$(date +%s.%N)
  ( cd /work/kt-build-$variant && "${BUILD_TOOL[@]}" ) > /work/out/kt-build-$variant.log 2>&1 || { cat /work/out/kt-build-$variant.log; exit 1; }
  t4=$(date +%s.%N)
  awk "BEGIN{printf \"kt_build_${variant}_s=%.1f\n\", $t4-$t3}" | tee -a /work/out/kt-times.txt
  mkdir -p /work/out/$variant
  cp /work/kt-build-$variant/kerntest_occt.js /work/kt-build-$variant/kerntest_occt.wasm /work/out/$variant/
  if [ -f /work/kt-build-$variant/kerntest_occt_steponly.wasm ]; then
    cp /work/kt-build-$variant/kerntest_occt_steponly.js /work/kt-build-$variant/kerntest_occt_steponly.wasm /work/out/$variant/
  fi
done
grep -c "warning:" /work/out/kt-build-step.log > /work/out/kt-warning-count.txt || true
echo done
