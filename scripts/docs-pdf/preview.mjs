// Renders pages of a PDF to PNG files (hidden Electron window) so a document can be checked by looking at it.
//   node scripts/docs-pdf/preview.mjs <file.pdf> <outDir> [pages] [scale]
// pages: "1,2,5-7" or "all" (default "1-3"); scale: 1.5 (default). Files: <outDir>/seite-001.png ...
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runElectronJob } from "./run-electron.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [pdf, outDir, pages = "1-3", scale = "1.5"] = process.argv.slice(2);
if (!pdf || !outDir) {
  console.error("Aufruf: node scripts/docs-pdf/preview.mjs <datei.pdf> <zielordner> [seiten] [maßstab]");
  process.exit(2);
}
try {
  process.stdout.write(
    await runElectronJob(join(here, "pdf-to-png.cjs"), {
      pdf: resolve(pdf),
      outDir: resolve(outDir),
      pages,
      scale: Number(scale),
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
