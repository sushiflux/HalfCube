// Guards roadmap item 0.1: the product name stands in one place (branding/branding.json); code reads it from there. This test
// scans the source files for the display name and the lowercase slug as literals and fails for every hit that is not on the
// allow-list below. Comments are not code and are skipped. To use the name in new code, import it (app/src/branding.ts, the
// {product} placeholder of the message catalogues, the generated constants of C# and C++); an allow-list entry needs a reason.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { branding } from "../../app/src/branding.ts";
import { repoRoot } from "../../config/build-info.ts";

// ------------------------------------------------------------------------------------------------ what is scanned

/** Folders (relative to the repository root) whose source files are scanned. */
const scannedRoots = ["app/src", "desktop/src", "config", "installer/app", "installer/setup", "engine/src", "protocol/generate.mjs", "scripts", "vite.config.ts", "vite.desktop.config.ts"];
const scannedExtensions = [".ts", ".tsx", ".mjs", ".cjs", ".cs", ".cpp", ".hpp", ".ps1", ".sh", ".css", ".html"];
const skippedFolders = new Set(["node_modules", "_build", "_deps", "bin", "obj", ".git"]);

/** Files that hold the name by design or are produced from another source. Each entry says why. */
const skippedFiles: ReadonlyArray<{ path: RegExp; why: string }> = [
  { path: /^app\/src\/branding\.ts$/, why: "reads branding.json; its comments name it" },
  { path: /\.generated\.(ts|css)$/, why: "generated from other sources (third-party catalogue, theme tokens)" },
  { path: /^app\/src\/(engine|document)\/generated\//, why: "generated from protocol/engine-protocol.json; its type names (HalfCubeDocument) are identifiers" },
  { path: /^engine\/src\/generated\/protocol\.hpp$/, why: "generated from protocol/engine-protocol.json; its type names (HalfCubeDocument) are identifiers" },
  { path: /^installer\/setup\/Generated\//, why: "generated from branding.json" },
  { path: /^engine\/src\/generated\/branding\.hpp$/, why: "generated from branding.json" },
];

/**
 * Lines or parts of lines that may keep the literal name, with the reason. Matched against the code of a line (comments removed).
 * They are removed from the line before the check, so one allowed token does not hide another literal on the same line.
 */
const allowedTokens: ReadonlyArray<{ token: RegExp; why: string }> = [
  // Identifiers: the name is part of a type, namespace or class name; they are not shown to anybody.
  { token: /\bHalfCube\.Setup\b/g, why: "C# namespace of the setup" },
  // Repository address: the GitHub repository carries the name; it is a URL, not the display name.
  { token: /github\.com\/sushiflux\/HalfCube/g, why: "public repository address" },
  // File names of artifacts that other tools produce or expect (CMake targets, the notices generator, the packager).
  { token: /\bhalfcube-(engine|license|notice|model|wordmark)[\w.-]*/g, why: "artifact and file names defined by CMake, the notices generator and the module layout" },
  { token: /"halfcube\/build_info\.hpp"/g, why: "include path of the header CMake generates (build_info.hpp.in)" },
  { token: /\bHALFCUBE_[A-Z_]+/g, why: "environment variable prefix (identifier)" },
  // Object keys of the message envelope between the preload script and the page; an identifier on both sides.
  { token: /\bhalfcube: "engine-port"|data\.halfcube\b|\{ halfcube: /g, why: "property name of the engine port envelope" },
  // Dev hooks on window (identifiers).
  { token: /__halfcube\w*/g, why: "dev-only window hooks" },
  // Dev gallery scenarios show the engine file name the way the real error would show it.
  { token: /halfcube-engine/g, why: "engine file name in error texts" },
];

// ------------------------------------------------------------------------------------------------ the scan

/** Removes comments from the source text of one file, keeping line numbers. Strings are not parsed (good enough for a guard). */
export function stripComments(text: string, path: string): string[] {
  const hashComments = path.endsWith(".ps1") || path.endsWith(".sh");
  let inBlock = false;
  return text.split("\n").map((raw) => {
    let line = raw;
    if (hashComments && /^\s*#/.test(line)) return "";
    if (hashComments) line = line.replace(/(^|\s)#\s.*$/, "$1");
    let out = "";
    while (line.length > 0) {
      if (inBlock) {
        const end = line.indexOf("*/");
        if (end < 0) return out;
        inBlock = false;
        line = line.slice(end + 2);
      } else {
        const start = line.indexOf("/*");
        if (start < 0) {
          out += line;
          break;
        }
        out += line.slice(0, start);
        inBlock = true;
        line = line.slice(start + 2);
      }
    }
    // A line comment starts with // at the start of the line or after whitespace (so https:// stays).
    return out.replace(/(^|\s)\/\/.*$/, "$1");
  });
}

export interface Hit {
  file: string;
  line: number;
  text: string;
}

const nameWord = (name: string) => new RegExp(`(?<![A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`);

/** Hits of the display name and the slug in the code (not the comments) of one file. */
export function findLiterals(text: string, path: string, name: string, slug: string): Hit[] {
  const hits: Hit[] = [];
  const nameRe = nameWord(name);
  const slugRe = nameWord(slug);
  stripComments(text, path).forEach((code, index) => {
    let rest = code;
    for (const { token } of allowedTokens) rest = rest.replace(token, " ");
    if (nameRe.test(rest) || slugRe.test(rest)) hits.push({ file: path, line: index + 1, text: code.trim().slice(0, 140) });
  });
  return hits;
}

function* walk(path: string): Generator<string> {
  const abs = join(repoRoot, path);
  if (!existsSync(abs)) return;
  if (statSync(abs).isFile()) {
    yield path;
    return;
  }
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedFolders.has(entry.name)) continue;
    yield* walk(`${path}/${entry.name}`);
  }
}

/** The scanned source files with their text, without the skipped ones. */
function scannedFiles(): Array<{ file: string; text: string }> {
  const files: Array<{ file: string; text: string }> = [];
  for (const root of scannedRoots) {
    for (const file of walk(root)) {
      if (!scannedExtensions.some((ext) => file.endsWith(ext))) continue;
      if (skippedFiles.some((s) => s.path.test(file))) continue;
      files.push({ file, text: readFileSync(join(repoRoot, file), "utf8") });
    }
  }
  return files;
}

function scan(): Hit[] {
  return scannedFiles().flatMap(({ file, text }) => findLiterals(text, file, branding.name, branding.slug));
}

// ------------------------------------------------------------------------------------------------ tests

describe("the product name in code", () => {
  it("stands as a literal nowhere outside the allow-list (read it from branding)", () => {
    const hits = scan();
    const report = hits.map((h) => `${h.file}:${h.line}  ${h.text}`);
    expect(report, `Use app/src/branding.ts, the {product} placeholder, or the generated constants instead of the literal:\n${report.join("\n")}`).toEqual([]);
  });

  it("keeps no allow-list entry that nothing uses", () => {
    const code = scannedFiles().flatMap(({ file, text }) => stripComments(text, file));
    for (const { token, why } of allowedTokens) {
      expect(code.some((line) => new RegExp(token.source).test(line)), `allowed token matches nothing: ${token} (${why})`).toBe(true);
    }
  });

  it("skips only files that exist or are produced by a known generator", () => {
    // A stale entry would hide a file that moved; every pattern must match something in the repository.
    const all = scannedRoots.flatMap((root) => [...walk(root)]);
    for (const { path, why } of skippedFiles) {
      expect(all.some((f) => path.test(f)), `skip entry matches no file: ${path} (${why})`).toBe(true);
    }
  });
});

describe("the guard itself", () => {
  const find = (text: string, path = "x.ts") => findLiterals(text, path, "HalfCube", "halfcube").map((h) => h.line);

  it("finds the display name in code and in strings", () => {
    expect(find('const title = "HalfCube";')).toEqual([1]);
    expect(find("const t = `Reinstall HalfCube.`;")).toEqual([1]);
    expect(find('<svg aria-label="HalfCube" />', "x.tsx")).toEqual([1]);
  });

  it("finds the slug as a literal id", () => {
    expect(find('const key = "halfcube.session";')).toEqual([1]);
    expect(find('const channel = "halfcube:open";')).toEqual([1]);
  });

  it("ignores comments of every kind", () => {
    expect(find("// HalfCube starts the engine\nconst a = 1; // HalfCube\n/* HalfCube */ const b = 2;\n/*\n HalfCube\n*/\nconst c = 3;")).toEqual([]);
    expect(find("/// <summary>HalfCube</summary>", "x.cs")).toEqual([]);
    expect(find("# HalfCube\nWrite-Host 'x' # HalfCube", "x.ps1")).toEqual([]);
  });

  it("does not take a URL for a comment, and still reports a second literal on the same line", () => {
    expect(find('const u = "https://example.org/HalfCube";')).toEqual([1]);
    expect(find('const u = "github.com/sushiflux/HalfCube"; const n = "HalfCube";')).toEqual([1]);
  });

  it("allows identifiers, the repository address and environment variables", () => {
    expect(find("export interface HalfCubeDocument {}")).toEqual([]);
    expect(find('const repo = "https://github.com/sushiflux/HalfCube";')).toEqual([]);
    expect(find("const v = process.env.HALFCUBE_CHANNEL;")).toEqual([]);
    expect(find("namespace HalfCube.Setup.Ui;", "x.cs")).toEqual([]);
    expect(find('import { createHalfCubeModel } from "./halfcube-model.ts";')).toEqual([]);
  });
});
