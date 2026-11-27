// The connection to the engine (concept 3.1): the native engine process, reached through the Electron main process.

export interface ExitInfo {
  /**
   * exit: the native process ended. hang: the engine stopped answering and was stopped by a watchdog. error: the
   * connection to the engine broke.
   */
  kind: "exit" | "hang" | "error";
  /** Complete, specific description of what happened. */
  message: string;
  code?: number | null;
  signal?: string | null;
  /** Last part of the engine's diagnostic output (native stderr). */
  diagnostics?: string;
}

export interface EngineTransport {
  readonly kind: "native";
  /** Starts the engine (spawns the process). Rejects with the complete cause when that fails. */
  start(): Promise<void>;
  /** Throws when the connection is closed. */
  send(header: string, payload?: ArrayBuffer | null): void;
  onMessage: ((header: string, payload: ArrayBuffer | null) => void) | null;
  /** The engine ended or the connection broke. Not called after kill(). */
  onExit: ((info: ExitInfo) => void) | null;
  /** Hard stop: kills the process. onExit is not called for a kill. */
  kill(): void;
  /** Recent diagnostic output of the engine, for problem reports. */
  readonly diagnostics?: string;
}
