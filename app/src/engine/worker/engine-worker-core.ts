// The logic of the engine worker, independent of where it runs (browser module worker, Node worker thread in tests,
// or in-thread with a fake module). The thin entry points are engine-worker.ts (browser) and, for tests,
// tests/unit/engine/helpers/node-worker-entry.ts.
//
// Module contract (protocol/engine-protocol.json): the ES module's default export is an async factory that takes
// overrides { onEngineMessage, cancelFlags, print, printErr } and returns the module with _pc_init, _pc_handle,
// _malloc, _free and HEAPU8. Replies of one _pc_handle call arrive synchronously through onEngineMessage.
//
// One trap (integer division by zero, a call through a null pointer, abort) leaves the module in an undefined state.
// The worker then reports "fatal" once and refuses everything after it; the page throws it away and starts a new one.
import { PROTOCOL_VERSION } from "../generated/protocol.ts";
import type { FromWorker, ToWorker } from "./worker-protocol.ts";

export interface EngineModule {
  _pc_init(hasCancelFlags: number): number;
  _pc_handle(headerPtr: number, headerBytes: number, payloadPtr: number, payloadBytes: number): void;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  /** Read it again after every allocation: Emscripten replaces the view when the memory grows. */
  HEAPU8: Uint8Array;
}

export interface ModuleOverrides {
  onEngineMessage(header: string, payload: ArrayBuffer | null): void;
  cancelFlags?: Int32Array;
  print(text: string): void;
  printErr(text: string): void;
}

export type ModuleLoader = (moduleUrl: string, overrides: ModuleOverrides) => Promise<EngineModule>;

/** Loads partcraft-engine.mjs from a URL and creates the module. */
export const loadEngineModule: ModuleLoader = async (moduleUrl, overrides) => {
  const imported = (await import(/* @vite-ignore */ moduleUrl)) as { default?: unknown };
  if (typeof imported.default !== "function") {
    throw new Error("The engine module has no default export (the factory createEngineModule).");
  }
  return (imported.default as (o: ModuleOverrides) => Promise<EngineModule>)(overrides);
};

export interface WorkerIo {
  post(message: FromWorker, transfer?: Transferable[]): void;
}

export interface EngineWorkerCore {
  handle(message: ToWorker): void;
}

function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const head = `${e.name}: ${e.message}`;
  if (!e.stack) return head;
  // V8 stacks start with "Name: message"; the stacks of other engines do not.
  return e.stack.startsWith(head) ? e.stack : `${head}\n${e.stack}`;
}

export function createEngineWorkerCore(
  io: WorkerIo,
  load: ModuleLoader = loadEngineModule,
  now: () => number = () => performance.now(),
): EngineWorkerCore {
  const encoder = new TextEncoder();
  let module: EngineModule | null = null;
  let dead = false;
  /** Commands that arrive while the module is still loading. */
  const early: Extract<ToWorker, { kind: "msg" }>[] = [];

  const fatal = (message: string) => {
    dead = true;
    io.post({ kind: "fatal", message });
  };

  async function init(message: Extract<ToWorker, { kind: "init" }>): Promise<void> {
    const t0 = now();
    try {
      const loaded = await load(message.moduleUrl, {
        onEngineMessage(header, payload) {
          io.post({ kind: "msg", header, payload }, payload ? [payload] : []);
        },
        ...(message.cancelFlags ? { cancelFlags: message.cancelFlags } : {}),
        print: (text) => io.post({ kind: "log", stream: "stdout", text }),
        printErr: (text) => io.post({ kind: "log", stream: "stderr", text }),
      });
      const version = loaded._pc_init(message.cancelFlags ? 1 : 0);
      if (version !== PROTOCOL_VERSION) {
        fatal(
          `The engine module speaks protocol version ${version}, this program expects ${PROTOCOL_VERSION}. ` +
            `The program files come from different builds; reinstall Partcraft.`,
        );
        return;
      }
      module = loaded;
    } catch (e) {
      fatal(`The WebAssembly engine could not be loaded from ${message.moduleUrl}: ${describe(e)}`);
      return;
    }
    io.post({ kind: "ready", instantiateMs: now() - t0 });
    for (const m of early.splice(0)) run(m);
  }

  function run(message: Extract<ToWorker, { kind: "msg" }>): void {
    if (dead || !module) {
      io.post({ kind: "fatal", message: "The WebAssembly engine stopped after an earlier fatal error and must be restarted." });
      return;
    }
    const header = encoder.encode(message.header);
    let headerPtr = 0;
    let payloadPtr = 0;
    const payloadBytes = message.payload ? message.payload.byteLength : 0;
    try {
      headerPtr = module._malloc(Math.max(header.byteLength, 1));
      if (headerPtr === 0) throw new Error(`Out of memory: ${header.byteLength} bytes for a message header.`);
      module.HEAPU8.set(header, headerPtr);
      if (message.payload && payloadBytes > 0) {
        payloadPtr = module._malloc(payloadBytes);
        if (payloadPtr === 0) throw new Error(`Out of memory: ${payloadBytes} bytes for a message payload.`);
        module.HEAPU8.set(new Uint8Array(message.payload), payloadPtr);
      }
      module._pc_handle(headerPtr, header.byteLength, payloadPtr, payloadBytes);
    } catch (e) {
      // A trap or an abort escapes every C++ catch and ends up here; the module's state is undefined from now on.
      fatal(`The WebAssembly engine crashed: ${describe(e)}`);
      return;
    }
    module._free(headerPtr);
    if (payloadPtr) module._free(payloadPtr);
  }

  return {
    handle(message) {
      if (message.kind === "init") {
        void init(message);
      } else if (module || dead) {
        run(message);
      } else {
        early.push(message);
      }
    },
  };
}
