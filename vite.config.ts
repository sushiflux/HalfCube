// Vite config of the shared UI (app/). The same build runs as the browser version and inside the Electron window.
// Dev server and preview server bind 127.0.0.1 only and send the cross-origin isolation headers.
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { readBuildInfo, readDevPorts, repoRoot } from "./config/build-info.ts";
import { isolationHeaders, responseHeaders } from "./config/security.ts";
import brandingFile from "./branding/branding.json" with { type: "json" };

const ports = readDevPorts();

/** Replaces %PRODUCT_NAME% in index.html, so the product name stays in branding/branding.json only. */
function brandingHtml(): Plugin {
  return {
    name: "branding-html",
    transformIndexHtml: (html) => html.replaceAll("%PRODUCT_NAME%", brandingFile.name),
  };
}

export default defineConfig({
  root: resolve(repoRoot, "app"),
  base: "./",
  publicDir: false,
  plugins: [react(), tailwindcss(), brandingHtml()],
  define: { __BUILD_INFO__: JSON.stringify(readBuildInfo()) },
  build: {
    outDir: resolve(repoRoot, "_build/web"),
    emptyOutDir: true,
    target: "es2023",
    sourcemap: false,
    reportCompressedSize: true,
  },
  server: {
    host: "127.0.0.1",
    port: ports["web-dev"],
    strictPort: true,
    headers: { ...isolationHeaders },
    fs: { allow: [repoRoot] },
  },
  preview: {
    host: "127.0.0.1",
    port: ports["web-preview"],
    strictPort: true,
    headers: { ...responseHeaders },
  },
});
