// Paths and constants shared by the Playwright config, the global setup and the fixtures.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Everything the suite builds lives here (inside the ignored _build folder), never in the dev build folders. */
export const e2eBuild = join(repoRoot, "_build", "e2e");
/** The UI bundle; the Electron main process reads it from ../web over app://. */
export const webDir = join(e2eBuild, "web");
export const desktopDir = join(e2eBuild, "desktop");
/** The engine harness page is part of the web build folder, so the program serves it over app:// next to the UI. */
export const harnessDir = join(webDir, "harness");

/** The narrowest window the desktop program allows (minWidth in desktop/src/main.ts). */
export const NARROWEST_WIDTH = 960;
export const LANGUAGES = ["de", "en"] as const;
export type Lang = (typeof LANGUAGES)[number];
