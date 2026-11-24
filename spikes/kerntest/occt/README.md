# Kernel test: OCCT

Builds the fixed test parts of [`../PARTS.md`](../PARTS.md) with Open CASCADE Technology (OCCT) 8.0.2 and
measures them. The same C++20 program is built for Windows (MSVC), Linux (GCC, in Docker) and WebAssembly
(Emscripten, in Docker).

OCCT is licensed under `LGPL-2.1-only WITH OCCT-exception-1.0`. It is downloaded into `../_deps/` and built into
`../_build/`; both folders are git-ignored.

## What the program does

`kerntest_occt run` builds every case (P1a to P4b), times it (one warm-up run, then the median of `--runs` runs),
measures the result with the kernel itself (volume, area, faces, edges, bounding box) and validates it with
`BRepCheck_Analyzer`, plus a second check with `BOPAlgo_ArgumentAnalyzer` (self-intersection, small edges,
curve-on-surface). Where the volume is known analytically, the result is compared with it. Then it runs:

- P5a: STEP round trip of every successful result (AP214IS and AP242DIS),
- E1: face history of the hole cut and the fillet of P1a,
- E2: triangulation of P1a, P3a and P4b (chordal 0.05 mm, angular 20°) with a crack check.

`kerntest_occt p5b --in a.step --out b.step` reads a STEP file, checks it, cuts a D5 cylinder along Z through
the centre of its bounding box and writes the result back to STEP.

Sources: `src/parts.cpp` (test parts, E1), `src/kt_util.cpp` (measurement, checks, meshing, STEP),
`src/main.cpp` (driver).

## Windows

Needs Visual Studio 2022 or its Build Tools with the C++ workload (MSVC, Windows SDK, the bundled CMake and
Ninja). The scripts find them with `vswhere`; nothing has to be on `PATH`.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\fetch-occt.ps1          # shallow clone of tag V8_0_2
powershell -ExecutionPolicy Bypass -File scripts\build-occt-windows.ps1  # OCCT, shared, Release, C++20, 12 jobs
powershell -ExecutionPolicy Bypass -File scripts\build-tests-windows.ps1 # the test program
powershell -ExecutionPolicy Bypass -File scripts\run-windows.ps1 run --runs 5 --out <dir> --json <results.json>
```

`build-tests-windows.ps1 -NoStep` builds a variant without STEP; `run-windows.ps1 -NoStep ...` runs it.

P5b with foreign STEP files (all `*.step` / `*.stp` in a folder):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run-p5b.ps1 -InDir <step folder> -OutDir <output folder> -ResultsFile <p5b.json>
```

Library sizes (core toolkits vs. toolkits needed only for STEP, from OCCT's own dependency lists):

```powershell
node scripts\lib-sizes.mjs ..\_deps\occt-src ..\_build\occt-win-install\win64\vc14\bin dll
```

## Linux (Docker)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\docker-linux.ps1 -OutDir <folder for the results>
```

Starts an `ubuntu:24.04` container, copies the OCCT source and this folder into a named volume, builds OCCT and
the test with GCC and runs it (`docker/linux-build.sh`). Logs, timings, library sizes and the results JSON are
copied to `-OutDir`; container and volume are removed afterwards.

## WebAssembly (Docker + Node.js)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\docker-wasm.ps1 -OutDir <wasm folder>
powershell -ExecutionPolicy Bypass -File scripts\run-wasm.ps1 <wasm folder>\step <node-report.json> run --runs 5 --out <dir> --json <results.json>
```

`docker-wasm.ps1` uses `emscripten/emsdk:7.0.1` and builds OCCT as static libraries plus two links of the test
(`step/` with STEP, `nostep/` without). `run-wasm.ps1` runs one of them under Node.js through
`wasm/run-node.mjs`, which records the `.wasm` and glue sizes (raw, gzip -9, brotli 11), the instantiation time and
the peak linear memory.
