// Where the UI runs: inside the Electron window (the preload script exposes the bridge) or as a page in a browser.

/** The smallest possible bridge the preload script exposes to the page. */
export interface DesktopBridge {
  kind: "electron";
  /** Operating system of the desktop program (process.platform). */
  os: string;
  versions: { electron: string; chrome: string; node: string };
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
