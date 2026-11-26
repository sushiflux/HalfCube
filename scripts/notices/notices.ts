// Builds the third-party list of the info view ("Über Partcraft", tab Lizenzen) from the real components.
//
// Inputs (all read, nothing invented):
//   third_party/notices.sources.json   hand-maintained facts: groups, purposes, labels, pinned values with cross-checks
//   third_party/manifest.json          the engine components (version, SPDX, source, licence files, files, usedIn)
//   package.json, package-lock.json    the production dependency tree of the UI
//   node_modules/<package>             version, licence, licence text of every bundled npm package
//   engine/_deps/**                    licence files and source headers of the engine libraries (after fetch-deps)
//   engine/_build/wasm/licenses/**     licence texts of the Emscripten runtime (after the WebAssembly build)
//   third_party/licenses/**            vendored texts where the real component ships none (pinned by SHA-256)
//   the fonts and LICENSE / NOTICE of this repository
//
// Outputs (see generate.ts): app/src/about/third-party.generated.ts and app/public/licenses/<id>.txt.
// A missing or inconsistent input never produces a partial result: every problem is collected and reported together.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { brotliDecompressSync } from "node:zlib";

// ------------------------------------------------------------------------------------------ types

export type Group = "engine" | "ui" | "shell";
export type Platform = "desktop" | "browser";
export interface Bilingual {
  de: string;
  en: string;
}

/** One row of the list; the shape of the generated module (see app/src/about/third-party.generated.ts). */
export interface NoticeEntry {
  id: string;
  group: Group;
  name: string;
  version: string;
  license: string;
  licenseLabel?: Bilingual;
  copyright: string[];
  source: string;
  purpose: Bilingual;
  platforms: Platform[];
  textFile: string | null;
  note?: Bilingual;
}

export interface NoticesResult {
  entries: NoticeEntry[];
  /** Output files by repository-relative path (forward slashes), content with LF line endings. */
  files: Map<string, string>;
}

export class NoticesError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`${problems.length} problem(s) while building the third-party notices:\n- ${problems.join("\n- ")}`);
    this.name = "NoticesError";
    this.problems = problems;
  }
}

interface CopyrightConfig {
  /** false: the licence files hold no holder line; {} or { exclude }: take the lines that start with "Copyright". */
  licenseFiles?: false | { exclude?: string[] };
  scan?: { source: "occt-toolkits" } | { source: "manifest-files" } | { source: "dirs"; dirs: string[] };
  blocks?: { file: string; start: string; end: string }[];
}

type Requirement =
  | { kind: "npm-installed"; package: string; version: string; because?: string }
  | { kind: "lockfile"; file: string; package: string; version: string }
  | { kind: "json"; file: string; path: string[]; equals: string }
  | { kind: "contains"; file: string; text: string };

type From =
  | { kind: "manifest"; id: string }
  | {
      kind: "npm";
      packages: string[];
      main: string;
      cutTextAt?: Record<string, string>;
      /** For a package that ships CSS instead of JavaScript: a string that proves its output is in the built stylesheet. */
      cssProof?: string;
    }
  | { kind: "font"; fonts: string[]; licenseFile: string; license: string; source: string }
  | {
      kind: "static";
      name: string;
      version: string;
      license: string;
      source: string;
      files?: { path: string; sha256?: string }[];
      requires?: Requirement[];
    };

interface SourceEntry {
  id: string;
  group: Group;
  from: From;
  name?: string;
  platforms?: Platform[];
  purpose: Bilingual;
  note?: Bilingual;
  licenseLabel?: Bilingual;
  copyright?: CopyrightConfig;
}

export interface Sources {
  formatVersion: number;
  output: { module: string; textDir: string; textUrlPrefix: string };
  ownTexts: { id: string; file: string }[];
  npm: { extraRoots: string[]; notBundled: Record<string, string> };
  entries: SourceEntry[];
}

interface ManifestComponent {
  id: string;
  name: string;
  version: string;
  license: string;
  source: string;
  shipped: boolean;
  usedIn: string[];
  files?: string[];
  licenseFiles: string[];
  fetch?: { dir?: string };
}

