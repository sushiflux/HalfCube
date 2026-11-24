# Solver test (phase 0)

Throwaway spike that tests the sketch solver **planegcs** (FreeCAD's 2D constraint solver) against the
12 constraint types of the product plus dimensions, determination state, conflicts, B-splines,
stability, dragging and performance. The same solver-neutral case catalogue is run by three tracks and
judged by one independent checker that contains no solver code.

| Track | What runs | Result file |
|---|---|---|
| `salusoft-wasm` | the prebuilt `@salusoft89/planegcs` WebAssembly package under Node.js | `spikes/solvertest/_results/salusoft-wasm.json` |
| `native-msvc` | planegcs from the FreeCAD sources, built natively with MSVC | `spikes/solvertest/_results/native-msvc.json` |
| `own-emscripten` | the same sources built to WebAssembly with Emscripten (static, `-fwasm-exceptions`) | `spikes/solvertest/_results/own-emscripten.json` |

This folder is not part of the product and not committed (`spikes/solvertest/` is untracked). Third-party
sources live only in `_deps/`, build trees only in `_build/` (both git-ignored), `node_modules/` too.

## Layout

```
spikes/solvertest/
  README.md             this file
  CASES.md              constraint mapping (native + Salusoft), neutral vocabulary, case format, case list
  fetch-deps.ps1        fetches and verifies the third-party sources into _deps/
  cases/                solver-neutral catalogue
    build-cases.mjs       generator (source of cases.json and large-*.json)
    cases.json            the catalogue (86 cases, 100 result entries incl. algorithm variants)
    large-p0*.json        the three large performance sketches (50 / 200 / 1000 elements)
    list-cases.mjs        regenerates the case list in CASES.md
  check/                independent checker (plain Node, no dependencies, no solver)
    check.mjs             node check/check.mjs <cases.json> <result.json>
    lib.mjs               geometry / constraint evaluators (incl. rational B-splines)
    selftest.mjs          proves that the checker fails on wrong input
    selftest-result.json  tiny hand-made / closed-form result file used by the self-test
    make-selftest.mjs     writes selftest-result.json
  salusoft/             track 1: package.json (private, exact version, no scripts) + runner
  native/               track 2 and 3: C++ driver, CMake, PowerShell and docker/shell scripts
  _deps/                (ignored) FreeCAD, Salusoft-planegcs, eigen-3.4.0, eigen-5.0.1, boost-1.92.0, nlohmann-json
  _build/               (ignored) build trees
```

## Third-party sources (pinned)

| What | Version | Source | Pin |
|---|---|---|---|
| planegcs (FreeCAD, sparse checkout `src/Mod/Sketcher/App`, planegcs tests, `src/*.h`) | tag `1.1.4` (2026-09-28) | https://github.com/FreeCAD/FreeCAD | commit `4fd3bf320d9566a27e60069fc8387448aaa3a094` |
| `@salusoft89/planegcs` (npm, prebuilt WASM + wrapper) | `1.3.0` | https://registry.npmjs.org/@salusoft89/planegcs | `salusoft/package-lock.json` (integrity hash), installed with `--ignore-scripts` |
| Salusoft89/planegcs (repo of the wrapper, read only) | tag `1.3.0` | https://github.com/Salusoft89/planegcs | commit `9d26baef0b240fe0eef4186d4e5e5e66ec3620b7` |
| Eigen | `3.4.0` and `5.0.1` | https://gitlab.com/libeigen/eigen | `3147391d946bb4b6c68edd901f2add6ac1f31f8c`, `bc3b39870ecb690a623a3f49149a358b95c5781d` |
| Boost (headers only) | `1.92.0` | https://archives.boost.io/release/1.92.0/source/boost_1_92_0.tar.gz | SHA-256 `c4a3b310ddd2472416e091067166b0713be97c63f38c212c484ada022fd296ce` |
| nlohmann/json (driver only) | `v3.12.0` | https://github.com/nlohmann/json | commit `55f93686c01528224f448c19128836e7df245f72` |

Licences (planegcs LGPL-2.0-or-later headers / LGPL-2.1 text, Eigen
MPL-2.0, Boost BSL-1.0, nlohmann/json MIT): each library brings its own licence text in `_deps/`. No planegcs code is copied into this repository.

## Fetch

```
powershell -NoProfile -ExecutionPolicy Bypass -File spikes/solvertest/fetch-deps.ps1
```

Idempotent: it verifies the pinned commits / the Boost SHA-256 and runs `npm install --ignore-scripts`
only inside `salusoft/`. Nothing is installed system-wide. (Written from the commands used for the first
fetch; the "fresh clone" path of the script itself was not re-run, existing checkouts were verified.)

## Checker

```
node spikes/solvertest/check/check.mjs spikes/solvertest/cases/cases.json spikes/solvertest/_results/<track>.json
```

One line per result entry: `PASS`, `FAIL` with all reasons, or `SKIP` (the entry says `supported:"no"`),
then a summary. Exit code 0 only if there is no `FAIL` and the result file has the required shape.
Options: `--only id,id`, `--tol-length`, `--tol-angle`, `--tol-curvature` (defaults 1e-6 mm, 1e-6 rad,
1e-5 1/mm from `cases.json`; a case may override with `tol`), `--json`, `--quiet`.

Self-test (shows that wrong input fails): `node spikes/solvertest/check/selftest.mjs`.

What the checker does with an entry: it recomputes every driving constraint of the (step's) active set
from the solved coordinates, compares non-driving values with the geometry, checks arc consistency,
fixed points, DOF, the conflict / redundancy / partial-redundancy id sets, extra geometric checks of the
case, and for step sequences the orientation (mirror flips) and per-step jumps. Soft expectations only
warn. Result format and diagnosis protocol: `CASES.md` sections 1 and 6.

## Regenerating the catalogue

```
node spikes/solvertest/cases/build-cases.mjs          # cases.json + large-*.json (deterministic)
node spikes/solvertest/cases/list-cases.mjs --write spikes/solvertest/CASES.md
```

## Running the tracks

Each track adds its exact commands to its own sub-folder README; pointers:

- `salusoft/README.md` (track 1)
- `native/README.md` (track 2, MSVC, uses `spikes/kerntest/occt/scripts/vsenv.ps1`)
- `native/README.md`, Emscripten section (track 3, Docker image `emscripten/emsdk:7.0.1`, containers named
  `partcraft-solvertest-*` and removed afterwards, no WSL)

## Rules for everything in here

Headless only (no windows, no browser); nothing may keep running afterwards; no system-wide installs;
no machine-specific paths in files under `spikes/` (use paths relative to the script); every number in a
result file must be produced by the run.
