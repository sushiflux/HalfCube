// Paths, ports and modes shared by the Playwright config, the server script and the fixtures.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDevPorts } from "../../../config/build-info.ts";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Everything the suite builds lives here (inside the ignored _build folder), never in the dev build folders. */
export const e2eBuild = join(repoRoot, "_build", "e2e");
export const webDir = join(e2eBuild, "web");
export const desktopDir = join(e2eBuild, "desktop");
/** The engine harness page is part of the web build folder, so it is served by the web server and by app://. */
export const harnessDir = join(webDir, "harness");

/** Port 5315 is reserved for the end-to-end server in config/dev-ports.json. */
export const serverPort = readDevPorts(repoRoot)["e2e-cdp"];

/**
 * Where the web server listens. 127.0.0.1 by default; Docker Desktop on Windows reaches it through host.docker.internal.
 * PARTCRAFT_E2E_HOST overrides it only for hosts where that does not work (another address can trigger a firewall prompt).
 */
export const serverHost = process.env.PARTCRAFT_E2E_HOST ?? "127.0.0.1";

/** docker: the browser runs in the official Playwright image (default). local: an installed Chromium browser (fallback). */
export type BrowserMode = "docker" | "local";

export function browserMode(env: NodeJS.ProcessEnv = process.env): BrowserMode {
  const raw = env.PARTCRAFT_E2E_BROWSER ?? "docker";
  if (raw !== "docker" && raw !== "local") {
    throw new Error(`PARTCRAFT_E2E_BROWSER must be "docker" or "local", got "${raw}".`);
  }
  return raw;
}

/** What a spec runs against: the web build in a browser, or the real Electron program. */
export type Target = "browser" | "electron";

/** The narrowest window the desktop program allows (minWidth in desktop/src/main.ts). */
export const NARROWEST_WIDTH = 960;
export const LANGUAGES = ["de", "en"] as const;
export type Lang = (typeof LANGUAGES)[number];
