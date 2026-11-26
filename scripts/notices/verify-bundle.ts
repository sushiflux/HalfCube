// Proves the UI part of the third-party list against a real production build of the app.
//
//   node scripts/notices/verify-bundle.ts
//
// It runs `vite build` (the same vite.config.ts as `npm run build:web`) into a temporary folder, collects every module
// that ends up in a chunk (main bundle and the engine worker), and checks that
//   - every npm package behind those modules belongs to an entry of third_party/notices.sources.json (group ui),
//   - no package listed as "notBundled" is in the bundle,
//   - every text file named by the generated list exists in the build output (licenses/<id>.txt),
//   - the Electron main process and preload script import nothing from npm except electron (they bundle no package).
// Exit code 0: complete; 1: something is missing. It needs no engine files, only npm packages.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";
import { THIRD_PARTY } from "../../app/src/about/third-party.generated.ts";
import { readSources } from "./notices.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sources = readSources(root);
const problems: string[] = [];

const moduleIds = new Set<string>();
const collector: Plugin = {
  name: "collect-bundled-modules",
  generateBundle(_options, bundle) {
    for (const file of Object.values(bundle)) {
      if (file.type === "chunk") for (const id of file.moduleIds) moduleIds.add(id);
    }
  },
};

const outDir = mkdtempSync(join(tmpdir(), "halfcube-notices-"));
try {
  await build({
    configFile: join(root, "vite.config.ts"),
    logLevel: "error",
    plugins: [collector],
    worker: { plugins: () => [collector] },
    build: { outDir, emptyOutDir: true },
  });

  const bundled = new Map<string, number>();
  const helpers: string[] = [];
  for (const raw of moduleIds) {
    const id = raw.replaceAll("\\", "/");
    const match = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(id);
    if (match?.[1]) bundled.set(match[1], (bundled.get(match[1]) ?? 0) + 1);
    // Virtual modules of the bundler itself, e.g. "\0vite/preload-helper.js" and "\0rolldown/runtime.js".
    else if (id.startsWith("\0")) helpers.push(id.slice(1));
  }
  for (const helper of helpers) {
    const owner = helper.split("/")[0] ?? "";
    if (!sources.entries.some((e) => e.group === "ui" && e.from.kind === "npm" && e.from.packages.includes(owner))) {
      problems.push(`The bundle contains helper code "${helper}" of ${owner}, which has no ui entry in third_party/notices.sources.json.`);
    }
  }

  const listed = new Set<string>();
  for (const entry of sources.entries) if (entry.group === "ui" && entry.from.kind === "npm") for (const p of entry.from.packages) listed.add(p);
  for (const [name, count] of [...bundled].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!listed.has(name)) problems.push(`Package ${name} (${count} modules) is in the production bundle but has no ui entry in third_party/notices.sources.json.`);
  }
  for (const name of Object.keys(sources.npm.notBundled)) {
    if (bundled.has(name)) problems.push(`Package ${name} is listed as notBundled but its code is in the production bundle.`);
  }
  const css = readdirSync(join(outDir, "assets"))
    .filter((f) => f.endsWith(".css"))
    .map((f) => readFileSync(join(outDir, "assets", f), "utf8"))
    .join("\n");
  const cssPackages = new Map<string, string>();
  for (const entry of sources.entries) {
    if (entry.group === "ui" && entry.from.kind === "npm" && entry.from.cssProof) cssPackages.set(entry.from.main, entry.from.cssProof);
  }
  for (const [name, proof] of cssPackages) {
    if (!css.includes(proof)) problems.push(`Package ${name} is expected in the built stylesheet (${proof}) but is not.`);
  }
  for (const name of listed) {
    if (!bundled.has(name) && !cssPackages.has(name) && !helpers.some((h) => h.startsWith(`${name}/`))) {
      problems.push(`Package ${name} has a ui entry but none of its code is in the production bundle; remove it or fix the entry.`);
    }
  }

  const missing = THIRD_PARTY.filter((e) => e.textFile !== null && !existsSync(join(outDir, e.textFile)));
  for (const entry of missing) problems.push(`${entry.textFile} of ${entry.id} is not in the build output.`);
  for (const own of ["halfcube-license", "halfcube-notice"]) {
    if (!existsSync(join(outDir, "licenses", `${own}.txt`))) problems.push(`licenses/${own}.txt is not in the build output.`);
  }

  // The Electron main process and the preload script are built with every npm package external.
  const desktopRoot = join(root, "desktop", "src");
  for (const name of readdirSync(desktopRoot).filter((f) => f.endsWith(".ts"))) {
    for (const match of readFileSync(join(desktopRoot, name), "utf8").matchAll(/^\s*(?:import|export)\b[^"'\n]*?from\s+["']([^"']+)["']/gm)) {
      const specifier = match[1] ?? "";
      if (!specifier.startsWith(".") && !specifier.startsWith("node:") && specifier !== "electron") {
        problems.push(`desktop/src/${name} imports "${specifier}"; the notices expect Electron's main process to use no npm package besides electron.`);
      }
    }
  }

  console.log(`Production bundle: ${moduleIds.size} modules from ${bundled.size} npm packages (${[...bundled.keys()].sort((a, b) => a.localeCompare(b)).join(", ")}) and bundler helpers (${helpers.join(", ")}).`);
  console.log(`Licence texts in the build output: ${readdirSync(join(outDir, "licenses")).length} files.`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(`The third-party list does not match the production build:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("The third-party list covers every npm package in the production bundle.");
