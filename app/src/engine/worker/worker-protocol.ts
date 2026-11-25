// Messages between the WorkerTransport (page side) and the engine worker. Types only.

/** Page -> worker. */
export type ToWorker =
  /** Load the WebAssembly engine from moduleUrl (an absolute URL of partcraft-engine.mjs) and create the engine. */
  | { kind: "init"; moduleUrl: string; cancelFlags: Int32Array | null }
  /** One engine command; the payload (if any) is transferred. */
  | { kind: "msg"; header: string; payload: ArrayBuffer | null };

/** Worker -> page. */
export type FromWorker =
  | { kind: "ready"; instantiateMs: number }
  | { kind: "msg"; header: string; payload: ArrayBuffer | null }
  /** The module could not be loaded or trapped; the module's state is undefined, the worker must be thrown away. */
  | { kind: "fatal"; message: string }
  | { kind: "log"; stream: "stdout" | "stderr"; text: string };
