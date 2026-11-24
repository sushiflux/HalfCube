# Kernel test: NVIDIA USD BRep / SMLib track

Builds the fixed test parts of `../PARTS.md` with the SMLib kernel of
[NVIDIA USD BRep](https://github.com/NVIDIA-Omniverse/usd-brep) (tag `v1.0.2`,
commit `9701dd0cf4b8f4fe379290b3032e9407deb220df`) through its C++ API, and measures them.

Only the two kernel layers are built: `SMLib` (geometry and topology) and `SM_API` (the
C-style `SmApi*` functions). OpenUSD, Python, Hydra and TBB are not used. The project's own
premake/Packman build is replaced by `CMakeLists.txt` so that the same build works with
MSVC, GCC and Emscripten.

## Layout

| Path | What |
|---|---|
| `CMakeLists.txt` | SMLib + SM_API (shared, or static for WebAssembly) and the test program `smlib_kerntest` |
| `src/cases.cpp` | The test parts P1 to P4 plus E1 (naming) and E2 (meshing) |
| `src/report.cpp`, `src/kt.h` | Measurement, validity checks, JSON output |
| `src/main.cpp` | Command line: `smlib_kerntest [--runs N] [--out DIR] [--json FILE] [--list] [CASE ...]` |
| `patches/0001-*.patch` | 14 one-line source fixes needed to compile the kernel as C++20 (see below) |
| `scripts/` | Fetch, build and run scripts (paths are resolved relative to the script) |

Third-party sources go to `../_deps/`, build trees and results to `../_build/`.

## Running

Windows (Visual Studio 2022 Build Tools with the C++ workload; CMake and Ninja are taken from
the Build Tools, nothing is installed):

```powershell
scripts\fetch-sources.ps1          # clone v1.0.2 into ..\_deps\usd-brep and apply the patch
scripts\build-windows.ps1          # MSVC, C++20, Release, 12 parallel jobs (-Jobs, -Clean)
scripts\run-windows.ps1            # every case in its own process, 5 timed runs after a warm-up
```

Linux and WebAssembly run in throw-away Docker containers (sources are copied in, results
copied out to `../_build/results/`, the container is removed afterwards):

```sh
scripts/fetch-sources.sh
scripts/build-linux-docker.sh [JOBS] [RUNS]           # ubuntu:24.04, GCC, C++20
scripts/build-wasm-docker.sh [JOBS] [RUNS] [CASE ...] # emscripten/emsdk:7.0.1, Node.js
```

P5b (STEP files from another CAD program): `scripts/p5b.ps1 -InputDir <folder> -OutDir <folder>`.

The upstream build of the whole repository (kernel, USD layer, OCCT `.brep` converters,
Python module) can be reproduced with `scripts/build-upstream-windows.ps1`; it is only
used to compare library sizes and to check that the tag builds as published.

## How a case is judged

A case passes only when the kernel's own checks accept the result:

- `SmBrep::AssertValid` at level 0 and level 2 with a full topology walk (the check the
  project's Python layer exposes as `assert_valid`),
- `SmApiBrepIsManifoldSolid`,
- `SmApiBrepMaterialCensus` (exactly one solid region and no void),

and, where the part has a closed-form volume, the kernel's volume (`SmApiBrepComputeVolume`) lies within
1 % of it. Lofts additionally get geometric probes (the solid really passes through the middle
section, and the sections are not twisted against each other), because a twisted loft is
still a valid solid. A result the kernel reports as success but its own checks reject is
`invalid-result`.

## C++20 patch

The kernel compiles as C++17 upstream. Under C++20, MSVC rejects:

- ambiguous rewritten `operator==` candidates (C2666) where a member `operator==` is not
  `const` or compares through a base class: `SmTree.h`, `SmLocalSolve1d.h`, `SmHashTable.h`,
  `SmFaceGrid.h`, `SmSurface.h` (add `const`) and `SmEllipse.cpp`, `SmSurfOfExtrusion.cpp`,
  `SmSurfOfRevolution.cpp`, `SmVolume.cpp` (compare as the base class explicitly);
- `std::ostream << const wchar_t*`, which C++20 deletes (C2280), in `SmGraphicsExtern.cpp`
  (convert with `smos_FromTChar` first). Under C++17 these lines printed the pointer value
  instead of the text.

GCC additionally rejects a destructor written with a template-id, `~SmProbArray<TYPE>()`,
which C++20 no longer allows (`SmHealProbArray.h`). Emscripten (clang) needs no further
change. Behaviour is otherwise unchanged.

## Licences

USD BRep, including SMLib and SM_API, is Apache-2.0. The build here links nothing else.
