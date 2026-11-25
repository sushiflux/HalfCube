// Builds the PDFs of the user manual and the developer manual (German and English) from docs/.
//
//   node scripts/docs-pdf/build-docs.mjs [--out-dir <folder>] [--channel <name>]
//
// Without --out-dir every PDF is written next to its Markdown file. Version and date come from version.txt.
// The list of documents is in documents.json.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPdf } from "./build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 1) {
  if ((args[i] === "--out-dir" || args[i] === "--channel") && args[i + 1] !== undefined) {
    options[args[i].slice(2)] = args[i + 1];
    i += 1;
  } else {
    console.error("Aufruf: node scripts/docs-pdf/build-docs.mjs [--out-dir <ordner>] [--channel <kanal>]");
    process.exit(2);
  }
}

try {
  const documents = JSON.parse(readFileSync(join(here, "documents.json"), "utf8")).documents;
  for (const doc of documents) {
    const input = join(repoRoot, doc.source);
    const output = options["out-dir"] ? join(resolve(options["out-dir"]), doc.pdf) : join(dirname(input), doc.pdf);
    mkdirSync(dirname(output), { recursive: true });
    console.log(await buildPdf({ input, output, channel: options.channel }));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
