#!/bin/sh
# WebAssembly build (Emscripten, C++20, Release, static SMLib + SM_API) and Node.js test run
# in a throw-away emscripten/emsdk container. Sources are copied in (no bind mount); only
# results are copied out, to ../../_build/results/wasm. The container is removed at the end.
#   build-wasm-docker.sh [JOBS] [RUNS] [CASE ...]     (default cases: all)
# Needs: docker, tar, node (for merging). Run fetch-sources.sh first.
set -eu
JOBS="${1:-12}"
RUNS="${2:-5}"
[ $# -gt 0 ] && shift; [ $# -gt 0 ] && shift
IMAGE="${IMAGE:-emscripten/emsdk:7.0.1@sha256:73aece2e0ab748487945ad117b79fc4d277e9f656e54fc800a9b1a0a6562715b}"
NAME="${NAME:-kt-smlib-wasm}"
EH="${EH:-wasm}"
INITMEM="${INITMEM:-64MB}"   # initial linear memory (smaller shows the real peak)
HERE="$(cd "$(dirname "$0")/.." && pwd)"
KT="$(cd "$HERE/.." && pwd)"
OUT="$KT/_build/results/${OUTNAME:-wasm}"
LOGS="$KT/_build/logs"
mkdir -p "$OUT" "$LOGS"
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: keep container paths as they are
# docker.exe on Windows needs a native path for the host side of docker cp.
hostpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf "%s" "$1"; fi; }

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker run -d --name "$NAME" "$IMAGE" sleep infinity >/dev/null
docker exec "$NAME" sh -c 'emcc --version | head -1; node --version; cmake --version | head -1; (ninja --version || echo "ninja: none")' \
    | tee "$LOGS/smlib-wasm-tools.txt"

docker exec "$NAME" mkdir -p /work
tar -C "$KT" -cf - smlib/CMakeLists.txt smlib/src smlib/scripts \
    _deps/usd-brep/VERSION _deps/usd-brep/LICENSE _deps/usd-brep/source/SMLib _deps/usd-brep/source/SM_API \
    | docker cp - "$NAME:/work"

GEN="-G Ninja"; KEEP="-k 0"
docker exec "$NAME" sh -c 'command -v ninja >/dev/null' || { GEN="-G 'Unix Makefiles'"; KEEP="-k"; }
docker exec "$NAME" sh -c "cd /work && emcmake cmake -S smlib -B build $GEN -DCMAKE_BUILD_TYPE=Release -DSMLIB_SHARED=OFF -DKT_WASM_EH=$EH -DKT_WASM_INITIAL_MEMORY=$INITMEM" \
    >"$LOGS/smlib-wasm-configure.log" 2>&1
T0=$(date +%s)
set +e
docker exec "$NAME" sh -c "cd /work && cmake --build build --parallel $JOBS -- $KEEP" >"$LOGS/smlib-wasm-build.log" 2>&1
RC=$?
set -e
T1=$(date +%s)
echo "build_s=$((T1 - T0)) jobs=$JOBS rc=$RC eh=$EH initmem=$INITMEM" | tee "$LOGS/smlib-${OUTNAME:-wasm}-times.txt"
[ "$RC" -eq 0 ] || { echo "build failed, see $LOGS/smlib-wasm-build.log" >&2; exit 1; }

docker exec "$NAME" sh -c 'cd /work/build && ls -l smlib_kerntest.wasm smlib_kerntest.js libSMLib.a libSM_API.a
  gzip -9 -k -c smlib_kerntest.wasm | wc -c | sed "s/^/gzip9_bytes /"
  if command -v brotli >/dev/null; then brotli -q 11 -c smlib_kerntest.wasm | wc -c | sed "s/^/brotli11_bytes /";
  else node -e "const z=require(\"zlib\"),f=require(\"fs\");const b=f.readFileSync(\"smlib_kerntest.wasm\");console.log(\"brotli11_bytes\",z.brotliCompressSync(b,{params:{[z.constants.BROTLI_PARAM_QUALITY]:11}}).length)"; fi' \
    | tee "$LOGS/smlib-wasm-sizes.txt"

docker exec "$NAME" sh -c "cd /work/build && sh /work/smlib/scripts/run-cases.sh 'node /work/smlib/scripts/run-wasm.mjs /work/build/smlib_kerntest.js' /work/results $RUNS $*"
rm -rf "$OUT/cases" "$OUT/artefacts"
docker cp "$NAME:/work/results/." "$(hostpath "$OUT")"
node "$(hostpath "$HERE/scripts/merge-results.mjs")" "$(hostpath "$OUT/smlib-wasm.json")" "$(hostpath "$OUT/cases")" $(tr -d '\r' <"$OUT/cases/list.txt")
