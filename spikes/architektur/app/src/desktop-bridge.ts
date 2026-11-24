// Shape of the minimal bridge the Electron preload script exposes to the UI (window.partcraftDesktop), and of the
// messages on the MessagePort between the UI and the Electron main process. Types only; shared by both sides.
import type { ExitInfo } from "../../client/transport.ts";

export type StartEngineResult = { ok: true; generation: number } | { ok: false; message: string };

export interface DesktopBridge {
  readonly kind: "electron";
  readonly versions: { electron: string; chrome: string; node: string };
  /**
   * Asks the main process to (re)start the native engine. It kills a previous engine of this window, spawns a new
   * one and then delivers a MessagePort for it through window.postMessage({ partcraft: "engine-port", generation }).
   */
  startEngine(): Promise<StartEngineResult>;
}

/** Message the preload script posts to the page together with the transferred MessagePort. */
export interface EnginePortEnvelope {
  partcraft: "engine-port";
  generation: number;
}

/** UI -> main process, on the engine port. */
export type ToMain =
  | { kind: "msg"; header: string; payload: ArrayBuffer | null }
  /** Stop the engine without an exit report. */
  | { kind: "kill" }
  /** Test only (debug builds): the main process stops counting liveness answers, so its watchdog fires. */
  | { kind: "debugSimulateHang" };

/** Main process -> UI, on the engine port. */
export type FromMain =
  /** tMain: epoch milliseconds (performance.timeOrigin + performance.now()) when the main process forwarded it. */
  | { kind: "msg"; header: string; payload: ArrayBuffer | null; tMain: number }
  /** The engine died or stopped answering; the port is closed afterwards. */
  | { kind: "exit"; info: ExitInfo };

declare global {
  interface Window {
    partcraftDesktop?: DesktopBridge;
  }
}
