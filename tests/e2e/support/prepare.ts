// Builds what the end-to-end suite runs against, into _build/e2e (never into the dev build folders):
//   web/          the UI bundle of the Electron window
//   web/harness/  the engine harness page (tests/e2e/harness), served next to the app over app://
//   desktop/      the Electron main process and preload script; main.cjs reads the UI from ../web over app://
// Run by Playwright's globalSetup (tests/e2e/support/global-setup.ts) or directly (node tests/e2e/support/prepare.ts).
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { readBuildInfo } from "../../../config/build-info.ts";
import { desktopDir, harnessDir, repoRoot, webDir } from "./paths.ts";

export async function prepare(): Promise<void> {
  // The suite tests the dev channel: the demo scenes (?demo=...) only exist there. The variable is read while the Vite
  // configs load; it is put back afterwards so the Playwright workers (and the programs they launch) do not inherit it.
  const channel = process.env.HALFCUBE_CHANNEL;
  process.env.HALFCUBE_CHANNEL = "dev";
  try {
    await build({ configFile: join(repoRoot, "vite.config.ts"), logLevel: "warn", build: { outDir: webDir, emptyOutDir: true } });
    await build({ configFile: join(repoRoot, "vite.desktop.config.ts"), logLevel: "warn", build: { outDir: desktopDir, emptyOutDir: true } });
    await build({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../harness"),
      base: "./",
      logLevel: "warn",
      publicDir: false,
      define: { __BUILD_INFO__: JSON.stringify(readBuildInfo(repoRoot)) },
      build: { outDir: harnessDir, emptyOutDir: true, target: "es2023", sourcemap: false },
    });
  } finally {
    if (channel === undefined) delete process.env.HALFCUBE_CHANNEL;
    else process.env.HALFCUBE_CHANNEL = channel;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepare();
  console.log("e2e build ready in _build/e2e");
}
