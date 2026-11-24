#!/bin/sh
# Runs every kernel test case in its own process (a kernel crash only loses that case).
#   run-cases.sh EXE OUT_DIR [RUNS] [CASE ...]
# Writes OUT_DIR/cases/<case>.json|.exit|.stderr.txt and native artefacts to OUT_DIR/artefacts.
# EXE may be "node path/to/smlib_kerntest.js" for the WebAssembly build.
set -u
EXE="$1"; OUT="$2"; RUNS="${3:-5}"
shift 2; [ $# -gt 0 ] && shift
mkdir -p "$OUT/cases" "$OUT/artefacts"
if [ $# -gt 0 ]; then CASES="$*"; else CASES="$($EXE --list | tr -d '\r')"; fi
for c in $CASES; do
    rm -f "$OUT/cases/$c.json"
    $EXE --runs "$RUNS" --out "$OUT/artefacts" --json "$OUT/cases/$c.json" "$c" \
        >"$OUT/cases/$c.stdout.txt" 2>"$OUT/cases/$c.stderr.txt"
    rc=$?
    echo "$rc" >"$OUT/cases/$c.exit"
    printf '%-12s exit %s\n' "$c" "$rc"
done
echo "$CASES" | tr ' ' '\n' | grep -v '^$' >"$OUT/cases/list.txt"
