#!/bin/bash
# Runs inside an emscripten/emsdk container: links the engine against a prebuilt static OCCT 8.0.2
# (built with -fwasm-exceptions -UOCC_CONVERT_SIGNALS "-include mutex", see the kernel test).
# Expects /work/occt-install, /work/src/engine and /work/src/protocol; results in /work/out.
set -euo pipefail
JOBS="${JOBS:-8}"
mkdir -p /work/out
exec > >(tee /work/out/engine-wasm-build.log) 2>&1
emcc --version | head -1
CFG=$(dirname "$(find /work/occt-install -name OpenCASCADEConfig.cmake | head -1)")
GEN="Unix Makefiles"; command -v ninja >/dev/null && GEN=Ninja
t0=$(date +%s.%N)
emcmake cmake -S /work/src/engine -B /work/build -G "$GEN" -DCMAKE_BUILD_TYPE=Release \
  -DOpenCASCADE_DIR="$CFG" -DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=BOTH
cmake --build /work/build -j "$JOBS"
t1=$(date +%s.%N)
cp /work/build/halfcube-engine.mjs /work/build/halfcube-engine.wasm /work/out/
awk "BEGIN{printf \"engine_wasm_build_s=%.1f\n\", $t1-$t0}" | tee /work/out/engine-wasm-times.txt
grep -c "warning:" /work/out/engine-wasm-build.log > /work/out/engine-wasm-warning-count.txt || true
echo done
