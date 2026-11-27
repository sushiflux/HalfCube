# HalfCube engine

The engine computes geometry (OCCT 8.0.2) and solves sketches (planegcs from FreeCAD 1.1.4). It is built as a native
program, `halfcube-engine.exe` on Windows: a separate process started by the Electron main process. It talks over
stdin/stdout in length-prefixed frames (16-byte prefix, JSON header, binary payload).

The messages are defined once in `protocol/engine-protocol.json`. `node protocol/generate.mjs` writes the C++ header
(`engine/src/generated/protocol.hpp`), the TypeScript types (`app/src/engine/generated/protocol.ts`) and the JSON
Schema (`protocol/engine-protocol.schema.json`); `--check` fails when one of them is out of date.

## Building

| Step | Command |
|---|---|
| Fetch pinned third-party sources into `engine/_deps/` | `powershell -File engine/scripts/fetch-deps.ps1` (Linux: `sh engine/scripts/fetch-deps.sh`) |
| Windows (MSVC, Ninja, Release, unit tests) | `powershell -File engine/scripts/build-windows.ps1 [-TestCommands] [-OcctDir <dir>]` |
| Linux compile check | `bash engine/scripts/build-linux.sh [--test]` |

Versions, licences and sources of every bundled component are listed in `third_party/manifest.json`. OCCT is built
from source once per platform and reused from `engine/_build/`. `-TestCommands` adds `diagnostics.crash` and
`diagnostics.hang`; release builds refuse them with `test_commands_disabled`.

## Testing

- C++ unit tests (doctest) run at the end of `build-windows.ps1` and with `build-linux.sh --test`.
- `node engine/tests/drive-engine.mjs --native <exe> --out a.json` drives a built engine through the message
  interface and checks every answer against the JSON Schema.
