# Architecture spike: engine service and message contract

Throwaway spike for phase 0. It checks that one C++20 engine on Open CASCADE Technology (OCCT) 8.0.2 can serve the
user interface through **one message interface with two connections**: a separate native process on the desktop
and a WebAssembly module in a Web Worker in the browser, and that both answer the same. One shared React user
interface shows the result in an Electron window (native engine) and on a browser page (WebAssembly engine).

The engine rebuilds a small parametric part (block with a through hole and a fillet on the hole's top edge, part
P1a of [`../kerntest/PARTS.md`](../kerntest/PARTS.md)) or a spring (P4b) from a JSON recipe, checks every step with
`BRepCheck_Analyzer` plus a volume plausibility check, tessellates the result (0.05 mm chordal, 20°) and returns
triangle meshes with a face id per triangle.

## Layout

| Path | What |
|---|---|
| `protocol/protocol.ts` | Message types (TypeScript), constants, recipe format, mesh buffer layout |
| `protocol/protocol.schema.json` | The same messages as JSON Schema (draft 2020-12); the tests validate every message against it |
| `protocol/protocol.hpp` | Constants for the C++ side (protocol version, frame layout, error codes) |
| `protocol/frame.ts`, `protocol/mesh.ts` | Stdio frame encoder/decoder; typed-array views on mesh payloads |
| `engine/src/` | Engine: `engine.*` (dispatch, queue, cancel), `model.*` (recipe, rebuild, step cache, OCCT steps), `mesh.*` (tessellation, binary encoding), `json.*`, `main_native.cpp`, `main_wasm.cpp` |
| `engine/scripts/build-windows.ps1` | Native build (MSVC, Ninja) against the OCCT build of the kernel test |
| `engine/scripts/build-wasm.ps1`, `engine/docker/wasm-build.sh` | WebAssembly build in a throwaway `emscripten/emsdk:7.0.1` container |
| `client/` | Engine client (`engine-client.ts`), transports (`native-transport.ts`, `worker-transport.ts`), worker script (`engine-worker.mjs`), Node worker adapter |
| `recipes/` | Example recipes `p1a.json` and `spring.json` |
| `app/` | Shared user interface (Vite, React, TypeScript): `recipe-store.ts` (the UI owns the recipe, undo/redo), `engine-session.ts` (mirrors recipe changes to the engine, drops stale replies, crash recovery), `electron-transport.ts` (desktop connection over a MessagePort), `viewport.ts` (three.js WebGPURenderer with WebGL2 fallback, edges, picking), `App.tsx`, `notices.ts` (full, copyable messages), `autotest.ts` (scripted UI run) |
| `desktop/` | Electron main process: `main.ts` (window, `app://` scheme, security settings), `engine-host.ts` (starts and supervises the native engine, watchdog), `preload.ts` (one-function bridge) |
| `vite.config.ts`, `vite.desktop.config.ts` | Builds of the UI (`_build/app-web`) and of the Electron main process and preload (`_build/app-desktop`) |
| `tests/` | Contract tests (`contract.test.ts`), crash recovery (`crash.test.ts`), transport measurements (`bench.ts`), UI run over the DevTools protocol (`ui-drive.ts`) |
| `_build/`, `node_modules/` | Build output and dependencies (git-ignored) |

## Requirements

- Windows: Visual Studio 2022 or its Build Tools with the C++ workload (MSVC, bundled CMake and Ninja).
- The OCCT 8.0.2 builds of the kernel test (see [`../kerntest/occt/README.md`](../kerntest/occt/README.md)):
  - shared Windows build in `../kerntest/_build/occt-win-install` (`build-occt-windows.ps1`),
  - static WebAssembly build with native wasm exceptions, kept with
    `docker-wasm.ps1 -OutDir <dir> -KeepOcct -WasmExceptions -Extra '-UOCC_CONVERT_SIGNALS'`; the WebAssembly
    script expects it in `../kerntest/_build/wasm-final/wasmeh/occt-install` unless `-OcctInstall` is given.
- Docker Desktop (WebAssembly build only).
- Node.js with built-in TypeScript type stripping (tested with Node.js 26); the tests run the `.ts` files directly.

## Build

