// Browser transport: the WebAssembly engine inside a Web Worker (engine-worker.mjs). Also runs in Node through
// node-worker-port.ts, which is how the contract tests load the same module.
import type { EngineTransport, ExitInfo } from "./transport.ts";

/** The part of a Worker this transport needs; browser and Node workers are adapted to it. */
export interface WorkerPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((data: unknown) => void) | null;
  onerror: ((error: unknown) => void) | null;
  terminate(): void;
}

/** Browser: module worker from a URL (for example new URL("./engine-worker.mjs", import.meta.url)). */
export function browserWorkerPort(url: string | URL): WorkerPort {
  const w = new Worker(url, { type: "module" });
  const port: WorkerPort = {
    postMessage: (m, t) => w.postMessage(m, t ?? []),
    onmessage: null,
    onerror: null,
    terminate: () => w.terminate(),
  };
  w.onmessage = (e) => port.onmessage?.(e.data);
  w.onerror = (e) => port.onerror?.(e);
  return port;
}

export interface WorkerTransportOptions {
  createPort: () => WorkerPort;
  /** URL of partcraft-engine.mjs (the Emscripten module); resolved inside the worker. */
  moduleUrl: string;
  debugCommands?: boolean;
  /**
   * Use a SharedArrayBuffer cancel flag so a running rebuild can be cancelled. Needs SharedArrayBuffer, which
   * browsers only offer to cross-origin-isolated pages (COOP/COEP headers). Without it, cancel only works between
   * commands; a hard cancel is kill() plus a restart.
   */
  sharedCancel?: boolean;
}

type FromWorker =
  | { kind: "ready"; instantiateMs: number }
  | { kind: "msg"; header: string; payload: ArrayBuffer | null }
  | { kind: "fatal"; message: string }
  | { kind: "log"; stream: "stdout" | "stderr"; text: string };

export class WorkerTransport implements EngineTransport {
  readonly kind = "wasm" as const;
  onMessage: ((header: string, payload: ArrayBuffer | null) => void) | null = null;
  onExit: ((info: ExitInfo) => void) | null = null;
  /** Time the worker needed to import and instantiate the module (ms). */
  instantiateMs = NaN;
  private port: WorkerPort | null = null;
  private cancelFlags: Int32Array | null = null;
  private log = "";
  private dead = false;
  private readonly opts: WorkerTransportOptions;

  constructor(opts: WorkerTransportOptions) {
    this.opts = opts;
  }

  get hasSharedCancel(): boolean {
    return this.cancelFlags !== null;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = this.opts.createPort();
      this.port = port;
      const crossOriginOk = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== false;
      if (this.opts.sharedCancel && typeof SharedArrayBuffer !== "undefined" && crossOriginOk) {
        this.cancelFlags = new Int32Array(new SharedArrayBuffer(4));
      }
      let ready = false;
      port.onmessage = (data) => {
        const m = data as FromWorker;
        if (m.kind === "msg") this.onMessage?.(m.header, m.payload);
        else if (m.kind === "ready") {
          ready = true;
          this.instantiateMs = m.instantiateMs;
          resolve();
        } else if (m.kind === "log") {
          this.log = (this.log + `[${m.stream}] ${m.text}\n`).slice(-65536);
        } else if (m.kind === "fatal") {
          if (!ready) { reject(new Error(m.message)); return; }
          this.fail({ kind: "fatal", message: m.message, diagnostics: this.log });
        }
      };
      port.onerror = (e) => {
        const text = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String((e as { message?: string })?.message ?? e);
        if (!ready) { reject(new Error(`The engine worker failed to start: ${text}`)); return; }
        this.fail({ kind: "error", message: `The engine worker failed: ${text}`, diagnostics: this.log });
      };
      port.postMessage({
        kind: "init",
        moduleUrl: this.opts.moduleUrl,
        debugCommands: !!this.opts.debugCommands,
        cancelFlags: this.cancelFlags,
      });
    });
  }

  private fail(info: ExitInfo) {
    if (this.dead) return;
    this.dead = true;
    // The module's state is undefined after a trap; the worker is thrown away and recreated by the client.
    this.port?.terminate();
    this.onExit?.(info);
  }

  send(header: string, payload?: ArrayBuffer | null): void {
    if (!this.port || this.dead) throw new Error("The engine worker is not running.");
    // The cancel flag is not reset here: it holds a request id, and ids are never reused.
    this.port.postMessage({ kind: "msg", header, payload: payload ?? null }, payload ? [payload] : []);
  }

  kill(): void {
    this.dead = true;
    this.port?.terminate();
  }

  cancelRunning(requestId: number): boolean {
    if (!this.cancelFlags) return false;
    Atomics.store(this.cancelFlags, 0, requestId);
    return true;
  }
}
