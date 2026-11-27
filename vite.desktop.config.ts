// Vite build of the Electron main process and the preload script. Both are CommonJS: a sandboxed preload cannot be
// an ES module. Output: _build/desktop/main.cjs, preload.cjs and icon.png (the window icon).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build, defineConfig, type Plugin } from "vite";
import { readBuildInfo, repoRoot } from "./config/build-info.ts";

/** Copies the window icon next to main.cjs so the build folder is self-contained. */
function windowIcon(): Plugin {
  return {
    name: "window-icon",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "icon.png",
        source: readFileSync(resolve(repoRoot, "branding/icons/icon-512.png")),
      });
    },
  };
}

const buildInfo = readBuildInfo();
// velopack is a native package: in the installed program it lives in the packaged app's node_modules and is required at
// run time (desktop/src/updates/velopack-adapter.ts), never bundled.
const external = ["electron", /^node:/, "velopack"];

/**
 * Builds the preload script as a build of its own. A sandboxed preload can only require electron and a few built-in
 * modules, never a file next to it; with main and preload in one build, any module they both import would become a
 * shared chunk and the preload would fail to load. A separate build keeps preload.cjs a single self-contained file.
 */
function preloadBundle(): Plugin {
  let outDir = resolve(repoRoot, "_build/desktop");
  return {
    name: "preload-bundle",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      await build({
        configFile: false,
        root: repoRoot,
        publicDir: false,
        logLevel: "warn",
        define: { __BUILD_INFO__: JSON.stringify(buildInfo) },
        build: {
          ssr: true,
          outDir,
          emptyOutDir: false,
          target: "node24",
          minify: false,
          sourcemap: false,
          rollupOptions: {
            input: { preload: resolve(repoRoot, "desktop/src/preload.ts") },
            external,
            output: { format: "cjs", entryFileNames: "[name].cjs" },
          },
        },
      });
    },
  };
}

export default defineConfig({
  root: repoRoot,
  publicDir: false,
  plugins: [windowIcon(), preloadBundle()],
  define: { __BUILD_INFO__: JSON.stringify(buildInfo) },
  build: {
    ssr: true,
    outDir: resolve(repoRoot, "_build/desktop"),
    emptyOutDir: true,
    target: "node24",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: { main: resolve(repoRoot, "desktop/src/main.ts") },
      external,
      output: { format: "cjs", entryFileNames: "[name].cjs" },
    },
  },
});
