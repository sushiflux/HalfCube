// Unit tests of the third-party notices generator (scripts/notices/notices.ts): the extraction helpers, and the checks that
// must fail loudly (missing licence file, out-of-date generated files, uncovered packages, pinned values that moved).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildNotices,
  compareWithDisk,
  NoticesError,
  productionClosure,
  readSources,
  readWoff2Names,
  scanCopyrights,
  type Sources,
} from "../../../scripts/notices/notices.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

describe("scanCopyrights", () => {
  it("merges the years per holder and sorts by the first year", () => {
    const lines = scanCopyrights([
      "// Copyright (c) 2013-2014 OPEN CASCADE SAS\n// Copyright (c) 1991-1999 Matra Datavision\n",
      " * Copyright (c) 2026 OPEN CASCADE SAS *\n",
    ]);
    expect(lines).toEqual(["Copyright (c) 1991-1999 Matra Datavision", "Copyright (c) 2013-2026 OPEN CASCADE SAS"]);
  });

  it("joins a holder that continues on the next comment line", () => {
    const lines = scanCopyrights(["// Copyright (c) 2003-2007 OPEN CASCADE, EADS/CCR,\n//                         EDF R&D, LEG\n"]);
    expect(lines).toEqual(["Copyright (c) 2003-2007 OPEN CASCADE, EADS/CCR, EDF R&D, LEG"]);
  });

  it("reads SPDX lines and skips lines that list several years", () => {
    const lines = scanCopyrights(["// SPDX-FileCopyrightText: 2013 - 2025 Niels Lohmann <https://nlohmann.me>\n * Copyright (c) 1991, 2000, 2001 by Lucent\n"]);
    expect(lines).toEqual(["Copyright (c) 2013-2025 Niels Lohmann <https://nlohmann.me>"]);
  });
});

describe("readWoff2Names", () => {
  it("reads copyright and version from the name table of the shipped Geist font", () => {
    const names = readWoff2Names(readFileSync(join(repoRoot, "app/src/assets/fonts/Geist-Variable.woff2")));
    expect(names.version).toMatch(/^Version \d+\.\d+/);
    expect(names.copyright).toContain("Geist");
  });

  it("rejects a file that is not WOFF2", () => {
    expect(() => readWoff2Names(Buffer.alloc(64))).toThrow("not a WOFF2 file");
  });
});

describe("productionClosure", () => {
  it("follows the dependencies of the lockfile from the roots", () => {
    const lock = {
      packages: {
        "node_modules/a": { dependencies: { b: "1" } },
        "node_modules/b": { dependencies: { c: "1" } },
        "node_modules/c": {},
        "node_modules/d": {},
      },
    };
    expect(productionClosure(lock, ["a"])).toEqual(["a", "b", "c"]);
  });
});

