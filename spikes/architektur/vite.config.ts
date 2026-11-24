// Vite build of the shared UI (app/). The same output runs as the browser page and inside the Electron window.
// The browser page talks to the WebAssembly engine in a Web Worker; its files are served under /engine/.
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const spikeDir = dirname(fileURLToPath(import.meta.url));
const wasmDir = resolve(spikeDir, process.env.PC_ENGINE_WASM_DIR ?? "_build/engine-wasm");

// Dev ports come from the project's fixed block (spike web dev server and preview server).
const DEV_PORT = 5310;
const PREVIEW_PORT = 5311;

// Cross-origin isolation gives the page SharedArrayBuffer, which the worker transport needs to cancel a running
// WebAssembly rebuild.
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/** Files served under /engine/ in dev and copied to <outDir>/engine/ in the build. */
const engineFileMap: Record<string, string> = {
  "partcraft-engine.mjs": join(wasmDir, "partcraft-engine.mjs"),
  "partcraft-engine.wasm": join(wasmDir, "partcraft-engine.wasm"),
  "engine-worker.mjs": join(spikeDir, "client/engine-worker.mjs"),
};

const mime: Record<string, string> = { ".mjs": "text/javascript", ".wasm": "application/wasm" };

function engineFiles(): Plugin {
  return {
    name: "partcraft-engine-files",
    configureServer(server) {
      server.middlewares.use("/engine/", (req, res, next) => {
        const name = (req.url ?? "").split("?")[0]!.replace(/^\//, "");
        const file = engineFileMap[name];
        if (!file) return next();
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.end(`Engine file missing: ${name}. Build the WebAssembly engine first (engine/scripts/build-wasm.ps1).`);
          return;
        }
        res.setHeader("Content-Type", mime[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream");
        res.setHeader("Content-Length", statSync(file).size);
        res.setHeader("Cache-Control", "no-store");
        for (const [k, v] of Object.entries(isolationHeaders)) res.setHeader(k, v);
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const [name, file] of Object.entries(engineFileMap)) {
        if (!existsSync(file)) {
          this.warn(`Engine file missing, the browser page will show an error: ${file}`);
          continue;
        }
        this.emitFile({ type: "asset", fileName: `engine/${name}`, source: readFileSync(file) });
      }
    },
  };
}

export default defineConfig({
  root: resolve(spikeDir, "app"),
  base: "./",
  // The project logo in assets/ is copied into the build (favicon of the page).
  publicDir: resolve(spikeDir, "assets"),
  plugins: [react(), engineFiles()],
  build: {
    outDir: resolve(spikeDir, "_build/app-web"),
    emptyOutDir: true,
    target: "es2023",
    sourcemap: false,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 2048,
  },
  server: {
    host: "127.0.0.1",
    port: DEV_PORT,
    strictPort: true,
    headers: isolationHeaders,
    fs: { allow: [spikeDir] },
  },
  preview: {
    host: "127.0.0.1",
    port: PREVIEW_PORT,
    strictPort: true,
    headers: isolationHeaders,
  },
});
