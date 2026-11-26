// Renders pages of a PDF to PNG files for a visual check. Runs inside Electron with a hidden window (nothing is
// shown, nothing takes the focus) and uses pdf.js from this folder's node_modules.
// Do not start it directly; use: node scripts/docs-pdf/preview.mjs <file.pdf> <outDir> [pages] [scale]
"use strict";
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createPdfHost } = require("./pdfjs-host.cjs");

const job = JSON.parse(fs.readFileSync(process.env.HALFCUBE_JOB_FILE, "utf8"));
app.disableHardwareAcceleration();
app.setPath("userData", job.userData);

void app.whenReady().then(async () => {
  const host = await createPdfHost();
  const numPages = await host.open(fs.readFileSync(job.pdf));
  const pages = await host.render(job.pages, job.scale);
  fs.mkdirSync(job.outDir, { recursive: true });
  for (const p of pages) {
    const file = path.join(job.outDir, `seite-${String(p.n).padStart(3, "0")}.png`);
    fs.writeFileSync(file, Buffer.from(p.data, "base64"));
  }
  process.stdout.write(`${pages.length} Seite(n) von ${numPages} nach ${job.outDir}\n`);
  host.close();
  app.exit(0);
});
