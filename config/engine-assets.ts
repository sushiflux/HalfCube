// Vite plugin that makes the WebAssembly engine part of the web build and of the dev server.
//   build: copies engine/_build/wasm/{partcraft-engine.mjs, partcraft-engine.wasm, licenses/} to <outDir>/engine/
//   dev:   serves the same files under /engine/ (the browser engine worker loads them from there)
// With PARTCRAFT_WASM_TESTING=1 the testing variant (diagnostics.crash and diagnostics.hang) from
// engine/_build/wasm-testing/ is added as engine-testing/; product builds never contain it.
// PARTCRAFT_WASM_DIR / PARTCRAFT_WASM_TESTING_DIR point at other folders. A missing engine is a warning, because the
// desktop build does not need it; with PARTCRAFT_REQUIRE_ENGINE=1 (release builds) it fails the build.
import { copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Plugin } from "vite";
import { isolationHeaders } from "./security.ts";
import { WASM_BINARY_FILE, WASM_MODULE_FILE } from "../app/src/engine/generated/protocol.ts";

export interface EngineVariant {
  /** Folder name inside the web build and under the dev server's root. */
  folder: "engine" | "engine-testing";
  /** Where the WebAssembly build lives. */
  source: string;
}

export function engineVariants(repoRoot: string, env: NodeJS.ProcessEnv = process.env): EngineVariant[] {
  const variants: EngineVariant[] = [
    { folder: "engine", source: resolve(env.PARTCRAFT_WASM_DIR ?? join(repoRoot, "engine", "_build", "wasm")) },
  ];
  if (env.PARTCRAFT_WASM_TESTING === "1") {
    variants.push({
      folder: "engine-testing",
      source: resolve(env.PARTCRAFT_WASM_TESTING_DIR ?? join(repoRoot, "engine", "_build", "wasm-testing")),
    });
  }
  return variants;
}

const SERVED_FILES: Record<string, string> = {
  [WASM_MODULE_FILE]: "text/javascript; charset=utf-8",
  [WASM_BINARY_FILE]: "application/wasm",
};

export function engineAssets(repoRoot: string): Plugin {
  const variants = engineVariants(repoRoot);
  const required = process.env.PARTCRAFT_REQUIRE_ENGINE === "1";
  return {
    name: "partcraft-engine-assets",

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = /^\/(engine|engine-testing)\/([^/?#]+)(?:[?#].*)?$/.exec(req.url ?? "");
        const type = match?.[2] ? SERVED_FILES[match[2]] : undefined;
        const variant = variants.find((v) => v.folder === match?.[1]);
        if (!match?.[2] || !type || !variant) return next();
        const file = join(variant.source, match[2]);
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end(`The WebAssembly engine file ${file} does not exist. Build it with engine/scripts/build-wasm.ps1.`);
          return;
        }
        res.setHeader("Content-Type", type);
        res.setHeader("Content-Length", statSync(file).size);
        res.setHeader("Cache-Control", "no-store");
        for (const [name, value] of Object.entries(isolationHeaders)) res.setHeader(name, value);
        // Streams the (11 MB) file instead of reading it into memory.
        createReadStream(file).on("error", next).pipe(res);
      });
    },

    writeBundle(options) {
      const outDir = options.dir;
      if (!outDir) return;
      for (const variant of variants) {
        const files = [WASM_MODULE_FILE, WASM_BINARY_FILE].map((f) => join(variant.source, f));
        const missing = files.filter((f) => !existsSync(f));
        if (missing.length > 0) {
          const message = `The WebAssembly engine is missing (${missing.join(", ")}); the browser version will not start. Build it with engine/scripts/build-wasm.ps1.`;
          if (required) this.error(message);
          this.warn(message);
          continue;
        }
        const target = join(outDir, variant.folder);
        mkdirSync(target, { recursive: true });
        for (const f of files) copyFileSync(f, join(target, basename(f)));
        // Licence texts of the compiled-in runtime libraries travel with the binary.
        const licenses = join(variant.source, "licenses");
        if (existsSync(licenses)) cpSync(licenses, join(target, "licenses"), { recursive: true });
      }
    },
  };
}
