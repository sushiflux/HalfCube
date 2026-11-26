#!/bin/bash
# Runs inside an emscripten/emsdk container: builds planegcs (unchanged FreeCAD sources) and the solver test driver
# as WebAssembly for Node (Release, C++20, native wasm exceptions). Expects /work/solvertest/{native,_deps};
# results (solvertest_driver.js/.wasm and logs) in /work/out.
set -euo pipefail
JOBS="${JOBS:-12}"
WASM_EXTRA="${WASM_EXTRA:-}"
mkdir -p /work/out
exec > >(tee /work/out/wasm-build.log) 2>&1

emcc --version | head -1
cmake --version | head -1
git config --global --add safe.directory '*'   # the FreeCAD checkout was copied in, owner differs; only for the commit lookup
S=/work/solvertest
B=/work/build

# Compile flags (recorded in the result file through CMAKE_CXX_FLAGS):
#   -fwasm-exceptions   the product's exception model (native WebAssembly EH); the driver throws C++ exceptions
# Link flags (HCST_LINK_FLAGS, recorded as well):
#   -sNODERAWFS=1       the driver reads cases.json and writes the result through std::ifstream/std::ofstream
#   -sENVIRONMENT=node  only Node is used to run the test
#   -sALLOW_MEMORY_GROWTH=1  without it case P03 (1000 elements) aborts with "Aborted(OOM)" on the default heap (measured)
#   -sEXIT_RUNTIME=1    flush the C++ streams and pass the exit code of main() to the Node process
#   -sSTACK_SIZE=1MB    the default of 64 KB overflows in case P04 (measured: "stack overflow" with -sSTACK_OVERFLOW_CHECK=2, plain
#                       build: "memory access out of bounds"); 1 MB is the usual stack size of native Windows programs
LINK="-fwasm-exceptions -sNODERAWFS=1 -sENVIRONMENT=node -sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=1 -sSTACK_SIZE=1MB $WASM_EXTRA"

t0=$(date +%s.%N)
emcmake cmake -S $S/native -B $B -G "Unix Makefiles" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS="-fwasm-exceptions" -DHCST_LINK_FLAGS="$LINK" \
  -DHCST_TRACK=own-emscripten > /work/out/configure.log 2>&1 || { cat /work/out/configure.log; exit 1; }
t1=$(date +%s.%N)
( cd $B && make -j "$JOBS" VERBOSE=1 ) > /work/out/build.log 2>&1 || { tail -60 /work/out/build.log; exit 1; }
t2=$(date +%s.%N)
awk "BEGIN{printf \"configure_s=%.1f\nbuild_s=%.1f\n\", $t1-$t0, $t2-$t1}" | tee /work/out/times.txt
grep -c "warning:" /work/out/build.log > /work/out/warning-count.txt || true
grep -E "CMAKE_CXX_FLAGS(_RELEASE)?:|HCST_LINK_FLAGS|Threads|CMAKE_CXX_COMPILER:" $B/CMakeCache.txt > /work/out/flags.txt || true
grep -E "Threads|FreeCAD" /work/out/configure.log > /work/out/configure-notes.txt || true
cp $B/solvertest_driver.js $B/solvertest_driver.wasm /work/out/
stat -c "%s %n" /work/out/solvertest_driver.js /work/out/solvertest_driver.wasm
echo done
