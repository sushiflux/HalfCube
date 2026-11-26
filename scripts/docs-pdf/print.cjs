// Prints the HTML of render.mjs to an A4 PDF with a hidden Electron window (show: false: nothing appears on screen,
// nothing takes the focus). Steps: load the page (no network access at all), wait for fonts and draw the diagrams,
// print once, read the page of every heading from the PDF, write those numbers into the table of contents, print
// again (the layout does not change, the numbers have a fixed column).
// Do not start it directly; use build.mjs. The job comes from the file named in HALFCUBE_JOB_FILE.
"use strict";
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const { createPdfHost } = require("./pdfjs-host.cjs");

const job = JSON.parse(fs.readFileSync(process.env.HALFCUBE_JOB_FILE, "utf8"));
app.disableHardwareAcceleration();
app.setPath("userData", job.userData);

const printOptions = {
  pageSize: "A4",
  printBackground: true,
  preferCSSPageSize: true,
  generateTaggedPDF: true,
  generateDocumentOutline: true,
};

void app.whenReady().then(async () => {
  // The document is self-contained: no network access at all.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    callback({ cancel: /^(https?|wss?|ftp):/i.test(url) });
  });

  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 1400,
    webPreferences: { sandbox: true, backgroundThrottling: false },
  });
  win.webContents.on("console-message", (...args) => {
    const message = args[0] && args[0].message !== undefined ? args[0].message : args[2];
    if (process.env.DOCS_PDF_DEBUG) process.stderr.write(`[page] ${message}\n`);
  });
  await win.loadFile(job.html);
  const diagrams = await win.webContents.executeJavaScript("window.__prepare()");

  let bytes = await win.webContents.printToPDF(printOptions);
  const ids = await win.webContents.executeJavaScript(
    "[...document.querySelectorAll('[data-toc-pg]')].map((e) => e.dataset.tocPg)",
  );
  let numPages = 0;
  let tocNumbers = 0;
  if (ids.length) {
    const host = await createPdfHost();
    numPages = await host.open(bytes);
    let pages = await host.pagesOf(ids);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await win.webContents.executeJavaScript(
        `(() => { const pages = ${JSON.stringify(pages)};
          for (const el of document.querySelectorAll('[data-toc-pg]')) el.textContent = String(pages[el.dataset.tocPg] ?? ''); })()`,
      );
      bytes = await win.webContents.printToPDF(printOptions);
      numPages = await host.open(bytes);
      const check = await host.pagesOf(ids);
      if (JSON.stringify(check) === JSON.stringify(pages)) break;
      pages = check;
    }
    tocNumbers = ids.length;
    host.close();
  } else {
    numPages = bytes.length > 0 ? -1 : 0;
  }
  fs.writeFileSync(job.pdf, bytes);
  process.stdout.write(
    `PDF geschrieben: ${job.pdf} (${numPages > 0 ? numPages + " Seiten, " : ""}${diagrams} Diagramme, ${tocNumbers} Seitenzahlen im Inhaltsverzeichnis)\n`,
  );
  win.destroy();
  app.exit(0);
});
