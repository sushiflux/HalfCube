// Worker script hosting the WebAssembly engine (partcraft-engine.mjs). Runs as a browser module worker or as a
// Node worker_thread. Plain JavaScript so it can be loaded without a build step.
//
// Messages from the client:  { kind: "init", moduleUrl, debugCommands, cancelFlags: Int32Array | null }
//                            { kind: "msg", header: string, payload: ArrayBuffer | null }
// Messages to the client:    { kind: "ready", instantiateMs }
//                            { kind: "msg", header: string, payload: ArrayBuffer | null }   (payload transferred)
//                            { kind: "fatal", message }   the module trapped; this worker must be thrown away
//                            { kind: "log", stream, text }

let post;
const inBrowserWorker = typeof self !== "undefined" && typeof self.postMessage === "function" && typeof WorkerGlobalScope !== "undefined";
if (inBrowserWorker) {
  post = (m, t) => self.postMessage(m, t ?? []);
  self.onmessage = (e) => onClientMessage(e.data);
} else {
  const { parentPort } = await import("node:worker_threads");
  post = (m, t) => parentPort.postMessage(m, t ?? []);
  parentPort.on("message", onClientMessage);
}

let mod = null;
let dead = false;
const pending = []; // messages that arrive while the module is still loading

function describe(e) {
  if (!(e instanceof Error)) return String(e);
  const head = `${e.name}: ${e.message}`;
  // V8 stacks start with "Name: message"; other engines' stacks do not.
  if (!e.stack) return head;
  return e.stack.startsWith(head) ? e.stack : `${head}\n${e.stack}`;
}

async function init(msg) {
  const t0 = performance.now();
  try {
    const { default: createEngineModule } = await import(msg.moduleUrl);
    mod = await createEngineModule({
      onEngineMessage(header, payload) {
        post({ kind: "msg", header, payload }, payload ? [payload] : []);
      },
      cancelFlags: msg.cancelFlags ?? undefined,
      print: (text) => post({ kind: "log", stream: "stdout", text }),
      printErr: (text) => post({ kind: "log", stream: "stderr", text }),
    });
    mod._pc_init(msg.debugCommands ? 1 : 0, msg.cancelFlags ? 1 : 0);
  } catch (e) {
    dead = true;
    post({ kind: "fatal", message: `The WebAssembly engine could not be loaded from ${msg.moduleUrl}: ${describe(e)}` });
    return;
  }
  post({ kind: "ready", instantiateMs: performance.now() - t0 });
  for (const m of pending.splice(0)) handle(m);
}

function handle(msg) {
  if (dead) {
    post({ kind: "fatal", message: "The WebAssembly engine stopped after an earlier fatal error and must be restarted." });
    return;
  }
  const header = new TextEncoder().encode(msg.header);
  const hp = mod._malloc(Math.max(header.byteLength, 1));
  mod.HEAPU8.set(header, hp);
  let pp = 0;
  let plen = 0;
  if (msg.payload && msg.payload.byteLength > 0) {
    plen = msg.payload.byteLength;
    pp = mod._malloc(plen);
    mod.HEAPU8.set(new Uint8Array(msg.payload), pp);
  }
  try {
    mod._pc_handle(hp, header.byteLength, pp, plen);
  } catch (e) {
    // A trap (for example an integer division by zero or a call through a null pointer) or an abort escapes
    // every C++ catch and ends up here. The module's state is undefined from now on.
    dead = true;
    post({ kind: "fatal", message: `The WebAssembly engine crashed: ${describe(e)}` });
    return;
  }
  mod._free(hp);
  if (pp) mod._free(pp);
}

function onClientMessage(msg) {
  if (msg.kind === "init") void init(msg);
  else if (msg.kind === "msg") {
    if (mod) handle(msg);
    else pending.push(msg);
  }
}
