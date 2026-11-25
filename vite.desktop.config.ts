// Vite build of the Electron main process and the preload script. Both are CommonJS: a sandboxed preload cannot be
// an ES module. Output: _build/desktop/main.cjs, preload.cjs and icon.png (the window icon).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
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

export default defineConfig({
  root: repoRoot,
  publicDir: false,
  plugins: [windowIcon()],
  define: { __BUILD_INFO__: JSON.stringify(readBuildInfo()) },
  build: {
    ssr: true,
    outDir: resolve(repoRoot, "_build/desktop"),
    emptyOutDir: true,
    target: "node24",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: {
        main: resolve(repoRoot, "desktop/src/main.ts"),
        preload: resolve(repoRoot, "desktop/src/preload.ts"),
      },
      external: ["electron", /^node:/],
      output: { format: "cjs", entryFileNames: "[name].cjs" },
    },
  },
});
