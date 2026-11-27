// Preload script (sandboxed, context-isolated). Exposes the smallest possible bridge: static facts, one call to
// (re)start the engine, the installer's first-start choices, and two calls that open something outside the window
// (an https address, the Chromium licence file), and the updater calls (app/src/updates/types.ts). Engine messages never pass through this script; they
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
import {
  IPC_UPDATES_CHECK,
  IPC_UPDATES_DOWNLOAD,
  IPC_UPDATES_GET,
  IPC_UPDATES_ON_EXIT,
  IPC_UPDATES_RESTART,
  IPC_UPDATES_STATE,
  type UpdateCheckResult,
  type UpdateError,
  type UpdateState,
  type UpdatesBridge,
} from "../../app/src/updates/types.ts";

// Thin wrapper over the update channels; the main process checks the sender and the arguments again.
const updates: UpdatesBridge = {
  get: () => ipcRenderer.invoke(IPC_UPDATES_GET) as Promise<UpdateState>,
  onState: (listener) => {
    const handler = (_event: unknown, state: UpdateState) => listener(state);
    ipcRenderer.on(IPC_UPDATES_STATE, handler);
    return () => {
      ipcRenderer.removeListener(IPC_UPDATES_STATE, handler);
    };
  },
  check: (manual) => ipcRenderer.invoke(IPC_UPDATES_CHECK, manual === true) as Promise<UpdateCheckResult>,
  download: () => ipcRenderer.invoke(IPC_UPDATES_DOWNLOAD) as Promise<void>,
  restartNow: () => ipcRenderer.invoke(IPC_UPDATES_RESTART) as Promise<{ ok: false; error: UpdateError }>,
  setInstallOnExit: (on) => ipcRenderer.invoke(IPC_UPDATES_ON_EXIT, on === true) as Promise<UpdateState>,
};

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
  updates,
};

contextBridge.exposeInMainWorld("desktopBridge", bridge);

ipcRenderer.on(IPC_ENGINE_PORT, (event, generation: number) => {
  const envelope: EnginePortEnvelope = { halfcube: "engine-port", generation };
  // Same-window hand-over from the isolated world to the page; the port is transferred, not copied.
  window.postMessage(envelope, window.location.origin, event.ports);
});
