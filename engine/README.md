# HalfCube engine

The engine computes geometry (OCCT 8.0.2) and solves sketches (planegcs from FreeCAD 1.1.4). One C++20 code base is
built twice:

- **Desktop:** `halfcube-engine.exe`, a separate process started by the Electron main process. It talks over
  stdin/stdout in length-prefixed frames (16-byte prefix, JSON header, binary payload).
- **Browser:** `halfcube-engine.mjs` + `halfcube-engine.wasm`, loaded in a Web Worker, with the same messages.

The messages are defined once in `protocol/engine-protocol.json`. `node protocol/generate.mjs` writes the C++ header
(`engine/src/generated/protocol.hpp`), the TypeScript types (`app/src/engine/generated/protocol.ts`) and the JSON
Schema (`protocol/engine-protocol.schema.json`); `--check` fails when one of them is out of date.

## Building

| Step | Command |
|---|---|
| Fetch pinned third-party sources into `engine/_deps/` | `powershell -File engine/scripts/fetch-deps.ps1` (Linux: `sh engine/scripts/fetch-deps.sh`) |
| Windows (MSVC, Ninja, Release, unit tests) | `powershell -File engine/scripts/build-windows.ps1 [-TestCommands] [-OcctDir <dir>]` |
| WebAssembly (Docker, `emscripten/emsdk:7.0.1`) | `powershell -File engine/scripts/build-wasm.ps1 [-TestCommands]` |
| Linux compile check | `bash engine/scripts/build-linux.sh [--test]` |

Versions, licences and sources of every bundled component are listed in `third_party/manifest.json`. OCCT is built
from source once per platform and reused from `engine/_build/`. `-TestCommands` adds `diagnostics.crash` and
`diagnostics.hang`; release builds refuse them with `test_commands_disabled`.

## Testing

- C++ unit tests (doctest) run at the end of `build-windows.ps1` and with `build-linux.sh --test`.
- `node engine/tests/drive-engine.mjs --native <exe> --out a.json` and `--wasm <folder> --out b.json` drive a built
  engine through the message interface and check every answer against the JSON Schema;
  `--compare a.json b.json` compares the self-test results of two builds.

## Browser requirements of the WebAssembly module

The module uses native WebAssembly exception handling (`-fwasm-exceptions`, legacy encoding) and Emscripten 7.0.1's
default browser targets. Minimum versions from Emscripten's `tools/feature_matrix.py`:

| | Chrome / Edge | Firefox | Safari |
|---|---|---|---|
| Emscripten 7.0.1 default target | 93 | 92 | 15.4 |
| WebAssembly exception handling (legacy) | 95 | 100 | 15.2 |
| Loaded as an ES module worker | 80 | 114 | 15 |
| **Together** | **95** | **100** (114 as a module worker) | **15.4** |

Sources: https://caniuse.com/wf-wasm-exception-handling, https://caniuse.com/mdn-api_worker_worker_ecmascript_modules.
Memory grows on demand up to 4 GB; browsers that allow less stop earlier.
