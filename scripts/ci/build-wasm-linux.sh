#!/usr/bin/env bash
# Builds the WebAssembly engine on a Linux CI runner: the same container image and the same in-container script
# (engine/docker/wasm-build.sh) as engine/scripts/build-wasm.ps1, but with bind mounts instead of docker cp.
#
#   EMSDK_IMAGE=<image@digest> bash scripts/ci/build-wasm-linux.sh
#
# Needs engine/_deps/{freecad,eigen,boost,nlohmann-json} (engine/scripts/fetch-deps.sh) and either a restored
# engine/_build/occt-wasm-install (CI cache) or engine/_deps/occt-src.
# Output: engine/_build/wasm/ (module, licences, logs). When OCCT had to be built, it is copied to
# engine/_build/occt-wasm-install so the workflow can cache it.
set -euo pipefail

: "${EMSDK_IMAGE:?EMSDK_IMAGE must name the emscripten/emsdk image (with digest)}"
repo=$(cd "$(dirname "$0")/../.." && pwd)
engine="$repo/engine"
occt_install="$engine/_build/occt-wasm-install"
out="$engine/_build/wasm"
rm -rf "$out"
mkdir -p "$out"

mounts=(-v "$repo:/work/src:ro" -v "$out:/work/out")
if [ -f "$occt_install/.partcraft-occt" ]; then
  echo "using the cached WebAssembly OCCT in $occt_install"
  mounts+=(-v "$occt_install:/work/occt-install:ro")
else
  [ -f "$engine/_deps/occt-src/.partcraft-pin" ] || { echo "build-wasm-linux.sh: no cached OCCT and no engine/_deps/occt-src" >&2; exit 1; }
  echo "building OCCT for WebAssembly from source"
  mounts+=(-v "$engine/_deps/occt-src:/work/occt-src:ro")
fi

# After the build: hand a freshly built OCCT out (/work/occt-build exists only when OCCT was compiled here), then give the files to the runner user.
docker run --rm "${mounts[@]}" -e "JOBS=$(nproc)" -e TEST_COMMANDS=0 -e "HOST_UID=$(id -u)" -e "HOST_GID=$(id -g)" \
  "$EMSDK_IMAGE" bash -c '
    set -euo pipefail
    code=0
    bash /work/src/engine/docker/wasm-build.sh || code=$?
    if [ "$code" = 0 ] && [ -d /work/occt-build ] && [ -f /work/occt-install/.partcraft-occt ]; then
      cp -a /work/occt-install /work/out/occt-install
    fi
    chown -R "$HOST_UID:$HOST_GID" /work/out
    exit "$code"'

for f in partcraft-engine.mjs partcraft-engine.wasm; do
  [ -f "$out/$f" ] || { echo "build-wasm-linux.sh: $f was not produced" >&2; exit 1; }
done
# A freshly built OCCT comes out as out/occt-install; move it next to the other build trees for the cache step.
if [ -d "$out/occt-install" ]; then
  rm -rf "$occt_install"
  mv "$out/occt-install" "$occt_install"
fi
ls -l "$out/partcraft-engine.mjs" "$out/partcraft-engine.wasm"
