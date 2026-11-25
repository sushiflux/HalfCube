#!/bin/bash
# Runs inside the emscripten/emsdk container started by engine/scripts/build-wasm.ps1 (or by CI directly).
# Expects:  /work/src        repository subset: engine/ (sources, cmake, _deps without occt-src), version.txt,
#                            third_party/manifest.json
#           /work/occt-src   OCCT sources, unless /work/occt-install/.partcraft-occt exists (prebuilt static OCCT)
# Produces: /work/out/partcraft-engine.mjs, partcraft-engine.wasm, licenses/..., build logs and times.
# Environment: JOBS (default 8), TEST_COMMANDS=1 builds the test commands diagnostics.crash and diagnostics.hang.
set -euo pipefail
JOBS="${JOBS:-8}"
mkdir -p /work/out
exec > >(tee /work/out/wasm-build.log) 2>&1

emcc --version | head -1
cmake --version | head -1
GEN="Unix Makefiles"; BUILD_TOOL=(make -j "$JOBS")
if command -v ninja >/dev/null; then GEN=Ninja; BUILD_TOOL=(ninja -j "$JOBS"); fi
echo "generator: $GEN"

# OCCT as static WebAssembly libraries. Same modules as the Windows build (engine/scripts/build-windows.ps1).
#   -include mutex          NCollection_IncAllocator.cxx uses std::lock_guard but includes only <shared_mutex>;
#                           libc++ does not pull in <mutex> from there.
#   -fwasm-exceptions       native WebAssembly exception handling, must match the engine.
#   -UOCC_CONVERT_SIGNALS   OCCT defines it for every non-MSVC target; signal conversion has no meaning in
#                           WebAssembly and does not link with -fwasm-exceptions.
OCCT_CXX_FLAGS="-include mutex -fwasm-exceptions -UOCC_CONVERT_SIGNALS"
OCCT_STAMP="OCCT 8.0.2 static wasm; flags: $OCCT_CXX_FLAGS"
if [ -f /work/occt-install/.partcraft-occt ] && [ "$(cat /work/occt-install/.partcraft-occt)" = "$OCCT_STAMP" ]; then
  echo "using the prebuilt OCCT in /work/occt-install"
  echo "occt_build_s=0.0" > /work/out/occt-times.txt
else
  [ -d /work/occt-src ] || { echo "error: neither a matching prebuilt OCCT in /work/occt-install nor sources in /work/occt-src" >&2; exit 2; }
  rm -rf /work/occt-install /work/occt-build
  t0=$(date +%s.%N)
  emcmake cmake -S /work/occt-src -B /work/occt-build -G "$GEN" \
    -DCMAKE_CXX_FLAGS="$OCCT_CXX_FLAGS" \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_LIBRARY_TYPE=Static -DBUILD_CPP_STANDARD=C++20 \
    -DINSTALL_DIR=/work/occt-install \
    -DBUILD_MODULE_FoundationClasses=ON -DBUILD_MODULE_ModelingData=ON -DBUILD_MODULE_ModelingAlgorithms=ON \
    -DBUILD_MODULE_DataExchange=ON -DBUILD_MODULE_Visualization=OFF -DBUILD_MODULE_ApplicationFramework=OFF \
    -DBUILD_MODULE_Draw=OFF -DBUILD_DOC_Overview=OFF -DBUILD_GTEST=OFF \
    -DUSE_FREETYPE=OFF -DUSE_TK=OFF -DUSE_XLIB=OFF -DUSE_OPENGL=OFF -DUSE_GLES2=OFF \
    -DUSE_FREEIMAGE=OFF -DUSE_FFMPEG=OFF -DUSE_OPENVR=OFF -DUSE_RAPIDJSON=OFF -DUSE_DRACO=OFF \
    -DUSE_TBB=OFF -DUSE_VTK=OFF -DUSE_EIGEN=OFF > /work/out/occt-configure.log
  ( cd /work/occt-build && "${BUILD_TOOL[@]}" ) > /work/out/occt-build.log 2>&1 || { tail -60 /work/out/occt-build.log; exit 1; }
  ( cd /work/occt-build && cmake --install . ) > /work/out/occt-install.log
  t1=$(date +%s.%N)
  echo "$OCCT_STAMP" > /work/occt-install/.partcraft-occt
  awk "BEGIN{printf \"occt_build_s=%.1f\n\", $t1-$t0}" | tee /work/out/occt-times.txt
  # Proof that the signal macro really ends up undefined: -U must come after OCCT's own -D on the command line.
  flags=$(find /work/occt-build -path '*TKernel*' -name flags.make | head -1)
  if [ -n "$flags" ]; then grep -E "^CXX_(DEFINES|FLAGS)" "$flags" > /work/out/occt-tkernel-flags.txt; fi
fi

CFG=$(dirname "$(find /work/occt-install -name OpenCASCADEConfig.cmake | head -1)")
TEST=OFF; [ "${TEST_COMMANDS:-0}" = 1 ] && TEST=ON
t2=$(date +%s.%N)
emcmake cmake -S /work/src/engine -B /work/engine-build -G "$GEN" -DCMAKE_BUILD_TYPE=Release \
  -DOpenCASCADE_DIR="$CFG" -DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=BOTH \
  -DPARTCRAFT_BUILD_TESTS=OFF -DPARTCRAFT_TEST_COMMANDS=$TEST > /work/out/engine-configure.log \
  || { cat /work/out/engine-configure.log; exit 1; }
( cd /work/engine-build && "${BUILD_TOOL[@]}" ) > /work/out/engine-build.log 2>&1 || { cat /work/out/engine-build.log; exit 1; }
t3=$(date +%s.%N)
awk "BEGIN{printf \"engine_build_s=%.1f\n\", $t3-$t2}" | tee /work/out/engine-times.txt

cp /work/engine-build/bin/partcraft-engine.mjs /work/engine-build/bin/partcraft-engine.wasm /work/out/

# Licence texts of the Emscripten runtime parts linked into the module (listed in third_party/manifest.json).
EM=/emsdk/upstream/emscripten
lic=/work/out/licenses
mkdir -p "$lic/emscripten" "$lic/libcxx" "$lic/libcxxabi" "$lic/libunwind" "$lic/compiler-rt" "$lic/musl"
cp "$EM/LICENSE" "$lic/emscripten/LICENSE"
for part in libcxx libcxxabi libunwind compiler-rt; do cp "$EM/system/lib/$part/LICENSE.TXT" "$lic/$part/LICENSE.TXT"; done
cp "$EM/system/lib/libc/musl/COPYRIGHT" "$lic/musl/COPYRIGHT"

stat -c "%s %n" /work/out/partcraft-engine.mjs /work/out/partcraft-engine.wasm
gzip -9 -c /work/out/partcraft-engine.wasm | wc -c | awk '{print "wasm_gzip_bytes=" $1}'
echo done
