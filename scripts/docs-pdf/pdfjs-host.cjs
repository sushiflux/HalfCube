// Reads PDFs with pdf.js inside a hidden Electron window (nothing is shown, nothing takes the focus).
// Used by print.cjs (page of every heading, for the page numbers in the table of contents) and by pdf-to-png.cjs
// (render pages to PNG). Load it before the app is ready: it registers a custom scheme.
"use strict";
const { app, BrowserWindow, protocol } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const pdfjsDir = path.join(__dirname, "node_modules", "pdfjs-dist", "build");

protocol.registerSchemesAsPrivileged([
  { scheme: "pdfview", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const pageHtml = `<!doctype html><meta charset="utf-8"><body><script type="module">
import * as pdfjs from "pdfview://x/pdf.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "pdfview://x/pdf.worker.mjs";
let doc = null;
let task = null;
window.pdfOpen = async (version) => {
  if (task) await task.destroy();
  task = pdfjs.getDocument({ url: "pdfview://x/doc.pdf?v=" + version });
  doc = await task.promise;
  return doc.numPages;
};
// Page number (1-based) of every named destination; null when a name is unknown.
window.pdfPagesOf = async (ids) => {
  const result = {};
  for (const id of ids) {
    const dest = await doc.getDestination(id);
    result[id] = dest ? (await doc.getPageIndex(dest[0])) + 1 : null;
  }
  return result;
};
window.pdfRender = async (spec, scale) => {
  const wanted = [];
  for (const part of String(spec).split(",")) {
    const m = /^(\\d+)(?:-(\\d+))?$/.exec(part.trim());
    if (part.trim() === "all") for (let i = 1; i <= doc.numPages; i++) wanted.push(i);
    else if (m) for (let i = Number(m[1]); i <= Number(m[2] ?? m[1]); i++) if (i <= doc.numPages) wanted.push(i);
  }
  const out = [];
  for (const n of wanted) {
    const p = await doc.getPage(n);
    const viewport = p.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await p.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    out.push({ n, data: canvas.toDataURL("image/png").split(",")[1] });
  }
  return out;
};
</script>`;

let currentPdf = Buffer.alloc(0);
let version = 0;
let handlerInstalled = false;

/** Opens the hidden pdf.js window. Call after app.whenReady(). */
async function createPdfHost() {
  if (!handlerInstalled) {
    handlerInstalled = true;
    protocol.handle("pdfview", (request) => {
      const name = new URL(request.url).pathname;
      if (name === "/index.html") {
        return new Response(pageHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (name === "/doc.pdf") return new Response(currentPdf, { headers: { "content-type": "application/pdf" } });
      if (name === "/pdf.mjs" || name === "/pdf.worker.mjs") {
        return new Response(fs.readFileSync(path.join(pdfjsDir, name.slice(1))), {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      }
      return new Response("not found", { status: 404 });
    });
  }
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
  await win.loadURL("pdfview://x/index.html");
  const run = (code) => win.webContents.executeJavaScript(code);
  return {
    /** Loads PDF bytes; resolves with the number of pages. */
    async open(bytes) {
      currentPdf = Buffer.from(bytes);
      version += 1;
      return run(`window.pdfOpen(${version})`);
    },
    pagesOf: (ids) => run(`window.pdfPagesOf(${JSON.stringify(ids)})`),
    render: (spec, scale) => run(`window.pdfRender(${JSON.stringify(spec)}, ${Number(scale)})`),
    close() {
      win.destroy();
    },
  };
}

module.exports = { createPdfHost, app };
