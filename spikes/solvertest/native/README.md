# Solver test, native track (`native-msvc`)

planegcs, FreeCAD's 2D constraint solver, is built from the unchanged FreeCAD sources in `../_deps/FreeCAD`
as a static library, and a C++20 test driver runs the solver-neutral catalogue (`../cases/cases.json`) against
it. The same `CMakeLists.txt` and driver are meant for track 3 (`own-emscripten`); the driver uses only
standard C++ (std::chrono for timing, every path from argv).

```
native/
  CMakeLists.txt            static library "planegcs" + executable "solvertest_driver"
  src/driver.cpp            reads cases.json, maps constraints to GCS::System, solves, diagnoses, writes the result
  src/build_info.h.in       build facts written into the result file (filled by CMake)
  shim/Base/Console.h       replaces FreeCAD's Base::Console (log/warning only; optional capture buffer)
  shim/FCConfig.h           replaces FreeCAD's FCConfig.h (OS detection that planegcs does not use)
  shim/QtCore.h             replaces the QtCore.h FreeCAD generates at configure time (included by FCGlobal.h)
  (no patches/ folder: no FreeCAD source file needs a patch)
  scripts/fetch-deps.ps1    fetches / verifies FreeCAD, Eigen, Boost, nlohmann/json into ../_deps
  scripts/build-windows.ps1 MSVC build (Release, C++20, Ninja) into ../_build/native-msvc[-eigen501]
  scripts/run-windows.ps1   runs the driver and the checker
  docker/, scripts/docker-wasm.ps1, scripts/run-wasm.ps1   track 3 (WebAssembly), see the last section
```

## Commands (from the repository root, PowerShell or any shell)

```
powershell -NoProfile -ExecutionPolicy Bypass -File spikes/solvertest/native/scripts/fetch-deps.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File spikes/solvertest/native/scripts/build-windows.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File spikes/solvertest/native/scripts/run-windows.ps1
```

- `build-windows.ps1 [-Eigen 3.4.0|5.0.1] [-Clean]`: dot-sources `spikes/kerntest/occt/scripts/vsenv.ps1`,
  which finds Visual Studio 2022 or its Build Tools with `vswhere`, imports `vcvars64.bat` and puts the CMake
  and Ninja that ship with Visual Studio on the session PATH. Nothing has to be installed or on PATH beforehand.
- `run-windows.ps1 [-Eigen 3.4.0|5.0.1] [-Reps 5] [-Out file] [-RunDate 2026-11-24]`: writes
  `spikes/solvertest/_results/native-msvc.json` and `native-msvc.check.txt` (checker output; needs `node`, the
  checker step is skipped with a warning without it). With `-Eigen 5.0.1` the default name gets `-eigen501`.

The driver can also be run directly:

```
solvertest_driver <cases.json> <result.json> [--track name] [--runtime text] [--run-date d]
                  [--only id1,id2] [--reps n] [--slow-ms ms] [--verbose] [--planegcs-only]
```

`--verbose` prints planegcs' iteration log of the counting run; `--planegcs-only` disables the driver's own
curvature constraint (see below), so that only planegcs code solves.

## Build facts

| Item | Value |
|---|---|
| planegcs | FreeCAD tag `1.1.4`, commit `4fd3bf320d9566a27e60069fc8387448aaa3a094`: `GCS.cpp`, `Constraints.cpp`, `Geo.cpp`, `SubSystem.cpp`, `qp_eq.cpp` |
| other FreeCAD headers used unchanged | `src/FCGlobal.h`, `src/boost_graph_adjacency_list.hpp`, `src/Mod/Sketcher/SketcherGlobal.h` |
| Eigen | `3.4.0` (default) or `5.0.1`, header only |
| Boost | `1.92.0`, header only (graph, math constants; 1070 headers are actually read) |
| nlohmann/json | `3.12.0`, driver only |
| defines | `SketcherExport=` (empty: static library instead of dllimport), `EIGEN_MPL2_ONLY`, `NDEBUG` (Release) |
| MSVC options | `/O2 /Ob2 /EHsc -std:c++20 -MD`; planegcs sources additionally `/bigobj /utf-8 /w`; driver `/W4 /utf-8 /bigobj` |
| include order | `native/shim` first, then `planegcs/`, then FreeCAD `src/`, then Eigen and Boost as system headers |

## What the driver does

For every case (and every algorithm in `run_algorithms`): pass 1 builds a `GCS::System` from the start geometry
(fixed points are not declared unknown; arcs get FreeCAD's arc rules with tag 0; constraint tag = position in the
case's constraint list + 1), runs `initSolution(DogLeg)` and `solve(true, algorithm)`, applies the solution and
reads geometry and non-driving values back. Pass 2 rebuilds the system from the solved geometry and reads
`dofsNumber()`, `getConflicting()`, `getRedundant()` and `getPartiallyRedundant()` (protocol: `../CASES.md`,
section 1). Steps start from the previous step's geometry; a `drag` is a temporary coincident constraint with
tag `-1` towards fixed mouse parameters, as in FreeCAD's `Sketch::initMove`. All solver parameters of one run
live in a single pre-reserved `std::vector<double>`: planegcs orders the unknowns of a subsystem by pointer value
(`SubSystem.cpp:56-68`), so separately allocated parameters make under-determined results depend on the heap
layout; with one array the runs are reproducible. Timing: 1 untimed warm-up (which
also counts iterations through the planegcs log), then 5 timed runs, median; cases slower than 3 s get 1 run.

The only code that is not planegcs is `ConstraintEqualCurvatureCircleSplineEnd` in `driver.cpp`: a subclass of
`GCS::Constraint` for G2 between a circle/arc and the clamped end of a non-rational B-spline (used by case K12b).

## Notes for the Emscripten build (track 3)

- `System::diagnose` starts `std::async` (`GCS.cpp:4903`, `4980`); the CMake file links `Threads::Threads`
  when CMake finds a thread library. Whether Emscripten without `-pthread` runs it deferred or throws is not
  checked here.
- The shims are portable; FreeCAD's real `FCConfig.h` would stop with `#error` on Emscripten (it only knows
  Windows, macOS, Linux, BSD, Cygwin), which is why it is replaced.
