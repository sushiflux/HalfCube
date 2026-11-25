// Builds what the end-to-end suite runs against, into _build/e2e (never into the dev build folders):
//   web/      the browser build of the UI incl. the WebAssembly engine and its testing variant (crash and hang commands)
//   web/harness/  the engine harness page (tests/e2e/harness), served next to the app
//   desktop/  the Electron main process and preload script; main.cjs reads the UI from ../web over app://
// Run directly (node tests/e2e/support/prepare.ts) or through serve.ts.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { readBuildInfo } from "../../../config/build-info.ts";
import { desktopDir, harnessDir, repoRoot, webDir } from "./paths.ts";

export async function prepare(): Promise<void> {
  // Read when the web config is loaded: the testing engine variant joins the build (never in product builds).
  process.env.PARTCRAFT_WASM_TESTING = "1";
  // The suite tests the dev channel: the demo scenes (?demo=...) only exist there.
  process.env.PARTCRAFT_CHANNEL = "dev";

  await build({ configFile: join(repoRoot, "vite.config.ts"), logLevel: "warn", build: { outDir: webDir, emptyOutDir: true } });
  await build({ configFile: join(repoRoot, "vite.desktop.config.ts"), logLevel: "warn", build: { outDir: desktopDir, emptyOutDir: true } });
  await build({
    configFile: false,
    root: resolve(dirname(fileURLToPath(import.meta.url)), "../harness"),
    base: "./",
    logLevel: "warn",
    publicDir: false,
    worker: { format: "es" },
    define: { __BUILD_INFO__: JSON.stringify(readBuildInfo(repoRoot)) },
    build: { outDir: harnessDir, emptyOutDir: true, target: "es2023", sourcemap: false },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepare();
  console.log("e2e build ready in _build/e2e");
}
