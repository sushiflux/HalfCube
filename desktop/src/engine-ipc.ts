// Electron side of the engine connection: the IPC handlers the preload bridge talks to, and the MessageChannelMain
// that carries the engine's frames to the page. One EngineHost per window. All logic is in engine-host.ts.
import { ipcMain, MessageChannelMain, type WebContents } from "electron";
import { IPC_ENGINE_PORT, IPC_SETUP_CHOICES, IPC_START_ENGINE, type StartEngineResult } from "../../app/src/engine/bridge.ts";
import type { SetupChoices } from "../../app/src/setup-choices.ts";
import { EngineHost, type EngineLocation, type UiChannel } from "./engine-host.ts";

export interface EngineIpcOptions {
  locate: () => EngineLocation;
  /** True when the frame that sent a request is the main frame of our own page. Everything else is refused. */
  isTrustedFrame: (frame: { url: string; parent: unknown } | null) => boolean;
  /** Validated content of the installer's first-start file, or null. */
  setupChoices: SetupChoices | null;
  log: (line: string) => void;
}

export interface EngineIpc {
  /** Kills every engine at once (program exit). */
  killAll(): void;
}

/** A MessageChannelMain whose far end is handed to the page of `target`. */
function channelTo(target: WebContents): UiChannel {
  const { port1, port2 } = new MessageChannelMain();
  return {
    host: {
      postMessage: (message) => port1.postMessage(message),
      onMessage: (handler) => port1.on("message", (event) => handler(event.data)),
      onClose: (handler) => port1.on("close", handler),
      start: () => port1.start(),
      close: () => port1.close(),
    },
    deliver: (generation) => {
      if (!target.isDestroyed()) target.postMessage(IPC_ENGINE_PORT, generation, [port2]);
    },
  };
}

export function installEngineIpc(opts: EngineIpcOptions): EngineIpc {
  const hosts = new Map<number, EngineHost>();

  ipcMain.handle(IPC_START_ENGINE, async (event): Promise<StartEngineResult> => {
    if (!opts.isTrustedFrame(event.senderFrame)) {
      opts.log(`engine start refused: request from an untrusted frame (${event.senderFrame?.url ?? "unknown"})`);
      return { ok: false, message: "The engine can only be started by the program's own page." };
    }
    const target = event.sender;
    let host = hosts.get(target.id);
    if (!host) {
      host = new EngineHost({ locate: opts.locate, createChannel: () => channelTo(target), log: opts.log });
      hosts.set(target.id, host);
      const owned = host;
      target.once("destroyed", () => {
        owned.kill();
        hosts.delete(target.id);
      });
    }
    return host.start();
  });

  // Synchronous on purpose: the page needs the choices before its first paint (language, light or dark).
  ipcMain.on(IPC_SETUP_CHOICES, (event) => {
    event.returnValue = opts.isTrustedFrame(event.senderFrame) ? opts.setupChoices : null;
  });

  return {
    killAll: () => {
      for (const host of hosts.values()) host.kill();
    },
  };
}