```powershell
powershell -ExecutionPolicy Bypass -File engine\scripts\build-windows.ps1   # -> _build\engine-win\halfcube-engine.exe + OCCT DLLs
powershell -ExecutionPolicy Bypass -File engine\scripts\build-wasm.ps1      # -> _build\engine-wasm\halfcube-engine.mjs + .wasm
npm install
```

## Test and measure

```powershell
npm run typecheck
npm test                                  # contract and crash tests against both engines
node tests\bench.ts --out <results.json>  # transport measurements
```

`HC_ENGINE_EXE` and `HC_ENGINE_WASM` point the tests at other builds. A suite whose engine is not built is skipped.

## Running the engine

**Native:** `halfcube-engine.exe [--debug-commands]`. It reads frames on stdin and writes frames on stdout;
diagnostics go to stderr (stdout is redirected to stderr at start, so stray library output cannot corrupt the
frame stream). Frame: `u32 magic "PCE0"`, `u32 header bytes`, `u32 payload bytes`, `u32 0`, then the UTF-8 JSON
header and the binary payload, all little-endian. It exits with 0 after `shutdown` or at the end of its input.
`client/native-transport.ts` starts it and decodes the frames (Node; on the desktop this belongs in the Electron
main process).

**WebAssembly:** `client/engine-worker.mjs` runs as a module worker (or Node worker thread), imports
`halfcube-engine.mjs` from the URL given in its `init` message and passes messages in and out. Use
`WorkerTransport` with `browserWorkerPort(new URL("./engine-worker.mjs", import.meta.url))` and the absolute URL of
`halfcube-engine.mjs`; the `.wasm` file must be served next to it.

Both transports deliver the same `(header text, payload ArrayBuffer)` pairs to `EngineClient`.

## Start script

```powershell
powershell -ExecutionPolicy Bypass -File scriptsdev.ps1 [start|stop|restart|status|logs] [-Neubau] [-NurBrowser] [-NurDesktop] [-Ausweichport]
```

Builds what is missing (npm packages, Electron runtime, native engine, WebAssembly engine, UI bundles), then starts the
browser page (`vite preview` on 127.0.0.1:5311) and the Electron window. The port is read from `vite.config.ts`; a port
held by a foreign program stops the start with the holder named, `-Ausweichport` takes the next free port for that run.
Process ids and logs are in `_build/run/`. If the script output is piped into another program, that program only sees the
end of the output after `stop`, because the background servers inherit the pipe; write the output to a file instead.

## User interface: desktop and browser

```powershell
npm install
npm run build:ui        # -> _build\app-web (page, with the WebAssembly engine under engine/) and _build\app-desktop
```

The Electron runtime (45.x) is downloaded on the first `npm run start:desktop` (or with `npx install-electron`).

**Desktop (Electron, native engine):** `npm run start:desktop`. The main process loads the page from the
`app://halfcube` scheme (files of `_build/app-web` only), starts `_build/engine-win/halfcube-engine.exe`
(override with `HC_ENGINE_EXE`) and hands the UI a MessagePort for it. `HC_SPIKE_QUERY=renderer=webgl` passes
query parameters to the page. For UI work with hot reload: `npm run dev:web`, then set
`HC_SPIKE_DEV_URL=http://127.0.0.1:5310/` and run `npm run start:desktop`.

**Browser (WebAssembly engine in a Web Worker):** `npm run preview:web` and open `http://127.0.0.1:5311/` (built
page), or `npm run dev:web` and open `http://127.0.0.1:5310/` (dev server). Both servers listen on 127.0.0.1 only
and send COOP/COEP headers, so the page is cross-origin isolated and a running WebAssembly rebuild can be cancelled
through a SharedArrayBuffer.

**Page parameters** (spike diagnostics): `renderer=auto` (WebGPU, falls back to WebGL2 by itself),
`renderer=webgl` (WebGL2 forced), `renderer=nogpu` (`navigator.gpu` hidden, so the automatic fallback runs),
`engine=wasm` (WebAssembly engine inside the Electron window too). The active backend is shown at the top right.

