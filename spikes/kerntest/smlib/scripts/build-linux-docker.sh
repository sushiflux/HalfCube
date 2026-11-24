#!/bin/sh
# Linux build and test run (GCC, C++20, Release) in a throw-away ubuntu:24.04 container.
# The sources are copied into the container (no bind mount); only results are copied out,
# to ../../_build/results/linux. The container is removed at the end.
#   build-linux-docker.sh [JOBS] [RUNS]
# Needs: docker, tar, node (for merging the per-case JSON). Run fetch-sources.sh first.
set -eu
JOBS="${1:-12}"
RUNS="${2:-5}"
IMAGE="${IMAGE:-ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852}"
NAME="${NAME:-kt-smlib-linux}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
KT="$(cd "$HERE/.." && pwd)"
OUT="$KT/_build/results/linux"
LOGS="$KT/_build/logs"
mkdir -p "$OUT" "$LOGS"
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: keep container paths as they are
# docker.exe on Windows needs a native path for the host side of docker cp.
hostpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf "%s" "$1"; fi; }

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker run -d --name "$NAME" "$IMAGE" sleep infinity >/dev/null

docker exec "$NAME" sh -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq --no-install-recommends g++ cmake ninja-build >/dev/null' \
    >"$LOGS/smlib-linux-apt.log" 2>&1
docker exec "$NAME" sh -c 'g++ --version | head -1; cmake --version | head -1; ninja --version; grep PRETTY /etc/os-release' | tee "$LOGS/smlib-linux-tools.txt"

# Copy only what the build needs: the kernel sources, the spike and its scripts.
docker exec "$NAME" mkdir -p /work
tar -C "$KT" -cf - smlib/CMakeLists.txt smlib/src smlib/scripts \
    _deps/usd-brep/VERSION _deps/usd-brep/LICENSE _deps/usd-brep/source/SMLib _deps/usd-brep/source/SM_API \
    | docker cp - "$NAME:/work"

docker exec "$NAME" sh -c "cd /work && cmake -S smlib -B build -G Ninja -DCMAKE_BUILD_TYPE=Release" >"$LOGS/smlib-linux-configure.log" 2>&1
T0=$(date +%s)
set +e
docker exec "$NAME" sh -c "cd /work && cmake --build build --parallel $JOBS -- -k 0" >"$LOGS/smlib-linux-build.log" 2>&1
RC=$?
set -e
T1=$(date +%s)
echo "build_s=$((T1 - T0)) jobs=$JOBS rc=$RC" | tee "$LOGS/smlib-linux-times.txt"
[ "$RC" -eq 0 ] || { echo "build failed, see $LOGS/smlib-linux-build.log" >&2; exit 1; }
docker exec "$NAME" sh -c 'cd /work/build && ls -l libSMLib.so libSM_API.so smlib_kerntest && strip -o /tmp/s1 libSMLib.so && strip -o /tmp/s2 libSM_API.so && ls -l /tmp/s1 /tmp/s2' \
    | tee "$LOGS/smlib-linux-sizes.txt"

docker exec "$NAME" sh -c "cd /work/build && LD_LIBRARY_PATH=. sh /work/smlib/scripts/run-cases.sh ./smlib_kerntest /work/results $RUNS"
rm -rf "$OUT/cases" "$OUT/artefacts"
docker cp "$NAME:/work/results/." "$(hostpath "$OUT")"
node "$(hostpath "$HERE/scripts/merge-results.mjs")" "$(hostpath "$OUT/smlib-linux.json")" "$(hostpath "$OUT/cases")" $(tr -d '\r' <"$OUT/cases/list.txt")
