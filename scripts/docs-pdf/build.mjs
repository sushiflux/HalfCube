// Turns a Markdown file with front matter into a designed A4 PDF (cover, contents with page numbers, chapters on new
// pages, running header and footer, tables, code, callouts, diagrams). The PDF is made by a hidden Electron window:
// no window is shown and nothing takes the focus.
//
//   node scripts/docs-pdf/build.mjs <input.md> <output.pdf> [options]
//
//   --version-file <path>   file whose second line is the five-segment version (default: version.txt of the repository)
//   --channel <name>        dev | nightly | beta | release: adds the channel symbol to the version, like the program
//                           does ("v2026.11.5.13.12369 (</>)"); also read from PARTCRAFT_CHANNEL. Default: none.
//   --html <path>           also keep the generated HTML (for looking at the layout)
//
// "version" and "date" of the front matter are optional. When they are missing, the version is the second line of
// version.txt and the date is the commit date of that file (its modification date when git is not available).
// Run "npm ci" in scripts/docs-pdf once (Markdown and diagram libraries); the Electron runtime comes from the
// repository's own node_modules (or PARTCRAFT_ELECTRON_EXE).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHtml } from "./render.mjs";
import { runElectronJob } from "./run-electron.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const channelSymbols = { dev: "</>", nightly: "α", beta: "β", release: "" };
const versionPattern = /^v(0|[1-9]\d*)(\.(0|[1-9]\d*)){4}$/;

/** Version and date from version.txt: second line = five-segment id; date = commit date of the file. */
export function readVersionInfo(versionFile, channel) {
  const lines = readFileSync(versionFile, "utf8").split(/\r?\n/);
  const id = (lines[1] ?? "").trim();
  if (!versionPattern.test(id)) {
    throw new Error(`${versionFile}: die zweite Zeile muss eine Version mit fünf Zahlen sein (v2026.11.5.13.12369), gefunden: "${id}".`);
  }
  let date = "";
  try {
    date = execFileSync("git", ["log", "-1", "--format=%cs", "--", versionFile], {
      cwd: dirname(versionFile),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    date = "";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = statSync(versionFile).mtime.toISOString().slice(0, 10);
  const name = (channel ?? "").trim().toLowerCase();
  if (name !== "" && !(name in channelSymbols)) {
    throw new Error(`Unbekannter Kanal "${channel}": erlaubt sind ${Object.keys(channelSymbols).join(", ")}.`);
  }
  const symbol = name === "" ? "" : channelSymbols[name];
  return { version: symbol ? `${id} (${symbol})` : id, date };
}

/** Builds one PDF. Exported for build-docs.mjs. */
export async function buildPdf({ input, output, versionFile, channel, htmlOut }) {
  const theme = JSON.parse(readFileSync(join(here, "theme.json"), "utf8"));
  const branding = JSON.parse(readFileSync(resolve(here, theme.brandingFile), "utf8"));
  const logoFile = resolve(here, theme.logoFile);
  if (!existsSync(logoFile)) throw new Error(`Das Logo fehlt: ${logoFile}`);
  const mermaidScript = join(here, "node_modules", "mermaid", "dist", "mermaid.min.js");

  const markdown = readFileSync(input, "utf8");
  const needsMermaid = /^```mermaid\b/m.test(markdown);
  if (needsMermaid && !existsSync(mermaidScript)) {
    throw new Error('Mermaid fehlt. Einmal "npm ci" im Ordner scripts/docs-pdf ausführen.');
  }
  if (!existsSync(join(here, "node_modules", "marked"))) {
    throw new Error('Die Markdown-Bibliothek fehlt. Einmal "npm ci" im Ordner scripts/docs-pdf ausführen.');
  }

  const defaults = readVersionInfo(versionFile ?? join(repoRoot, "version.txt"), channel ?? process.env.PARTCRAFT_CHANNEL);
  const html = buildHtml({
    markdown,
    sourceDir: dirname(resolve(input)),
    defaults,
    theme,
    themeDir: here,
    brandName: branding.name,
    logoFile,
    mermaidScript: needsMermaid ? mermaidScript : null,
  });

  const work = mkdtempSync(join(tmpdir(), "partcraft-docs-html-"));
  try {
    const htmlFile = join(work, "document.html");
    writeFileSync(htmlFile, html);
    if (htmlOut) copyFileSync(htmlFile, resolve(htmlOut));
    const out = resolve(output);
    const message = await runElectronJob(join(here, "print.cjs"), { html: htmlFile, pdf: out });
    return message.trim();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version-file" || arg === "--channel" || arg === "--html") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} braucht einen Wert.`);
      options[arg.slice(2)] = value;
      i += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unbekannte Option ${arg}.`);
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { positional, options } = parseArguments(process.argv.slice(2));
    if (positional.length !== 2) {
      console.error("Aufruf: node scripts/docs-pdf/build.mjs <eingabe.md> <ausgabe.pdf> [--version-file <pfad>] [--channel <kanal>] [--html <pfad>]");
      process.exit(2);
    }
    console.log(
      await buildPdf({
        input: positional[0],
        output: positional[1],
        versionFile: options["version-file"] ? resolve(options["version-file"]) : undefined,
        channel: options.channel,
        htmlOut: options.html,
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
