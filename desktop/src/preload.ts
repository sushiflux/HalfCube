// Preload script (sandboxed, context-isolated). Exposes the smallest possible bridge: static facts, one call to
// (re)start the engine, the installer's first-start choices, and two calls that open something outside the window
// (an https address, the Chromium licence file). Engine messages never pass through this script; they
// travel on a MessagePort that is handed straight to the page, so no generic IPC channel is reachable from the page.
import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_ENGINE_PORT,
  IPC_OPEN_CHROMIUM_LICENCES,
  IPC_OPEN_EXTERNAL,
  IPC_SETUP_CHOICES,
  IPC_START_ENGINE,
  type EnginePortEnvelope,
  type StartEngineResult,
} from "../../app/src/engine/bridge.ts";
import type { DesktopBridge, OpenResult } from "../../app/src/platform.ts";
import type { SetupChoices } from "../../app/src/setup-choices.ts";

const bridge: DesktopBridge = {
  kind: "electron",
  os: process.platform,
  versions: {
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
  },
  startEngine: () => ipcRenderer.invoke(IPC_START_ENGINE) as Promise<StartEngineResult>,
  // Already validated by the main process (null when absent or malformed).
  setupChoices: ipcRenderer.sendSync(IPC_SETUP_CHOICES) as SetupChoices | null,
  openExternal: (url) => ipcRenderer.invoke(IPC_OPEN_EXTERNAL, url) as Promise<OpenResult>,
  openChromiumLicences: () => ipcRenderer.invoke(IPC_OPEN_CHROMIUM_LICENCES) as Promise<OpenResult>,
};

contextBridge.exposeInMainWorld("desktopBridge", bridge);

ipcRenderer.on(IPC_ENGINE_PORT, (event, generation: number) => {
  const envelope: EnginePortEnvelope = { halfcube: "engine-port", generation };
  // Same-window hand-over from the isolated world to the page; the port is transferred, not copied.
  window.postMessage(envelope, window.location.origin, event.ports);
});
