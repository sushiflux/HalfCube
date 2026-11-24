#!/bin/bash
# Runs inside an ubuntu:24.04 container: builds OCCT (shared, Release, C++20) with GCC, builds the kernel
# test against it and runs it. Expects the OCCT source in /work/occt-src and the test sources in /work/kt.
# Results end up in /work/out.
set -euo pipefail
JOBS="${JOBS:-12}"
RUNS="${RUNS:-5}"
mkdir -p /work/out
exec > >(tee /work/out/linux-build.log) 2>&1

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends g++ cmake ninja-build file >/dev/null
g++ --version | head -1
cmake --version | head -1

t0=$(date +%s.%N)
cmake -S /work/occt-src -B /work/occt-build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_LIBRARY_TYPE=Shared -DBUILD_CPP_STANDARD=C++20 \
  -DINSTALL_DIR=/work/occt-install \
  -DBUILD_MODULE_FoundationClasses=ON -DBUILD_MODULE_ModelingData=ON -DBUILD_MODULE_ModelingAlgorithms=ON \
  -DBUILD_MODULE_DataExchange=ON -DBUILD_MODULE_Visualization=OFF -DBUILD_MODULE_ApplicationFramework=OFF \
  -DBUILD_MODULE_Draw=OFF -DBUILD_DOC_Overview=OFF -DBUILD_GTEST=OFF \
  -DUSE_FREETYPE=OFF -DUSE_TK=OFF -DUSE_XLIB=OFF -DUSE_OPENGL=OFF -DUSE_GLES2=OFF \
  -DUSE_FREEIMAGE=OFF -DUSE_FFMPEG=OFF -DUSE_OPENVR=OFF -DUSE_RAPIDJSON=OFF -DUSE_DRACO=OFF \
  -DUSE_TBB=OFF -DUSE_VTK=OFF -DUSE_EIGEN=OFF > /work/out/occt-configure.log
t1=$(date +%s.%N)
ninja -C /work/occt-build -j "$JOBS" > /work/out/occt-build.log
t2=$(date +%s.%N)
ninja -C /work/occt-build install > /work/out/occt-install.log
awk "BEGIN{printf \"occt_configure_s=%.1f\nocct_build_s=%.1f\n\", $t1-$t0, $t2-$t1}" | tee /work/out/occt-times.txt
grep -c "warning:" /work/out/occt-build.log > /work/out/occt-warning-count.txt || true
grep -o "\[-W[a-z0-9=-]*\]" /work/out/occt-build.log | sort | uniq -c | sort -rn > /work/out/occt-warning-kinds.txt || true
grep -E "CMAKE_CXX_FLAGS(_RELEASE)?:|CMAKE_SHARED_LINKER_FLAGS(_RELEASE)?:" /work/occt-build/CMakeCache.txt > /work/out/occt-flags.txt
cp /work/occt-install/lib/cmake/opencascade/OpenCASCADEConfig.cmake /work/out/ 2>/dev/null || true

CFG=$(dirname "$(find /work/occt-install -name OpenCASCADEConfig.cmake | head -1)")
for variant in step nostep; do
  step=ON; [ "$variant" = nostep ] && step=OFF
  cmake -S /work/kt -B /work/kt-build-$variant -G Ninja -DCMAKE_BUILD_TYPE=Release -DOpenCASCADE_DIR="$CFG" \
    -DKT_WITH_STEP=$step > /work/out/kt-configure-$variant.log
  ninja -C /work/kt-build-$variant > /work/out/kt-build-$variant.log 2>&1 || { cat /work/out/kt-build-$variant.log; exit 1; }
done
grep -c "warning:" /work/out/kt-build-step.log > /work/out/kt-warning-count.txt || true

LIBDIR=$(dirname "$(find /work/occt-install -name 'libTKernel.so*' | head -1)")
export LD_LIBRARY_PATH="$LIBDIR"
ldd /work/kt-build-step/kerntest_occt | grep -o "libTK[A-Za-z0-9]*\.so[.0-9]*" | sort -u > /work/out/ldd-step.txt
ldd /work/kt-build-nostep/kerntest_occt | grep -o "libTK[A-Za-z0-9]*\.so[.0-9]*" | sort -u > /work/out/ldd-nostep.txt
ls -l "$LIBDIR" > /work/out/lib-listing.txt
( cd "$LIBDIR" && for f in libTK*.so.*.*.*; do [ -f "$f" ] && echo "$(stat -c %s "$f") $f"; done ) > /work/out/lib-sizes.txt
stat -c "%s %n" /work/kt-build-step/kerntest_occt /work/kt-build-nostep/kerntest_occt > /work/out/exe-sizes.txt

mkdir -p /work/out/run
/work/kt-build-step/kerntest_occt run --runs "$RUNS" --out /work/out/run --json /work/out/linux-results.json > /work/out/run.log 2>&1
echo "run exit $?"
rm -f /work/out/run/*.step
echo done
