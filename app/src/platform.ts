// Where the UI runs: inside the Electron window (the preload script exposes the bridge) or as a page in a browser.
import type { EngineBridge } from "./engine/bridge.ts";
import type { SetupChoices } from "./setup-choices.ts";

/** The smallest possible bridge the preload script exposes to the page. */
export interface DesktopBridge extends EngineBridge {
  kind: "electron";
  /** Operating system of the desktop program (process.platform). */
  os: string;
  versions: { electron: string; chrome: string; node: string };
  /**
   * What the installer chose for the first start (language, light or dark), already validated by the main process;
   * null when there is no such file or it is not exactly in the expected shape. Read only.
   */
  setupChoices: SetupChoices | null;
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
  }
}

export type Platform = "desktop" | "browser";

export function getDesktopBridge(): DesktopBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = window.desktopBridge;
  return bridge?.kind === "electron" ? bridge : undefined;
}

export function detectPlatform(): Platform {
  return getDesktopBridge() ? "desktop" : "browser";
}
