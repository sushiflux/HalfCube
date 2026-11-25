// Browser transport: the WebAssembly engine inside a Web Worker (worker/engine-worker.ts). The same transport runs in
// Node tests through a worker_threads adapter (tests/unit/engine/helpers), which is how the contract tests load the
// real module. A hung or trapped module is handled one level up: the client's hang watchdog calls kill(), which
// terminates the worker, and the session starts a new one.
import type { FromWorker, ToWorker } from "../worker/worker-protocol.ts";
import type { EngineTransport, ExitInfo } from "../transport.ts";

/** The part of a Worker this transport needs; browser and Node workers are adapted to it. */
export interface WorkerPort {
  postMessage(message: ToWorker, transfer?: Transferable[]): void;
  onmessage: ((data: FromWorker) => void) | null;
  onerror: ((error: unknown) => void) | null;
  terminate(): void;
}

/**
 * Browser: wraps a module worker. The Worker itself is created where the bundler can see its URL
 * (new Worker(new URL("./worker/engine-worker.ts", import.meta.url), { type: "module" }), see create.ts).
 */
export function browserWorkerPort(worker: Worker): WorkerPort {
  const port: WorkerPort = {
    postMessage: (message, transfer) => worker.postMessage(message, transfer ?? []),
    onmessage: null,
    onerror: null,
    terminate: () => worker.terminate(),
  };
  worker.onmessage = (event: MessageEvent<FromWorker>) => port.onmessage?.(event.data);
  worker.onerror = (event) => port.onerror?.(event);
  return port;
}

export interface WorkerTransportOptions {
  createPort: () => WorkerPort;
  /** Absolute URL of partcraft-engine.mjs (the Emscripten module); partcraft-engine.wasm must lie next to it. */
  moduleUrl: string;
  /**
   * Use a SharedArrayBuffer cancel flag so a running command can be cancelled. Needs SharedArrayBuffer, which browsers
   * only offer to cross-origin-isolated pages (COOP/COEP headers). Without it, cancel only works between commands; a
   * hard cancel is the hang watchdog's terminate plus a restart. Default true.
   */
  sharedCancel?: boolean;
  /** How long loading and instantiating the module may take (download included). Default 60 s. */
  startTimeoutMs?: number;
}

function describeWorkerError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}${e.stack ? `\n${e.stack}` : ""}`;
  const ev = e as { message?: string; filename?: string; lineno?: number } | null;
  if (ev && typeof ev.message === "string" && ev.message) {
    return `${ev.message}${ev.filename ? ` (${ev.filename}${ev.lineno ? `:${ev.lineno}` : ""})` : ""}`;
  }
  return "the worker reported an error without a message (a script that failed to load reports it that way)";
}

export class WorkerTransport implements EngineTransport {
  readonly kind = "wasm" as const;
  onMessage: ((header: string, payload: ArrayBuffer | null) => void) | null = null;
  onExit: ((info: ExitInfo) => void) | null = null;
  /** Time the worker needed to import and instantiate the module (ms); NaN until it is ready. */
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

  get diagnostics(): string {
    return this.log;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = this.opts.createPort();
      this.port = port;
      const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== false;
      if ((this.opts.sharedCancel ?? true) && typeof SharedArrayBuffer !== "undefined" && isolated) {
        this.cancelFlags = new Int32Array(new SharedArrayBuffer(4));
      }
      let ready = false;
      const startTimeoutMs = this.opts.startTimeoutMs ?? 60_000;
      const timer = setTimeout(() => {
        if (ready || this.dead) return;
        this.dead = true;
        port.terminate();
        reject(
          new Error(
            `The WebAssembly engine did not become ready within ${startTimeoutMs / 1000} s ` +
              `(loading ${this.opts.moduleUrl}); the worker was terminated.${this.log ? `\n${this.log}` : ""}`,
          ),
        );
      }, startTimeoutMs);

      port.onmessage = (m) => {
        if (this.dead) return;
        if (m.kind === "msg") {
          this.onMessage?.(m.header, m.payload);
        } else if (m.kind === "ready") {
          ready = true;
          clearTimeout(timer);
          this.instantiateMs = m.instantiateMs;
          resolve();
        } else if (m.kind === "log") {
          this.log = (this.log + `[${m.stream}] ${m.text}\n`).slice(-65536);
        } else if (!ready) {
          clearTimeout(timer);
          this.dead = true;
          port.terminate();
          reject(new Error(m.message));
        } else {
          this.fail({ kind: "fatal", message: m.message, diagnostics: this.log });
        }
      };
      port.onerror = (e) => {
        if (this.dead) return;
        const text = describeWorkerError(e);
        if (!ready) {
          clearTimeout(timer);
          this.dead = true;
          port.terminate();
          reject(new Error(`The engine worker failed to start: ${text}`));
          return;
        }
        this.fail({ kind: "error", message: `The engine worker failed: ${text}`, diagnostics: this.log });
      };
      const init: ToWorker = { kind: "init", moduleUrl: this.opts.moduleUrl, cancelFlags: this.cancelFlags };
      port.postMessage(init);
    });
  }

  private fail(info: ExitInfo): void {
    if (this.dead) return;
    this.dead = true;
    // The module's state is undefined after a trap: the worker is thrown away, the session starts a new one.
    this.port?.terminate();
    this.onExit?.(info);
  }

  send(header: string, payload?: ArrayBuffer | null): void {
    if (!this.port || this.dead) throw new Error("The engine worker is not running.");
    // The cancel flag is not reset: it holds a request id, and ids are not reused on one connection.
    const message: ToWorker = { kind: "msg", header, payload: payload ?? null };
    this.port.postMessage(message, payload ? [payload] : []);
  }

  kill(): void {
    this.dead = true;
    this.port?.terminate();
  }

  cancelRunning(requestId: number): boolean {
    if (!this.cancelFlags || this.dead) return false;
    Atomics.store(this.cancelFlags, 0, requestId);
    return true;
  }
}
