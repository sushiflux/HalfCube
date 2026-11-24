// Vite build of the Electron main process and the preload script (CommonJS; a sandboxed preload cannot be ESM).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const spikeDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: spikeDir,
  publicDir: false,
  build: {
    ssr: true,
    outDir: resolve(spikeDir, "_build/app-desktop"),
    emptyOutDir: true,
    target: "node24",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: {
        main: resolve(spikeDir, "desktop/main.ts"),
        preload: resolve(spikeDir, "desktop/preload.ts"),
      },
      external: ["electron", /^node:/],
      output: { format: "cjs", entryFileNames: "[name].cjs" },
    },
  },
});
