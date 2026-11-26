// Creates the engine session for the place the UI runs in: inside the Electron window the native engine behind the
// preload bridge, in a browser the WebAssembly engine in a Web Worker.
import { branding } from "../branding.ts";
import { getDesktopBridge } from "../platform.ts";
import { currentVersion } from "../version.ts";
import { WASM_MODULE_FILE } from "./generated/protocol.ts";
import { EngineSession, type EngineSessionOptions } from "./session.ts";
import { DesktopTransport } from "./transports/desktop-transport.ts";
import { browserWorkerPort, WorkerTransport } from "./transports/worker-transport.ts";

/**
 * Folder of the WebAssembly engine inside the web build, relative to the page: halfcube-engine.mjs and .wasm
 * (see config/engine-assets.ts, which puts them there). The testing variant with crash and hang commands is served
 * from "engine-testing/" in builds made with HALFCUBE_WASM_TESTING=1 and in the dev server.
 */
export const WASM_ENGINE_FOLDER = "engine";
export const WASM_TESTING_FOLDER = "engine-testing";

export interface CreateEngineSessionOptions extends Partial<Omit<EngineSessionOptions, "createTransport">> {
  /** Absolute URL of halfcube-engine.mjs; default: the engine folder next to the page. */
  wasmModuleUrl?: string;
}

export function defaultWasmModuleUrl(folder: string = WASM_ENGINE_FOLDER): string {
  return new URL(`${folder}/${WASM_MODULE_FILE}`, document.baseURI).href;
}

export function createEngineSession(options: CreateEngineSessionOptions = {}): EngineSession {
  const { wasmModuleUrl, ...sessionOptions } = options;
  const version = `${branding.name} ${currentVersion().display}`;
  const bridge = getDesktopBridge();
  const createTransport = bridge
    ? () => new DesktopTransport(bridge)
    : () =>
        new WorkerTransport({
          createPort: () =>
            // The URL must stay a literal inside this call: the bundler finds and bundles the worker through it.
            browserWorkerPort(new Worker(new URL("./worker/engine-worker.ts", import.meta.url), { type: "module", name: "halfcube-engine" })),
          moduleUrl: wasmModuleUrl ?? defaultWasmModuleUrl(),
        });
  return new EngineSession({ createTransport, clientName: version, appVersion: version, ...sessionOptions });
}
