// Preload script (sandboxed, context-isolated). Exposes the smallest possible bridge: static facts that tell the UI it
// runs in the desktop program. No IPC channel is reachable from the page yet; the engine connection comes later.
import { contextBridge } from "electron";
import type { DesktopBridge } from "../../app/src/platform.ts";

const bridge: DesktopBridge = {
  kind: "electron",
  os: process.platform,
  versions: {
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
  },
};

contextBridge.exposeInMainWorld("desktopBridge", bridge);
