// Creates the engine session of the program: the native engine process behind the preload bridge of the Electron window.
import { branding } from "../branding.ts";
import { getDesktopBridge } from "../platform.ts";
import { currentVersion } from "../version.ts";
import { EngineSession, type EngineSessionOptions } from "./session.ts";
import type { EngineTransport, ExitInfo } from "./transport.ts";
import { DesktopTransport } from "./transports/desktop-transport.ts";

export type CreateEngineSessionOptions = Partial<Omit<EngineSessionOptions, "createTransport">>;

/**
 * Stand-in transport for a page that runs without the Electron preload bridge (a plain browser tab, a broken preload
 * script). There is no other engine to fall back to; starting it fails with the complete cause, so the normal start-up
 * problem screen explains it instead of a blank window.
 */
class MissingBridgeTransport implements EngineTransport {
  readonly kind = "native" as const;
  onMessage: ((header: string, payload: ArrayBuffer | null) => void) | null = null;
  onExit: ((info: ExitInfo) => void) | null = null;

  start(): Promise<void> {
    return Promise.reject(new Error(`The desktop bridge of the Electron window is missing; ${branding.name} runs only as the desktop program.`));
  }

  send(): void {
    throw new Error("The engine connection is closed.");
  }

  kill(): void {}
}

export function createEngineSession(options: CreateEngineSessionOptions = {}): EngineSession {
  const version = `${branding.name} ${currentVersion().display}`;
  const bridge = getDesktopBridge();
  const createTransport = bridge ? () => new DesktopTransport(bridge) : () => new MissingBridgeTransport();
  return new EngineSession({ createTransport, clientName: version, appVersion: version, ...options });
}
