// One interface, two connections (concept 3.1): the native process on the desktop (reached through the Electron main
// process), the Web Worker with the WebAssembly module in the browser.

export interface ExitInfo {
  /**
   * exit: the native process ended. fatal: the WebAssembly module trapped. hang: the engine stopped answering and was
   * stopped by a watchdog. error: the connection to the engine broke.
   */
  kind: "exit" | "fatal" | "hang" | "error";
  /** Complete, specific description of what happened. */
  message: string;
  code?: number | null;
  signal?: string | null;
  /** Last part of the engine's diagnostic output (native stderr, worker console). */
  diagnostics?: string;
}

export interface EngineTransport {
  readonly kind: "native" | "wasm";
  /** Starts the engine (spawns the process, loads the module). Rejects with the complete cause when that fails. */
  start(): Promise<void>;
  /** Throws when the connection is closed. */
  send(header: string, payload?: ArrayBuffer | null): void;
  onMessage: ((header: string, payload: ArrayBuffer | null) => void) | null;
  /** The engine ended or the connection broke. Not called after kill(). */
  onExit: ((info: ExitInfo) => void) | null;
  /** Hard stop: kills the process or terminates the worker. onExit is not called for a kill. */
  kill(): void;
  /**
   * Signals cancellation to a command that is running right now, bypassing the message queue. Only the WebAssembly
   * transport with a shared cancel flag needs this; returns false when unsupported.
   */
  cancelRunning(requestId: number): boolean;
  /** Recent diagnostic output of the engine, for problem reports. */
  readonly diagnostics?: string;
}