// ------------------------------------------------------------------------------------------ small helpers

const toLf = (text: string): string => text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const SEPARATOR = "=".repeat(78);

/** Where to get a missing input, by its location. */
function fixHint(rel: string): string {
  if (rel.startsWith("engine/_deps/")) return "run engine/scripts/fetch-deps.ps1 (Windows) or sh engine/scripts/fetch-deps.sh";
  if (rel.startsWith("engine/_build/wasm/")) {
    return "build the WebAssembly engine first (engine/scripts/build-wasm.ps1, or bash scripts/ci/build-wasm-linux.sh)";
  }
  if (rel.startsWith("node_modules/")) return "run npm ci";
  return "restore the file";
}

class Context {
  readonly root: string;
  readonly problems: string[] = [];
  constructor(root: string) {
    this.root = root;
  }

  add(message: string): void {
    if (!this.problems.includes(message)) this.problems.push(message);
  }

  abs(rel: string): string {
    return join(this.root, ...rel.split("/"));
  }

  exists(rel: string): boolean {
    return existsSync(this.abs(rel));
  }

  /** Reads a text file with LF line endings; a missing file is a problem, never skipped. */
  text(rel: string, what: string): string | null {
    const file = this.abs(rel);
    if (!existsSync(file) || !statSync(file).isFile()) {
      this.add(`${what}: file ${rel} is missing; ${fixHint(rel)}.`);
      return null;
    }
    return toLf(readFileSync(file, "utf8"));
  }

  json<T>(rel: string, what: string): T | null {
    const raw = this.text(rel, what);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      this.add(`${what}: ${rel} is not valid JSON (${(error as Error).message}).`);
      return null;
    }
  }
}

interface TextBlock {
  names: string[];
  text: string;
}

/** Joins licence texts unchanged; identical texts are shown once under all their names. */
function assembleText(blocks: TextBlock[]): string {
  const unique: TextBlock[] = [];
  for (const block of blocks) {
    const same = unique.find((u) => u.text === block.text);
    if (same) same.names.push(...block.names);
    else unique.push({ names: [...block.names], text: block.text });
  }
  const first = unique[0];
  if (unique.length === 1 && first && first.names.length === 1) return first.text;
  return unique
    .map((b) => `${SEPARATOR}\n${b.names.join(", ")}\n${SEPARATOR}\n\n${b.text.endsWith("\n") ? b.text : `${b.text}\n`}`)
    .join("\n");
}

// ------------------------------------------------------------------------------------------ copyright lines

