// What the Electron preload script exposes for the engine, and the messages on the MessagePort between the page and the
// Electron main process. Types and channel names only; shared by the page, the preload script and the main process.
import type { ExitInfo } from "./transport.ts";
import { branding } from "../branding.ts";

/** IPC channel: the page asks the main process to (re)start its engine. */
export const IPC_START_ENGINE = `${branding.slug}:start-engine`;
/** Channel on which the preload script receives the engine's MessagePort from the main process. */
export const IPC_ENGINE_PORT = `${branding.slug}:engine-port`;
/** IPC channel (synchronous, preload only): the validated setup choices of the installer. */
export const IPC_SETUP_CHOICES = `${branding.slug}:setup-choices`;

/** IPC channel: the page asks the main process to open an https address in the system browser. */
export const IPC_OPEN_EXTERNAL = `${branding.slug}:open-external`;
/** IPC channel: the page asks the main process to open the Chromium licence file that ships with Electron. */
export const IPC_OPEN_CHROMIUM_LICENCES = `${branding.slug}:open-chromium-licences`;

export type StartEngineResult =
  | { ok: true; generation: number }
  /** message: complete cause. details: file path, error code and the like, for the copyable report. */
  | { ok: false; message: string; details?: string };

export interface EngineBridge {
  /**
   * Asks the main process to (re)start the native engine of this window. A previous engine of the window is killed,
   * a new one spawned, and its MessagePort is then delivered through
   * window.postMessage({ halfcube: "engine-port", generation }, origin, [port]) by the preload script.
   */
  startEngine(): Promise<StartEngineResult>;
}

/** Message the preload script posts to the page together with the transferred MessagePort. */
export interface EnginePortEnvelope {
  halfcube: "engine-port";
  generation: number;
}

/** Page -> main process, on the engine port. */
export type ToMain =
  | { kind: "msg"; header: string; payload: ArrayBuffer | null }
  /** Stop the engine without an exit report. */
  | { kind: "kill" };

/** Main process -> page, on the engine port. */
export type FromMain =
  | { kind: "msg"; header: string; payload: ArrayBuffer | null }
  /** The engine died or stopped answering; the port is closed afterwards. */
  | { kind: "exit"; info: ExitInfo };