- Exceptions: the driver uses C++ exceptions (unsupported mappings, JSON errors), so build with
  `-fwasm-exceptions`. File access goes through `std::ifstream`/`std::ofstream`, so the WebAssembly program
  needs a file system with the case files (for example `-sNODERAWFS=1` under Node).

## WebAssembly (track `own-emscripten`)

The same `CMakeLists.txt`, `driver.cpp` and unchanged planegcs sources are built with Emscripten (image
`emscripten/emsdk:7.0.1`, Emscripten 7.0.1, Clang 24.0.0) inside a throwaway container, and the module is run
under the local Node. Container and volume are named `halfcube-solvertest-wasm` and are removed at the end
(`docker ps -a` and `docker volume ls` show nothing with that prefix afterwards). Nothing of the drive is mounted:
the sources are copied in with `docker cp`.

```
native/
  docker/wasm-build.sh          runs inside the container: emcmake cmake + make (Release, C++20), writes /work/out
  scripts/docker-wasm.ps1       creates the container and volume, copies sources in, runs wasm-build.sh, copies
                                solvertest_driver.js/.wasm and the logs out to ../_build/own-emscripten, removes both
  scripts/run-wasm.ps1          runs the module under Node over the whole catalogue, then the checker
  scripts/node-exit-report.cjs  preloaded with `node --require`: prints the peak resident set size of the Node process
../check/compare-tracks.mjs     compares two result files (status, iterations, DOF, diagnosis lists, geometry, times)
```

Commands (from the repository root; needs Docker and the local image, and node for the run):

```
powershell -NoProfile -ExecutionPolicy Bypass -File spikes/solvertest/native/scripts/fetch-deps.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File spikes/solvertest/native/scripts/docker-wasm.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File spikes/solvertest/native/scripts/run-wasm.ps1
node spikes/solvertest/check/check.mjs spikes/solvertest/cases/cases.json spikes/solvertest/_results/own-emscripten.json
node spikes/solvertest/check/compare-tracks.mjs spikes/solvertest/_results/native-msvc.json spikes/solvertest/_results/own-emscripten.json
```

`run-wasm.ps1 [-Reps 5] [-Out file]` writes `spikes/solvertest/_results/own-emscripten.json`, `.check.txt` (checker
output) and `.run.txt` (driver progress plus the peak-memory line). `docker-wasm.ps1 [-OutDir dir] [-Extra '<flags>']`
appends `-Extra` to the link flags (for experiments such as `-sSTACK_OVERFLOW_CHECK=2 -sASSERTIONS=1`).
Run directly: `node --require native/scripts/node-exit-report.cjs _build/own-emscripten/solvertest_driver.js cases/cases.json out.json --track own-emscripten`.

Flags (recorded in the result file; `wasm-build.sh` explains each one):

| Where | Flag | Why |
|---|---|---|
| compile + link | `-fwasm-exceptions` | the product's exception model; the driver throws C++ exceptions |
| compile | `-O3 -DNDEBUG -std=c++20` | CMake Release default for Clang, C++20 as in the native track |
| compile | `-DSketcherExport= -DEIGEN_MPL2_ONLY`, `-w` on planegcs | as in the native track |
| link | `-sNODERAWFS=1`, `-sENVIRONMENT=node` | `std::ifstream`/`std::ofstream` read and write the real files under Node |
| link | `-sEXIT_RUNTIME=1` | flushes the C++ streams and returns the exit code of `main()` to Node |
| link | `-sALLOW_MEMORY_GROWTH=1` | needed: without it case P03 aborts with `Aborted(OOM)` (measured) |
| link | `-sSTACK_SIZE=1MB` | needed: with the default 64 KB, case P04 stops with `memory access out of bounds`; with `-sSTACK_OVERFLOW_CHECK=2` the reason is `stack overflow` (measured); 96 KB was enough in a trial for P04 |

Portability changes to the shared files (the native build was rebuilt and rerun afterwards: 100 entries, 0
differences to the stored native result):

- `CMakeLists.txt`: `Threads` is searched and linked only `if(NOT EMSCRIPTEN)` (no `-pthread`, so no
  SharedArrayBuffer requirement); new cache variable `HCST_LINK_FLAGS` (empty by default) is passed to the linker
  of the driver and appended to the flags string in the result file.
- `src/driver.cpp`: `#include <emscripten/version.h>` inside `#if defined(__EMSCRIPTEN__)` (the version macros
  used by `compilerVersion()` are defined there; without the include the build failed with "use of undeclared
  identifier"). The macro names are the upper-case ones (`__EMSCRIPTEN_MAJOR__`, ...), the lower-case ones are
  deprecated in Emscripten 7.0.1.

`std::async` in `System::diagnose`: libc++'s `std::async` with the default policy tries `launch::async` and falls
back to `launch::deferred` when starting a thread throws (`<future>` lines 1866-1880 of the sysroot header of the
image). The diagnosis results are identical to the native track, so the fallback works; whether the first attempt
throws or the thread creation is stubbed to fail was not looked at.