const LICENSE_COPYRIGHT = /^\s*(?:"""\s*)?(Copyright\s*(?:\([cC]\)|©)?\s*(?:\d{4}|[A-Z]).*)$/;

/** Lines of a licence text that name a holder ("Copyright (c) 2013-2025 Niels Lohmann"), in file order. */
function licenseCopyrightLines(text: string, exclude: string[]): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const match = LICENSE_COPYRIGHT.exec(raw);
    const line = match?.[1]?.trim();
    if (line && !exclude.some((e) => line.includes(e))) lines.push(line);
  }
  return lines;
}

const SOURCE_EXTENSIONS = new Set([".h", ".hpp", ".hxx", ".cxx", ".lxx", ".pxx", ".cpp", ".c", ".inl", ".tpp", ".ipp"]);
const HEADER_COPYRIGHT =
  /^[ \t/*!#]*(?:SPDX-FileCopyrightText:\s*|Copyright(?:\s*\([cC]\)|\s*©)?,?\s*)(\d{4})(?:\s*[-–]\s*(\d{4}))?,?\s+(\S.*?)\s*\**\s*$/;

function walk(ctx: Context, rel: string, out: string[], extensionless: boolean): void {
  const dir = ctx.abs(rel);
  if (!existsSync(dir)) {
    ctx.add(`Source folder ${rel} is missing; ${fixHint(rel)}.`);
    return;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(ctx, child, out, extensionless);
    else {
      const dot = entry.name.lastIndexOf(".");
      const ext = dot < 0 ? "" : entry.name.slice(dot);
      if (SOURCE_EXTENSIONS.has(ext) || (extensionless && ext === "")) out.push(child);
    }
  }
}

/**
 * Collects "Copyright (c) <years> <holder>" lines from source headers: per holder the smallest and the largest year of
 * all files. A holder text that continues on the next comment line (ends with a comma) is joined.
 */
export function scanCopyrights(texts: Iterable<string>): string[] {
  const holders = new Map<string, { from: number; to: number }>();
  for (const text of texts) {
    const lines = text.split("\n");
    lines.forEach((raw, index) => {
      const match = HEADER_COPYRIGHT.exec(raw);
      if (!match) return;
      let holder = (match[3] ?? "").replace(/\s+/g, " ");
      // "Copyright (c) 1991, 2000, 2001 by ..." lists several years; its real notice is handled as a text block.
      if (/^\d/.test(holder)) return;
      if (holder.endsWith(",")) {
        const next = (lines[index + 1] ?? "").replace(/^[ \t/*!#]+/, "").replace(/\s*\**\s*$/, "");
        if (next && !/^(Copyright|This file|Created)/.test(next)) holder = `${holder} ${next.replace(/\s+/g, " ")}`;
      }
      const from = Number(match[1]);
      const to = Number(match[2] ?? match[1]);
      const known = holders.get(holder);
      if (known) {
        known.from = Math.min(known.from, from);
        known.to = Math.max(known.to, to);
      } else holders.set(holder, { from, to });
    });
  }
  return [...holders]
    .sort((a, b) => a[1].from - b[1].from || (a[0] < b[0] ? -1 : 1))
    .map(([holder, years]) => `Copyright (c) ${years.from === years.to ? years.from : `${years.from}-${years.to}`} ${holder}`);
}

/** The toolkits OCCT is linked from, read from the engine's CMake file, so a new toolkit can never be missed. */
function occtToolkits(ctx: Context): string[] {
  const cmake = ctx.text("engine/CMakeLists.txt", "OCCT toolkits");
  if (cmake === null) return [];
  const match = /set\(\s*PC_OCCT_LIBS\s+([^)]*)\)/.exec(cmake);
  const names = match?.[1]?.split(/\s+/).filter(Boolean) ?? [];
  if (names.length === 0) ctx.add("engine/CMakeLists.txt: no set(PC_OCCT_LIBS ...) found, the OCCT toolkits cannot be read.");
  return names;
}

function scanFiles(ctx: Context, component: ManifestComponent | null, scan: NonNullable<CopyrightConfig["scan"]>): string[] {
  const files: string[] = [];
  if (scan.source === "dirs") {
    for (const dir of scan.dirs) walk(ctx, dir, files, true);
  } else if (scan.source === "occt-toolkits") {
    const modules = ctx.exists("engine/_deps/occt-src/src") ? readdirSync(ctx.abs("engine/_deps/occt-src/src"), { withFileTypes: true }) : [];
    for (const kit of occtToolkits(ctx)) {
      let found = false;
      for (const module of modules) {
        if (module.isDirectory() && ctx.exists(`engine/_deps/occt-src/src/${module.name}/${kit}`)) {
          walk(ctx, `engine/_deps/occt-src/src/${module.name}/${kit}`, files, false);
          found = true;
        }
      }
      if (!found) ctx.add(`OCCT toolkit ${kit} (engine/CMakeLists.txt) has no folder under engine/_deps/occt-src/src; ${fixHint("engine/_deps/")}.`);
    }
  } else {
    const dir = component?.fetch?.dir;
    if (!component || !dir) {
      ctx.add("scan source manifest-files needs a manifest component with fetch.dir.");
      return files;
    }
    for (const pattern of component.files ?? []) {
      const rel = `engine/_deps/${dir}/${pattern}`;
      if (!pattern.includes("*")) {
        if (ctx.exists(rel)) files.push(rel);
        else ctx.add(`planegcs source file ${rel} is missing; ${fixHint(rel)}.`);
      } else {
        const folder = posix.dirname(rel);
        const ext = posix.extname(pattern);
        if (!ctx.exists(folder)) ctx.add(`Source folder ${folder} is missing; ${fixHint(folder)}.`);
        else {
          for (const name of readdirSync(ctx.abs(folder)).sort()) {
            if (name.endsWith(ext) && !files.includes(`${folder}/${name}`)) files.push(`${folder}/${name}`);
          }
        }
      }
    }
  }
  return files;
}

/** Slices the lines from the first line matching start to the first following line matching end (both included). */
function extractBlock(ctx: Context, file: string, start: string, end: string): { text: string; copyright: string | null } | null {
  const text = ctx.text(file, "embedded notice");
  if (text === null) return null;
  const lines = text.split("\n");
  const from = lines.findIndex((l) => new RegExp(start).test(l));
  if (from < 0) {
    ctx.add(`${file}: the embedded notice no longer starts with /${start}/; look at the file and update third_party/notices.sources.json.`);
    return null;
  }
  const rest = lines.slice(from);
  const length = rest.findIndex((l) => new RegExp(end).test(l));
  if (length < 0) {
    ctx.add(`${file}: the embedded notice no longer ends with /${end}/; look at the file and update third_party/notices.sources.json.`);
    return null;
  }
  const block = rest.slice(0, length + 1);
  const copyright = block.map((l) => /Copyright\s*(?:\([cC]\)|©)?\s*(?:\d|by\b)/.exec(l) && l).find(Boolean);
  const clean = copyright?.replace(/^[ \t/*!#]+/, "").trim() ?? null;
  return { text: block.join("\n"), copyright: clean };
}

// ------------------------------------------------------------------------------------------ requirement checks

function checkRequirement(ctx: Context, id: string, requirement: Requirement): void {
  if (requirement.kind === "npm-installed") {
    const pkg = ctx.json<{ version: string }>(`node_modules/${requirement.package}/package.json`, `${id}: check`);
    if (pkg && pkg.version !== requirement.version) {
      ctx.add(
        `${id}: ${requirement.package} ${pkg.version} is installed, third_party/notices.sources.json expects ${requirement.version}` +
          `${requirement.because ? ` (${requirement.because})` : ""}. Confirm the pinned values of this entry and update them.`,
      );
    }
  } else if (requirement.kind === "lockfile") {
    const lock = ctx.json<{ packages: Record<string, { version?: string }> }>(requirement.file, `${id}: check`);
    const found = lock?.packages[`node_modules/${requirement.package}`]?.version;
    if (lock && found !== requirement.version) {
      ctx.add(`${id}: ${requirement.file} has ${requirement.package} ${found ?? "(missing)"}, third_party/notices.sources.json expects ${requirement.version}.`);
    }
  } else if (requirement.kind === "contains") {
    const text = ctx.text(requirement.file, `${id}: check`);
    if (text !== null && !text.includes(requirement.text)) {
      ctx.add(`${id}: ${requirement.file} no longer contains "${requirement.text}"; keep the text and third_party/notices.sources.json in step.`);
    }
  } else {
    const data = ctx.json<unknown>(requirement.file, `${id}: check`);
    let value: unknown = data;
    for (const key of requirement.path) value = (value as Record<string, unknown> | undefined)?.[key];
    if (data !== null && value !== requirement.equals) {
      ctx.add(`${id}: ${requirement.file} ${requirement.path.join(".")} is ${String(value)}, third_party/notices.sources.json expects ${requirement.equals}.`);
    }
  }
}

// ------------------------------------------------------------------------------------------ fonts

/** Reads the name table of a WOFF2 font: copyright (name ID 0) and version (name ID 5). */
export function readWoff2Names(file: Buffer): { copyright: string | null; version: string | null } {
  if (file.length < 48 || file.readUInt32BE(0) !== 0x774f4632) throw new Error("not a WOFF2 file");
  const numTables = file.readUInt16BE(12);
  const compressedSize = file.readUInt32BE(20);
  let position = 48;
  const base128 = (): number => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = file[position++] ?? 0;
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error("bad UIntBase128");
  };
  const lengths: { index: number; length: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = file[position++] ?? 0;
    const tag = flags & 0x3f;
    if (tag === 0x3f) position += 4;
    const transformVersion = flags >> 6;
    const original = base128();
    // glyf (10) and loca (11) are transformed with version 0; every other table only with a non-zero version.
    const transformed = tag === 10 || tag === 11 ? transformVersion === 0 : transformVersion !== 0;
    lengths.push({ index: tag, length: transformed ? base128() : original });
  }
  const data = brotliDecompressSync(file.subarray(position, position + compressedSize));
  let offset = 0;
  let name: Buffer | null = null;
  for (const table of lengths) {
    if (table.index === 5) name = data.subarray(offset, offset + table.length);
    offset += table.length;
  }
  if (!name) return { copyright: null, version: null };
  const count = name.readUInt16BE(2);
  const stringOffset = name.readUInt16BE(4);
  const read = (id: number): string | null => {
    for (let i = 0; i < count; i++) {
      const record = 6 + i * 12;
      if (name.readUInt16BE(record) === 3 && name.readUInt16BE(record + 6) === id) {
        const length = name.readUInt16BE(record + 8);
        const start = stringOffset + name.readUInt16BE(record + 10);
        return Buffer.from(name.subarray(start, start + length)).swap16().toString("utf16le");
      }
    }
    return null;
  };
  return { copyright: read(0), version: read(5) };
}

// ------------------------------------------------------------------------------------------ npm

function repositoryUrl(pkg: { repository?: string | { url?: string }; homepage?: string }): string | null {
  const raw = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (!raw) return pkg.homepage ?? null;
  return raw.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/\.git$/, "");
}

interface NpmPackage {
  name: string;
  version: string;
  license?: string;
  repository?: string | { url?: string };
  homepage?: string;
}

function licenseFileOf(ctx: Context, name: string): string | null {
  const dir = `node_modules/${name}`;
  if (!ctx.exists(dir)) {
    ctx.add(`npm package ${name} is not installed (${dir}); ${fixHint(dir)}.`);
    return null;
  }
  const file = readdirSync(ctx.abs(dir)).find((f) => /^(licen[sc]e|copying)(\.(md|txt))?$/i.test(f));
  if (!file) {
    ctx.add(`npm package ${name} ships no licence file in ${dir}.`);
    return null;
  }
  return `${dir}/${file}`;
}

/** Packages of `dependencies` and their dependencies (and the extra roots), from the lockfile. */
export function productionClosure(lock: { packages: Record<string, { dependencies?: Record<string, string> }> }, roots: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const dep of Object.keys(lock.packages[`node_modules/${name}`]?.dependencies ?? {})) queue.push(dep);
  }
  return [...seen].sort();
}

// ------------------------------------------------------------------------------------------ entries

function buildEntries(ctx: Context, sources: Sources, texts: Map<string, string>): NoticeEntry[] {
  const manifest = ctx.json<{ components: ManifestComponent[] }>("third_party/manifest.json", "engine manifest");
  const components = manifest?.components ?? [];
  const entries: NoticeEntry[] = [];
  const usedManifest = new Set<string>();
  const outputFile = (id: string): string => `${sources.output.textUrlPrefix}${id}.txt`;

  const seenIds = new Set<string>();
  for (const source of sources.entries) {
    if (seenIds.has(source.id)) ctx.add(`Duplicate id ${source.id} in third_party/notices.sources.json.`);
    seenIds.add(source.id);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(source.id)) ctx.add(`Entry id "${source.id}" must be lowercase letters, digits and hyphens.`);
    const copyright: string[] = [];
    const add = (lines: string[]): void => {
      for (const line of lines) if (!copyright.includes(line)) copyright.push(line);
    };
    const blocks: TextBlock[] = [];
    let name = source.name ?? source.id;
    let version = "";
    let license = "";
    let url = "";
    let platforms: Platform[] = source.platforms ?? [];
    const from = source.from;

    let scannedLines: string[] = [];
    if (from.kind === "manifest") {
      const component = components.find((c) => c.id === from.id);
      if (!component) {
        ctx.add(`${source.id}: component ${from.id} is not in third_party/manifest.json.`);
        continue;
      }
      usedManifest.add(component.id);
      if (!component.shipped) ctx.add(`${source.id}: component ${component.id} is not shipped (manifest), it must not be listed.`);
      name = source.name ?? component.name;
      version = component.version;
      license = component.license;
      url = component.source;
      platforms = [...new Set(component.usedIn.map((u) => (u === "engine-native" ? "desktop" : u === "engine-wasm" ? "browser" : null)))].filter(
        (p): p is Platform => p !== null,
      );
      if (platforms.length === 0) ctx.add(`${source.id}: manifest usedIn ${component.usedIn.join(", ")} maps to no platform.`);
      const prefixes = ["engine/_deps/", "engine/_build/wasm/licenses/"];
      for (const rel of component.licenseFiles) {
        const text = ctx.text(rel, `${source.id}: licence file`);
        const prefix = prefixes.find((p) => rel.startsWith(p));
        if (text !== null) blocks.push({ names: [prefix ? rel.slice(prefix.length) : rel], text });
        const config = source.copyright?.licenseFiles;
        if (text !== null && config !== false && config !== undefined) add(licenseCopyrightLines(text, config.exclude ?? []));
      }
      const config = source.copyright;
      if (config?.licenseFiles === undefined && component.licenseFiles.length > 0) {
        ctx.add(`${source.id}: set copyright.licenseFiles in third_party/notices.sources.json (false when the licence files name no holder).`);
      }
      if (config?.scan) {
        const files = scanFiles(ctx, component, config.scan);
        const scanned = files.map((f) => readFileSync(ctx.abs(f), "utf8")).map(toLf);
        const lines = scanCopyrights(scanned);
        if (lines.length === 0) ctx.add(`${source.id}: the source scan found no copyright line (${files.length} files).`);
        scannedLines = lines;
      }
      const blockLines: string[] = [];
      if (config?.blocks && config.blocks.length > 0) {
        const parts: string[] = [];
        for (const b of config.blocks) {
          const block = extractBlock(ctx, b.file, b.start, b.end);
          if (!block) continue;
          parts.push(`${SEPARATOR}\n${b.file.replace(/^engine\/_deps\//, "")}\n${SEPARATOR}\n\n${block.text}\n`);
          if (block.copyright) blockLines.push(block.copyright);
        }
        if (parts.length > 0) {
          blocks.push({
            names: ["Notices of third-party code inside the sources (verbatim, from the files named below)"],
            text: `${parts.join("\n")}`,
          });
        }
      }
      // A holder that a verbatim block names (in its own wording) is not repeated from the scan.
      const holderOf = (line: string): string =>
        line
          .replace(/^Copyright\s*(?:\([cC]\)|©)?\s*[\d,\s-]*/, "")
          .trim()
          .toLowerCase();
      add(scannedLines.filter((line) => !blockLines.some((b) => b.toLowerCase().includes(holderOf(line)))));
      add(blockLines);
    } else if (from.kind === "npm") {
      const licenses: string[] = [];
      const missingMain = !from.packages.includes(from.main);
      if (missingMain) ctx.add(`${source.id}: main package ${from.main} is not in its packages list.`);
      for (const packageName of from.packages) {
        const pkg = ctx.json<NpmPackage>(`node_modules/${packageName}/package.json`, `${source.id}: package.json of ${packageName}`);
        const licensePath = licenseFileOf(ctx, packageName);
        if (!pkg || !licensePath) continue;
        if (!pkg.license) ctx.add(`${source.id}: ${packageName} declares no licence in its package.json.`);
        else if (!licenses.includes(pkg.license)) licenses.push(pkg.license);
        let text = ctx.text(licensePath, `${source.id}: licence file`);
        if (text === null) continue;
        const cut = from.cutTextAt?.[packageName];
        if (cut) {
          const at = text.indexOf(cut);
          if (at < 0) {
            ctx.add(`${source.id}: the marker "${cut}" is no longer in ${licensePath}; update cutTextAt in third_party/notices.sources.json.`);
            continue;
          }
          text = text.slice(0, at).replace(/\s+$/, "\n");
        }
        blocks.push({ names: [`${packageName} ${pkg.version}`], text });
        add(licenseCopyrightLines(text, []));
        if (packageName === from.main) {
          version = pkg.version;
          url = repositoryUrl(pkg) ?? "";
          if (!url) ctx.add(`${source.id}: ${packageName} names neither a repository nor a homepage.`);
        }
      }
      license = licenses.join(" AND ");
    } else if (from.kind === "font") {
      license = from.license;
      url = from.source;
      const text = ctx.text(from.licenseFile, `${source.id}: licence file`);
      if (text !== null) {
        blocks.push({ names: [from.licenseFile], text });
        // Only the preamble names the holder; later lines of the OFL text merely contain the words "Copyright Holder".
        add(licenseCopyrightLines(text, []).slice(0, 1));
      }
      const versions: string[] = [];
      for (const fontPath of from.fonts) {
        const file = ctx.abs(fontPath);
        if (!existsSync(file)) {
          ctx.add(`${source.id}: font file ${fontPath} is missing.`);
          continue;
        }
        try {
          const names = readWoff2Names(readFileSync(file));
          if (names.copyright) add([names.copyright.replace(/\.git\)$/, ")")]);
          const v = names.version?.replace(/^Version\s*/i, "").trim();
          if (!v) ctx.add(`${source.id}: ${fontPath} has no version in its name table.`);
          else if (!versions.includes(v)) versions.push(v);
        } catch (error) {
          ctx.add(`${source.id}: cannot read ${fontPath} (${(error as Error).message}).`);
        }
      }
      version = versions.join(" / ");
    } else {
      name = from.name;
      version = from.version;
      license = from.license;
      url = from.source;
      for (const file of from.files ?? []) {
        const text = ctx.text(file.path, `${source.id}: licence file`);
        if (text === null) continue;
        if (file.sha256 && sha256(text) !== file.sha256) {
          ctx.add(`${source.id}: ${file.path} has SHA-256 ${sha256(text)}, third_party/notices.sources.json pins ${file.sha256}. Confirm the new text and update the pin.`);
        }
        blocks.push({ names: [posix.basename(file.path)], text });
        add(licenseCopyrightLines(text, []));
      }
      for (const requirement of from.requires ?? []) checkRequirement(ctx, source.id, requirement);
    }

    let textFile: string | null = null;
    if (blocks.length > 0) {
      textFile = outputFile(source.id);
      texts.set(`${sources.output.textDir}/${source.id}.txt`, assembleText(blocks));
    }
    if (platforms.length === 0) ctx.add(`${source.id}: no platforms.`);
    const entry: NoticeEntry = { id: source.id, group: source.group, name, version, license, copyright, source: url, purpose: source.purpose, platforms, textFile };
    const ordered: NoticeEntry = {
      id: entry.id,
      group: entry.group,
      name: entry.name,
      version: entry.version,
      license: entry.license,
      ...(source.licenseLabel ? { licenseLabel: source.licenseLabel } : {}),
      copyright: entry.copyright,
      source: entry.source,
      purpose: entry.purpose,
      platforms: entry.platforms,
      textFile: entry.textFile,
      ...(source.note ? { note: source.note } : {}),
    };
    entries.push(ordered);
  }

  // Every shipped engine component is listed, nothing unshipped is.
  for (const component of components) {
    if (component.shipped && !usedManifest.has(component.id)) {
      ctx.add(`Manifest component ${component.id} is shipped but has no entry in third_party/notices.sources.json.`);
    }
  }
  return entries;
}

/** Packages of the production dependency tree must each belong to an entry or be listed as not bundled. */
function checkNpmCoverage(ctx: Context, sources: Sources): void {
  const rootPackage = ctx.json<{ dependencies?: Record<string, string> }>("package.json", "package.json");
  const lock = ctx.json<{ packages: Record<string, { dependencies?: Record<string, string> }> }>("package-lock.json", "package-lock.json");
  if (!rootPackage || !lock) return;
  const closure = productionClosure(lock, [...Object.keys(rootPackage.dependencies ?? {}), ...sources.npm.extraRoots]);
  const listed = new Set<string>();
  for (const entry of sources.entries) if (entry.from.kind === "npm" && entry.group === "ui") for (const p of entry.from.packages) listed.add(p);
  for (const name of closure) {
    if (!listed.has(name) && !(name in sources.npm.notBundled)) {
      ctx.add(
        `npm package ${name} is part of the production dependency tree but has no entry in third_party/notices.sources.json ` +
          `(add it to an entry, or to npm.notBundled with the reason after checking it is not in the bundle).`,
      );
    }
  }
  for (const name of Object.keys(sources.npm.notBundled)) {
    if (!closure.includes(name)) ctx.add(`npm.notBundled lists ${name}, which is not in the production dependency tree any more; remove it.`);
  }
}

// ------------------------------------------------------------------------------------------ output

function moduleSource(entries: NoticeEntry[]): string {
  return `// Generated by scripts/notices/generate.ts from third_party/notices.sources.json, third_party/manifest.json, package.json,
// the lockfiles and the licence files of the real components. Do not edit.
// Regenerate with "npm run notices"; "npm run check:notices" fails when this file or app/public/licenses is out of date.

export interface ThirdPartyEntry {
  /** Stable, lowercase, e.g. "occt". */
  id: string;
  /** shell = desktop program frame: Electron, Chromium, Velopack, VC++ runtime. */
  group: "engine" | "ui" | "shell";
  name: string;
  version: string;
  /** SPDX expression, or LicenseRef-... where SPDX has none. */
  license: string;
  /** Short display label when the SPDX expression is unwieldy. */
  licenseLabel?: { de: string; en: string };
  /** Lines taken from the component's licence and source files. */
  copyright: string[];
  /** URL of the source code. */
  source: string;
  /** One short line: what Partcraft uses it for. */
  purpose: { de: string; en: string };
  platforms: ("desktop" | "browser")[];
  /** Path relative to the app's public root, e.g. "licenses/occt.txt"; null when the component ships no text of its own. */
  textFile: string | null;
  note?: { de: string; en: string };
}

export const THIRD_PARTY: readonly ThirdPartyEntry[] = ${JSON.stringify(entries, null, 2)};
`;
}

export function readSources(root: string): Sources {
  const file = join(root, "third_party", "notices.sources.json");
  return JSON.parse(toLf(readFileSync(file, "utf8"))) as Sources;
}

/** Builds every output from the real inputs; throws NoticesError with all problems when anything is missing or inconsistent. */
export function buildNotices(root: string, sourcesOverride?: Sources): NoticesResult {
  const ctx = new Context(root);
  const sources = sourcesOverride ?? readSources(root);
  const files = new Map<string, string>();
  if (sources.formatVersion !== 1) ctx.add(`third_party/notices.sources.json: unknown formatVersion ${sources.formatVersion}.`);
  const entries = buildEntries(ctx, sources, files);
  checkNpmCoverage(ctx, sources);
  for (const own of sources.ownTexts) {
    const text = ctx.text(own.file, `${own.id}`);
    if (text !== null) files.set(`${sources.output.textDir}/${own.id}.txt`, text);
  }
  if (ctx.problems.length > 0) throw new NoticesError(ctx.problems);
  files.set(sources.output.module, moduleSource(entries));
  return { entries, files };
}

/** Compares the result with the files on disk (line endings ignored); returns one message per difference. */
export function compareWithDisk(root: string, sources: Sources, result: NoticesResult): string[] {
  const differences: string[] = [];
  for (const [rel, content] of result.files) {
    const file = join(root, ...rel.split("/"));
    if (!existsSync(file)) differences.push(`${rel} is missing`);
    else if (toLf(readFileSync(file, "utf8")) !== content) differences.push(`${rel} is out of date`);
  }
  const dir = join(root, ...sources.output.textDir.split("/"));
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!result.files.has(`${sources.output.textDir}/${name}`)) differences.push(`${sources.output.textDir}/${name} is not produced by any entry any more`);
    }
  }
  return differences;
}
