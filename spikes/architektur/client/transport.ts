// One interface, two connections (concept 3.1): the native process on the desktop, the Web Worker in the browser.

export interface ExitInfo {
  /** exit: the native process ended; fatal: the WebAssembly module trapped; error: the transport broke. */
  kind: "exit" | "fatal" | "error";
  /** Complete, user-presentable description. */
  message: string;
  code?: number | null;
  signal?: string | null;
  /** Last part of the engine's diagnostic output (native stderr, worker console). */
  diagnostics?: string;
}

export interface EngineTransport {
  readonly kind: "native" | "wasm";
  start(): Promise<void>;
  send(header: string, payload?: ArrayBuffer | null): void;
  onMessage: ((header: string, payload: ArrayBuffer | null) => void) | null;
  onExit: ((info: ExitInfo) => void) | null;
  /** Hard stop: kills the process or terminates the worker. onExit is not called for a kill. */
  kill(): void;
  /**
   * Signals cancellation to a rebuild that is running right now, bypassing the message queue.
   * Only the WebAssembly transport with a shared cancel flag needs this; returns false when unsupported.
   */
  cancelRunning(requestId: number): boolean;
}
