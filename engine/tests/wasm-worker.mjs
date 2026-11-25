// Node worker thread that hosts the WebAssembly engine for engine/tests/drive-engine.mjs (the browser uses its
// own module worker in the app). It follows the module contract of protocol/engine-protocol.json:
// createEngineModule({ onEngineMessage, cancelFlags }), _pc_init, _pc_handle, _malloc, _free, HEAPU8.
//
// From the driver: { kind: "init", moduleUrl, cancelFlags: Int32Array | null }, { kind: "msg", header }
// To the driver:   { kind: "ready", instantiateMs }, { kind: "msg", header, payload }, { kind: "fatal", message },
//                  { kind: "log", stream, text }
import { parentPort } from "node:worker_threads";

let mod = null;
let dead = false;
const pending = [];
const post = (m) => parentPort.postMessage(m);

function describe(e) {
  if (!(e instanceof Error)) return String(e);
  return `${e.name}: ${e.message}`;
}

async function init(msg) {
  const t0 = performance.now();
  try {
    const { default: createEngineModule } = await import(msg.moduleUrl);
    mod = await createEngineModule({
      onEngineMessage: (header, payload) => post({ kind: "msg", header, payload }),
      cancelFlags: msg.cancelFlags ?? undefined,
      print: (text) => post({ kind: "log", stream: "stdout", text }),
      printErr: (text) => post({ kind: "log", stream: "stderr", text }),
    });
    mod._pc_init(msg.cancelFlags ? 1 : 0);
  } catch (e) {
    dead = true;
    post({ kind: "fatal", message: `The WebAssembly engine could not be loaded from ${msg.moduleUrl}: ${describe(e)}` });
    return;
  }
  post({ kind: "ready", instantiateMs: performance.now() - t0 });
  for (const m of pending.splice(0)) handle(m);
}

function handle(msg) {
  if (dead) return;
  const header = new TextEncoder().encode(msg.header);
  const hp = mod._malloc(Math.max(header.byteLength, 1));
  mod.HEAPU8.set(header, hp);
  try {
    mod._pc_handle(hp, header.byteLength, 0, 0);
  } catch (e) {
    // A trap or abort escapes every C++ catch; the module state is undefined from now on.
    dead = true;
    post({ kind: "fatal", message: `The WebAssembly engine crashed: ${describe(e)}` });
    return;
  }
  mod._free(hp);
}

parentPort.on("message", (msg) => {
  if (msg.kind === "init") void init(msg);
  else if (msg.kind === "msg") {
    if (mod) handle(msg);
    else pending.push(msg);
  }
});