/** A tiny repository with one engine component, one npm package and one pinned vendored text. */
function makeRepo(): { root: string; sources: Sources } {
  const root = mkdtempSync(join(tmpdir(), "partcraft-notices-test-"));
  const write = (rel: string, content: string): void => {
    const file = join(root, ...rel.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  write(
    "third_party/manifest.json",
    JSON.stringify({
      components: [
        {
          id: "lib",
          name: "Example lib",
          version: "1.0.0",
          license: "MIT",
          source: "https://example.test/lib",
          shipped: true,
          usedIn: ["engine-native", "engine-wasm"],
          licenseFiles: ["engine/_deps/lib/LICENSE"],
          fetch: { dir: "lib" },
        },
        { id: "test-only", name: "Test only", version: "1", license: "MIT", source: "https://example.test/t", shipped: false, usedIn: [], licenseFiles: [] },
      ],
    }),
  );
  write("engine/_deps/lib/LICENSE", "MIT License\r\n\r\nCopyright (c) 2020 Example Author\r\n\r\nPermission is hereby granted.\r\n");
  write("package.json", JSON.stringify({ dependencies: { foo: "1.2.3" } }));
  write("package-lock.json", JSON.stringify({ packages: { "": {}, "node_modules/foo": { version: "1.2.3" } } }));
  write("node_modules/foo/package.json", JSON.stringify({ name: "foo", version: "1.2.3", license: "MIT", repository: { url: "git+https://example.test/foo.git" } }));
  write("node_modules/foo/LICENSE", "Copyright (c) 2021 Foo Authors\n\nPermission is hereby granted.\n");
  write("third_party/licenses/vendored.txt", "Copyright (c) 2022 Vendor\n\nText.\n");
  write("LICENSE", "own licence\n");
  write("NOTICE", "own notice\n");
  const sources: Sources = {
    formatVersion: 1,
    output: { module: "app/src/about/third-party.generated.ts", textDir: "app/public/licenses", textUrlPrefix: "licenses/" },
    ownTexts: [
      { id: "partcraft-license", file: "LICENSE" },
      { id: "partcraft-notice", file: "NOTICE" },
    ],
    npm: { extraRoots: [], notBundled: {} },
    entries: [
      {
        id: "lib",
        group: "engine",
        from: { kind: "manifest", id: "lib" },
        purpose: { de: "Beispiel", en: "Example" },
        copyright: { licenseFiles: {} },
      },
      {
        id: "foo",
        group: "ui",
        from: { kind: "npm", packages: ["foo"], main: "foo" },
        platforms: ["desktop", "browser"],
        purpose: { de: "Foo", en: "Foo" },
      },
      {
        id: "vendored",
        group: "shell",
        from: {
          kind: "static",
          name: "Vendored",
          version: "2.0.0",
          license: "MIT",
          source: "https://example.test/v",
          files: [{ path: "third_party/licenses/vendored.txt" }],
        },
        platforms: ["desktop"],
        purpose: { de: "Vendored", en: "Vendored" },
      },
    ],
  };
  write("third_party/notices.sources.json", JSON.stringify(sources));
  return { root, sources };
}

describe("buildNotices", () => {
  let repo: ReturnType<typeof makeRepo>;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => {
    rmSync(repo.root, { recursive: true, force: true });
  });

  const problemsOf = (fn: () => unknown): string[] => {
    try {
      fn();
    } catch (error) {
      if (error instanceof NoticesError) return error.problems;
      throw error;
    }
    return [];
  };

  it("builds every entry from the real files, with LF line endings and platforms from the manifest", () => {
    const result = buildNotices(repo.root, readSources(repo.root));
    expect(result.entries.map((e) => e.id)).toEqual(["lib", "foo", "vendored"]);
    const lib = result.entries[0];
    expect(lib?.platforms).toEqual(["desktop", "browser"]);
    expect(lib?.copyright).toEqual(["Copyright (c) 2020 Example Author"]);
    expect(lib?.textFile).toBe("licenses/lib.txt");
    expect(result.files.get("app/public/licenses/lib.txt")).toBe("MIT License\n\nCopyright (c) 2020 Example Author\n\nPermission is hereby granted.\n");
    expect(result.entries[1]?.source).toBe("https://example.test/foo");
    expect(result.files.get("app/public/licenses/partcraft-license.txt")).toBe("own licence\n");
    expect(result.files.get("app/src/about/third-party.generated.ts")).toContain('"id": "vendored"');
  });

  it("fails with the file name and how to get it when a licence file is missing", () => {
    rmSync(join(repo.root, "engine/_deps/lib/LICENSE"));
    const problems = problemsOf(() => buildNotices(repo.root, readSources(repo.root)));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("engine/_deps/lib/LICENSE is missing");
    expect(problems[0]).toContain("fetch-deps");
  });

  it("fails when an npm package or a vendored text is missing", () => {
    rmSync(join(repo.root, "node_modules/foo/LICENSE"));
    rmSync(join(repo.root, "third_party/licenses/vendored.txt"));
    const problems = problemsOf(() => buildNotices(repo.root, readSources(repo.root)));
    expect(problems.some((p) => p.includes("foo ships no licence file"))).toBe(true);
    expect(problems.some((p) => p.includes("third_party/licenses/vendored.txt is missing"))).toBe(true);
  });

  it("fails when a shipped manifest component has no entry", () => {
    const manifestFile = join(repo.root, "third_party/manifest.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { components: unknown[] };
    manifest.components.push({ id: "extra", name: "Extra", version: "1", license: "MIT", source: "x", shipped: true, usedIn: ["engine-native"], licenseFiles: [] });
    writeFileSync(manifestFile, JSON.stringify(manifest));
    const problems = problemsOf(() => buildNotices(repo.root, readSources(repo.root)));
    expect(problems).toEqual(["Manifest component extra is shipped but has no entry in third_party/notices.sources.json."]);
  });

  it("fails when a production dependency has no entry", () => {
    writeFileSync(join(repo.root, "package.json"), JSON.stringify({ dependencies: { foo: "1.2.3", bar: "1" } }));
    const problems = problemsOf(() => buildNotices(repo.root, readSources(repo.root)));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("npm package bar is part of the production dependency tree");
  });

  it("fails when a pinned hash or a pinned version no longer matches", () => {
    const sources = readSources(repo.root);
    const vendored = sources.entries[2];
    if (vendored?.from.kind !== "static") throw new Error("fixture");
    vendored.from.files = [{ path: "third_party/licenses/vendored.txt", sha256: "0".repeat(64) }];
    vendored.from.requires = [{ kind: "npm-installed", package: "foo", version: "9.9.9", because: "pinned for the test" }];
    const problems = problemsOf(() => buildNotices(repo.root, sources));
    expect(problems.some((p) => p.includes("pins " + "0".repeat(64)))).toBe(true);
    expect(problems.some((p) => p.includes("foo 1.2.3 is installed") && p.includes("expects 9.9.9"))).toBe(true);
  });

  it("reports every problem at once instead of stopping at the first", () => {
    rmSync(join(repo.root, "engine/_deps/lib/LICENSE"));
    rmSync(join(repo.root, "third_party/licenses/vendored.txt"));
    expect(problemsOf(() => buildNotices(repo.root, readSources(repo.root)))).toHaveLength(2);
  });
});

describe("compareWithDisk", () => {
  let repo: ReturnType<typeof makeRepo>;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => {
    rmSync(repo.root, { recursive: true, force: true });
  });

  const writeResult = (files: Map<string, string>): void => {
    for (const [rel, content] of files) {
      const file = join(repo.root, ...rel.split("/"));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  };

  it("finds nothing when the files on disk are current, also with CRLF line endings", () => {
    const result = buildNotices(repo.root, repo.sources);
    writeResult(new Map([...result.files].map(([rel, content]) => [rel, content.replaceAll("\n", "\r\n")])));
    expect(compareWithDisk(repo.root, repo.sources, result)).toEqual([]);
  });

  it("reports a missing generated file", () => {
    const result = buildNotices(repo.root, repo.sources);
    expect(compareWithDisk(repo.root, repo.sources, result)).toContain("app/src/about/third-party.generated.ts is missing");
  });

  it("reports an out-of-date generated file after a licence text changed", () => {
    writeResult(buildNotices(repo.root, repo.sources).files);
    writeFileSync(join(repo.root, "node_modules/foo/LICENSE"), "Copyright (c) 2021 Foo Authors\n\nA changed text.\n");
    const result = buildNotices(repo.root, repo.sources);
    expect(compareWithDisk(repo.root, repo.sources, result)).toEqual(["app/public/licenses/foo.txt is out of date"]);
  });

  it("reports a text file that no entry produces any more", () => {
    writeResult(buildNotices(repo.root, repo.sources).files);
    writeFileSync(join(repo.root, "app/public/licenses/removed.txt"), "left over\n");
    const result = buildNotices(repo.root, repo.sources);
    expect(compareWithDisk(repo.root, repo.sources, result)).toEqual(["app/public/licenses/removed.txt is not produced by any entry any more"]);
  });
});
