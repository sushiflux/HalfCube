// Scales the project's logo (square PNG with transparency) to the icon sizes the spike uses. The logo itself is only
// resampled, never redrawn, cropped or recoloured. Usage: node scripts/make-icons.mjs <logo.png> [browser-exe]
// A headless Chromium does the resampling (progressive halving, then the last step), so no image library is needed.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const source = process.argv[2];
const exe = process.argv[3] ?? process.env.HC_BROWSER_EXE;
if (!source || !exe) {
  console.error("Usage: node scripts/make-icons.mjs <logo.png> <browser-exe>   (or set HC_BROWSER_EXE)");
  process.exit(2);
}
const sizes = [512, 64];
const browser = await chromium.launch({ executablePath: exe, headless: true });
try {
  const page = await browser.newPage();
  const b64 = readFileSync(source).toString("base64");
  const out = await page.evaluate(
    async ([data, wanted]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const result = {};
      for (const size of wanted) {
        let cur = img, w = img.naturalWidth;
        while (w / 2 > size) {
          w = Math.round(w / 2);
          const c = document.createElement("canvas");
          c.width = c.height = w;
          const g = c.getContext("2d");
          g.imageSmoothingQuality = "high";
          g.drawImage(cur, 0, 0, w, w);
          cur = c;
        }
        const c = document.createElement("canvas");
        c.width = c.height = size;
        const g = c.getContext("2d");
        g.imageSmoothingQuality = "high";
        g.drawImage(cur, 0, 0, size, size);
        result[size] = c.toDataURL("image/png").split(",")[1];
      }
      return result;
    },
    [b64, sizes],
  );
  for (const size of sizes) {
    const file = join(here, "..", "assets", `halfcube-icon-${size}.png`);
    writeFileSync(file, Buffer.from(out[size], "base64"));
    console.log(`wrote ${file}`);
  }
} finally {
  await browser.close();
}