What the page does: it shows part P1a; a click on a face highlights it and names the face id, its surface type and
the step that created it (from the per-triangle face ids); sliders change hole diameter, fillet radius and length;
undo/redo change the recipe in the UI, which then sends the matching command; the crash buttons send `debugCrash`
(and, on the desktop, make the main process's watchdog fire). After a crash the UI shows the full error text with a
Copy button, starts a new engine (desktop: the main process spawns it; browser: a new worker) and replays the recipe
it owns.

**Desktop supervision:** the main process notices an engine exit at once and reports it to the UI with exit code
and the engine's last diagnostic output. After the UI's hello it also pings the engine every second with its own
request ids (counting down from 2147483647, while the UI counts up from 1) and stops an engine that does not answer
within 5 s; the native engine answers pings while it computes, so long rebuilds do not trip it.

**Electron security settings:** context isolation, no Node integration, sandboxed renderer, a preload that exposes
only `startEngine()`, a Content Security Policy without `unsafe-eval` (`wasm-unsafe-eval` only), navigation and new
windows blocked, every permission denied except writing to the clipboard, network requests limited to the app's own
scheme.

**Automated UI run:** `node tests\ui-drive.ts --target desktop|web [--renderer auto|webgl|nogpu] [--headed]
[--out report.json] [--shot <folder>]`. It starts the Electron app, or `vite preview` plus a Chromium-based browser
(path in `HC_BROWSER_EXE`, temporary profile), connects over the DevTools protocol on 127.0.0.1:5312, clicks a face
with real mouse events and runs `app/src/autotest.ts`: picking of every face, parameter rebuilds, undo, stale
replies, a step error, three crash modes, the watchdog (desktop) and the spring mesh.

**Viewport:** three.js `WebGPURenderer` (`three/webgpu`). It falls back to its WebGL2 backend when WebGPU is
missing, draws the B-rep edges as screen-space lines with a width in pixels (`Line2NodeMaterial`) on both
backends, and picks with a CPU raycast whose hit triangle is mapped to its face through the `faceIds` buffer.
Meshes are drawn straight from the payload (typed-array views, no copy); the selected face is drawn a second time
with the same buffers and a draw range over its contiguous triangles.

## End-to-end tests (Playwright)

`npm run build:ui` then `npm run test:e2e` drives the Electron window (native engine) and the built browser page
(WebAssembly engine, headless Chromium) with real mouse input and checks: the shown body, the message interface
(contract tests on both engines, equal geometry), face picking, parameter changes and stale replies, engine crashes
and recovery (engine killed from outside, crash buttons, a frozen process, WebAssembly traps), the WebGL2 fallback,
and that the window and the page carry the project logo as their icon.

- The Electron window is shown without taking the focus (`HC_E2E_WINDOW=inactive`, the default). `hidden` never
  shows it, but Playwright screenshots of a hidden Electron window time out, so most tests need `inactive`.
- `HC_BROWSER_EXE` selects the Chromium-based browser (default: first of Chrome, Edge, Brave found).
- `HC_E2E_EVIDENCE` is the folder for screenshots and logs (default `_build/e2e-evidence`).
- The icons in `assets/` are resampled copies of the project logo (`node scripts/make-icons.mjs <logo.png> <browser>`).
- The test for a hung WebAssembly worker is marked as a known gap (no watchdog on that path yet).

## Protocol in short

See `protocol/protocol.ts` for every field. Commands: `hello` (first, compares the protocol version),
`loadRecipe`, `setParameter`, `cancel`, `ping`, `shutdown`, and the test commands `debugCrash`, `debugPayload`
(and the recipe step `debug.spin`), which the engine only accepts when started with debug commands enabled.
Replies and events: `helloResult`, `progress`, `result`, `pong`, `cancelResult`, `bye`, `debugPayloadResult`,
`error`. Every reply carries `replyTo` (the command id) and `recipeVersion`. Mesh buffers (positions, normals,
indices, per-triangle face ids, edge segments, edge ids) travel in the binary payload at 16-byte aligned offsets.

## Licences

OCCT: `LGPL-2.1-only WITH OCCT-exception-1.0`. Emscripten (build tool only): MIT or University of Illinois/NCSA.
Development dependencies: TypeScript (Apache-2.0), Ajv (MIT), `@types/node` (MIT), Electron (MIT; ships Chromium
under its own licences), three.js and `@types/three` (MIT), React and React DOM (MIT), `@types/react` and
`@types/react-dom` (MIT), Vite and `@vitejs/plugin-react` (MIT). This spike: PolyForm Shield License 1.0.0 (see `LICENSE` in the repository root).
