#!/bin/sh
# Clones NVIDIA usd-brep at the tested tag into ../../_deps/usd-brep and applies the C++20
# patch (patches/0001-*.patch). Safe to re-run: an existing checkout is only verified.
set -eu
TAG="${TAG:-v1.0.2}"
COMMIT="${COMMIT:-9701dd0cf4b8f4fe379290b3032e9407deb220df}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEPS="$(cd "$HERE/.." && pwd)/_deps"
SRC="$DEPS/usd-brep"
PATCH="$HERE/patches/0001-cxx20-build-fixes.patch"
mkdir -p "$DEPS"

if [ ! -d "$SRC/.git" ]; then
    git -c advice.detachedHead=false clone --branch "$TAG" --depth 1 https://github.com/NVIDIA-Omniverse/usd-brep.git "$SRC"
fi
HEAD_SHA="$(git -C "$SRC" rev-parse HEAD)"
[ "$HEAD_SHA" = "$COMMIT" ] || { echo "unexpected commit $HEAD_SHA (expected $COMMIT for $TAG)" >&2; exit 1; }

if git -C "$SRC" apply --check -R "$PATCH" 2>/dev/null; then
    echo "patch already applied"
else
    git -C "$SRC" apply "$PATCH"
    echo "patch applied"
fi
