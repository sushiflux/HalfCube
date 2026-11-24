// Preload script (sandboxed, context-isolated). Exposes the smallest possible bridge: one call to (re)start the
// engine. Engine messages never pass through this script; they travel on a MessagePort that is handed straight
// to the page, so no generic IPC channel is reachable from the page.
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, EnginePortEnvelope, StartEngineResult } from "../app/src/desktop-bridge.ts";

const bridge: DesktopBridge = {
  kind: "electron",
  versions: {
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
  },
  startEngine: () => ipcRenderer.invoke("partcraft:start-engine") as Promise<StartEngineResult>,
};

contextBridge.exposeInMainWorld("partcraftDesktop", bridge);

ipcRenderer.on("partcraft:engine-port", (event, generation: number) => {
  const envelope: EnginePortEnvelope = { partcraft: "engine-port", generation };
  // Same-window hand-over from the isolated world to the page; the port is transferred, not copied.
  window.postMessage(envelope, window.location.origin, event.ports);
});
