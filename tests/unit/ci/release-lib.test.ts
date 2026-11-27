// Unit tests of the release job's helpers (scripts/ci/release-lib.ts): tag and platform line, the release text of one
// version, Velopack's release notes excerpt and the update feed of a release. Fixture changelog: tests/fixtures/changelog.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatVersion } from "../../../app/src/version.ts";
import { parseChangelog } from "../../../app/src/updates/changelog.ts";
import {
  buildReleaseFeed,
  buildReleaseNotes,
  headingMatches,
  neutralEnglish,
  neutralNotice,
  neutralGerman,
  parseChangelogFile,
  parsePlatforms,
  parseTag,
  readableVersion,
  readTagMessage,
  ReleaseError,
  releaseBody,
  releaseBodyFor,
  releaseNotesExcerpt,
  releaseNotesLimit,
  resolveVersionId,
  stageFeedAssets,
  targetsWindowsDesktop,
} from "../../../scripts/ci/release-lib.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const nightly = readFileSync(join(repoRoot, "tests", "fixtures", "changelog", "nightly.md"), "utf8");
const FILE = "CHANGELOG.nightly.md";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "release-lib-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseTag and resolveVersionId", () => {
  it("reads the channel from the suffix", () => {
    expect(parseTag("v2026.11.12.13.557-nightly")).toMatchObject({ channel: "nightly", id: "v2026.11.12.13.557" });
    expect(parseTag("v2026.11.12.13.557-beta")).toMatchObject({ channel: "beta", id: "v2026.11.12.13.557" });
    expect(parseTag("v2026.11.12")).toMatchObject({ channel: "release", id: null, short: "v2026.11.12" });
  });

  it("rejects everything else, also a tag with a target in its name", () => {
    for (const bad of ["v2026.11.12.13.557", "v2026.11.12.13.557-rc1", "v2026.11.12.13.557-nightly-unraid", "2026.11.12", "latest", "v2026.11"]) {
      expect(() => parseTag(bad)).toThrow(ReleaseError);
    }
  });

  it("accepts a tag only on the commit whose version.txt carries the same id", () => {
    const txt = "v2026.11.12\nv2026.11.12.13.557\n";
    expect(resolveVersionId(parseTag("v2026.11.12.13.557-nightly"), txt)).toBe("v2026.11.12.13.557");
    expect(() => resolveVersionId(parseTag("v2026.11.12.13.558-nightly"), txt)).toThrow(/carries v2026.11.12.13.558/);
    expect(resolveVersionId(parseTag("v2026.11.12"), txt)).toBe("v2026.11.12.13.557");
    expect(() => resolveVersionId(parseTag("v2026.11.13"), txt)).toThrow(/does not match/);
    expect(() => resolveVersionId(parseTag("v2026.11.12.13.557-nightly"), "v2026.11.12\n")).toThrow(/Invalid version id/);
  });
});

describe("platform line of the tag message", () => {
  it("defaults to all without a line and reads a list", () => {
    expect(parsePlatforms("Nightly")).toEqual(["all"]);
    expect(parsePlatforms("")).toEqual(["all"]);
    expect(parsePlatforms("Nightly\n\nplatform: all\n")).toEqual(["all"]);
    expect(parsePlatforms("Beta\n\nplatform: unraid, Windows-Desktop\n")).toEqual(["unraid", "windows-desktop"]);
  });

  it("builds Windows desktop for windows-desktop and all only", () => {
    expect(targetsWindowsDesktop(["all"])).toBe(true);
    expect(targetsWindowsDesktop(["unraid", "windows-desktop"])).toBe(true);
    expect(targetsWindowsDesktop(["unraid", "docker"])).toBe(false);
  });

  it("rejects an unknown id instead of silently building nothing", () => {
    expect(() => parsePlatforms("x\n\nplatform: windows")).toThrow(/Unknown platform "windows"/);
  });

  it("reads the message of an annotated tag and notices a lightweight one", () => {
    const git = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("config", "tag.gpgsign", "false");
    writeFileSync(join(dir, "a.txt"), "a");
    git("add", ".");
    git("commit", "-q", "-m", "first");
    git("tag", "-a", "v2026.11.12.13.557-nightly", "-m", "Nightly", "-m", "platform: windows-desktop");
    git("tag", "v2026.11.13.1.1-nightly");
    const annotated = readTagMessage(dir, "v2026.11.12.13.557-nightly");
    expect(annotated.annotated).toBe(true);
    expect(parsePlatforms(annotated.message)).toEqual(["windows-desktop"]);
    expect(readTagMessage(dir, "v2026.11.13.1.1-nightly")).toEqual({ annotated: false, message: "" });
    expect(() => readTagMessage(dir, "v2026.11.14.1.1-nightly")).toThrow(/does not exist in this clone/);
  });
});

describe("customer changelog", () => {
  it("reads the frame: title and both language sections with their entries", () => {
    const parsed = parseChangelogFile(nightly);
    expect(parsed.title).toBe("Nightly Changelog (α)");
    expect(parsed.en.map((e) => e.heading)).toEqual([
      "## vNEXT α",
      "## v2026.11.14.3.120 (α) · Windows",
      "## v2026.11.13.2.80 (α)",
      "## v2026.11.12.1.40 (α)",
      "## v2026.11.11.1.30 (α)",
    ]);
    expect(parsed.de).toHaveLength(5);
    // The rule in front of the German anchor is not part of the last English entry
    expect(parsed.en[4]?.lines.at(-1)).toContain("parametric 3D CAD");
  });

  it("matches a heading with and without the platform suffix, never a longer id", () => {
    expect(headingMatches("## v2026.11.14.3.120 (α) · Windows", "v2026.11.14.3.120 (α)")).toBe(true);
    expect(headingMatches("## v2026.11.14.3.120 (α)", "v2026.11.14.3.120 (α)")).toBe(true);
    expect(headingMatches("## v2026.11.14.3.1200 (α)", "v2026.11.14.3.120 (α)")).toBe(false);
    expect(headingMatches("## v2026.11.14.3.120 (β)", "v2026.11.14.3.120 (α)")).toBe(false);
  });
});

describe("releaseBody", () => {
  it("takes only the entry of the version, grouped by area, English then German", () => {
    const id = "v2026.11.14.3.120";
    const body = releaseBody(nightly, readableVersion(id, "nightly"), FILE);
    expect(body).toBe(
      [
        "## v2026.11.14.3.120 (α) · Windows",
        "",
        "### Sketch",
        "- ✨ **New:** Draw a rectangle with two clicks.",
        "- 🔧 **Fix:** Dimensions no longer jump when the view is turned.",
        "",
        "### Bodies",
        "- 🔄 **Change:** Fillets show a preview while you type the radius.",
        "",
        "### General",
        "- 🔧 Several small bugs fixed.",
        "",
        "---",
        "",
        "## v2026.11.14.3.120 (α) · Windows",
        "",
        "### Skizze",
        "- ✨ **Neu:** Zeichne ein Rechteck mit zwei Klicks.",
        "- 🔧 **Behoben:** Maße springen nicht mehr, wenn die Ansicht gedreht wird.",
        "",
        "### Körper",
        "- 🔄 **Geändert:** Verrundungen zeigen eine Vorschau, während du den Radius eintippst.",
        "",
        "### Allgemein",
        "- 🔧 Mehrere kleine Fehler behoben.",
        "",
      ].join("\n"),
    );
    expect(body).not.toContain("v2026.11.13.2.80");
    expect(body).not.toContain("vNEXT");
  });

  it("uses the ungrouped first entry as it is", () => {
    const body = releaseBody(nightly, readableVersion("v2026.11.11.1.30", "nightly"), FILE);
    expect(body).toContain("- ✨ **New:** HalfCube is a parametric 3D CAD program.");
    expect(body).toContain("- ✨ **Neu:** HalfCube ist ein parametrisches 3D-CAD-Programm.");
    expect(body).not.toContain("###");
  });

  it("makes a maintenance-only entry the release text (it only adds nothing to What's new)", () => {
    const body = releaseBody(nightly, readableVersion("v2026.11.13.2.80", "nightly"), FILE);
    expect(body).toContain("- 🔒 Security updates of the components used.");
    expect(body).toContain("- 🔒 Sicherheitsupdates der verwendeten Komponenten.");
    expect(body).not.toContain(neutralEnglish);
  });

  it("uses the neutral text for a version without a customer entry (heading without lines)", () => {
    const body = releaseBody(nightly, readableVersion("v2026.11.12.1.40", "nightly"), FILE);
    expect(body).toBe(`${neutralEnglish}\n\n---\n\n${neutralGerman}\n`);
  });

  it("uses the neutral text, and says why, when the version has no heading in either language", () => {
    const readable = readableVersion("v2026.11.15.1.1", "nightly");
    const result = releaseBodyFor(nightly, readable, FILE);
    expect(result.body).toBe(`${neutralEnglish}\n\n---\n\n${neutralGerman}\n`);
    expect(result.kind).toBe("no-entry");
    expect(neutralNotice(result.kind, readable, FILE)).toBe(`No customer entry for ${readable} in ${FILE}. The release text is neutral.`);
    // An unstamped placeholder is no entry of this version either
    expect(releaseBodyFor(nightly, "v2026.11.20.1.1 (α)", FILE).kind).toBe("no-entry");
  });

  it("uses the neutral text when the channel file does not exist yet", () => {
    const result = releaseBodyFor(null, "v2026.11.15.1.1 (α)", FILE);
    expect(result).toEqual({ body: `${neutralEnglish}\n\n---\n\n${neutralGerman}\n`, kind: "no-file" });
    expect(neutralNotice(result.kind, "v2026.11.15.1.1 (α)", FILE)).toContain("does not exist yet");
  });

  it("logs nothing for a real entry and names an entry without lines", () => {
    const entry = releaseBodyFor(nightly, "v2026.11.14.3.120 (α)", FILE);
    expect(entry.kind).toBe("entry");
    expect(neutralNotice(entry.kind, "x", FILE)).toBeNull();
    const empty = releaseBodyFor(nightly, "v2026.11.12.1.40 (α)", FILE);
    expect(empty.kind).toBe("empty-entry");
    expect(neutralNotice(empty.kind, "v2026.11.12.1.40 (α)", FILE)).toContain("has no lines");
  });

  it("fails when the heading exists in only one language", () => {
    const noGerman = nightly.replace(/## v2026\.11\.14\.3\.120 \(α\) · Windows\n\n### Skizze/, "## v2026.11.14.3.121 (α)\n\n### Skizze");
    expect(() => releaseBody(noGerman, "v2026.11.14.3.120 (α)", FILE)).toThrow(/in the English section but not in the German section/);
    const noEnglish = nightly.replace("## v2026.11.14.3.120 (α) · Windows\n\n### Sketch", "## v2026.11.14.3.121 (α)\n\n### Sketch");
    expect(() => releaseBody(noEnglish, "v2026.11.14.3.120 (α)", FILE)).toThrow(/in the German section but not in the English section/);
  });

  it("fails when only one language has lines", () => {
    const onlyEnglish = nightly.replace("## v2026.11.12.1.40 (α)\n\n## v2026.11.11.1.30 (α)\n\n- ✨ **New:**", "## v2026.11.12.1.40 (α)\n\n- ✨ **New:** x\n\n## v2026.11.11.1.30 (α)\n\n- ✨ **New:**");
    expect(() => releaseBody(onlyEnglish, "v2026.11.12.1.40 (α)", FILE)).toThrow(/only one language/);
  });

  it("rejects a file without the language anchors", () => {
    expect(() => releaseBody("# Nightly Changelog\n\n## v2026.11.12.1.40 (α)\n- x\n", "v2026.11.12.1.40 (α)", FILE)).toThrow(/no language sections/);
  });

  it("formats the title with the project's one formatter, for all channels", () => {
    expect(readableVersion("v2026.11.12.13.557", "nightly")).toBe(formatVersion("v2026.11.12.13.557", "nightly"));
    expect(readableVersion("v2026.11.12.13.557", "nightly")).toBe("v2026.11.12.13.557 (α)");
    expect(readableVersion("v2026.11.12.13.557", "beta")).toBe("v2026.11.12.13.557 (β)");
    expect(readableVersion("v2026.11.12.13.557", "release")).toBe("v2026.11.12.13.557");
  });
});

/** A channel file with `count` entries per language, newest first, each about `lines` lines long. */
function bigChangelog(count: number, lines: number): string {
  const entries = (language: string) =>
    Array.from({ length: count }, (_, i) => {
      const n = count - i;
      const body = Array.from({ length: lines }, (_, j) => `- ✨ **New:** ${language} entry ${n} line ${j} ${"x".repeat(60)}`).join("\n");
      return `## v2026.11.${n}.1.1 (α)\n\n### Sketch\n${body}\n`;
    }).join("\n");
  return `# Nightly Changelog (α)\n\n**[English](#english) · [Deutsch](#deutsch)**\n\n---\n\n<a name="english"></a>\n## English\n\n${entries("en")}\n---\n\n<a name="deutsch"></a>\n## Deutsch\n\n${entries("de")}`;
}

describe("releaseNotesExcerpt", () => {
  const version = "v2026.11.14.3.120 (α)";

  it("keeps the frame of the channel file; a small changelog goes in whole, newest first", () => {
    const text = releaseNotesExcerpt(nightly, "nightly", version);
    const parsed = parseChangelogFile(text);
    expect(text.startsWith("# Nightly Changelog (α)\n\n**[English](#english) · [Deutsch](#deutsch)**\n\n---\n\n<a name=\"english\"></a>\n## English\n")).toBe(true);
    expect(text).toContain('---\n\n<a name="deutsch"></a>\n## Deutsch\n');
    expect(parsed.en).toHaveLength(5);
    expect(parsed.en[0]?.heading).toBe("## vNEXT α");
    expect(parsed.de).toHaveLength(5);
    expect(buildReleaseNotes(nightly, "nightly", version).entries).toBe(5);
  });

  it("cuts between entries when the limit is smaller, the same number in both languages", () => {
    const whole = releaseNotesExcerpt(nightly, "nightly", version);
    const cut = buildReleaseNotes(nightly, "nightly", null, whole.length - 1);
    expect(cut.entries).toBe(4);
    expect(cut.text.length).toBeLessThanOrEqual(whole.length - 1);
    const parsed = parseChangelogFile(cut.text);
    expect(parsed.en.map((e) => e.heading)).toEqual(parseChangelogFile(whole).en.slice(0, 4).map((e) => e.heading));
    expect(parsed.de).toHaveLength(4);
  });

  it("the entry of the version is always in, with everything newer, even over the limit", () => {
    const text = releaseNotesExcerpt(nightly, "nightly", version, 1);
    const parsed = parseChangelogFile(text);
    expect(parsed.en.map((e) => e.heading)).toEqual(["## vNEXT α", "## v2026.11.14.3.120 (α) · Windows"]);
    expect(parsed.de).toHaveLength(2);
    // without a version nothing is forced: the empty frame
    expect(parseChangelogFile(releaseNotesExcerpt(nightly, "nightly", null, 1)).en).toHaveLength(0);
    // a version without an entry forces nothing
    expect(parseChangelogFile(releaseNotesExcerpt(nightly, "nightly", "v2030.1.1.1.1 (α)", 1)).en).toHaveLength(0);
  });

  it("without a channel file it is the empty frame", () => {
    const text = releaseNotesExcerpt(null, "nightly");
    expect(text).toBe(
      '# Nightly Changelog (α)\n\n**[English](#english) · [Deutsch](#deutsch)**\n\n---\n\n<a name="english"></a>\n## English\n\n---\n\n<a name="deutsch"></a>\n## Deutsch\n',
    );
    expect(parseChangelogFile(text)).toEqual({ title: "Nightly Changelog (α)", en: [], de: [] });
  });

  it("falls back to the channel title when the file has none", () => {
    const noTitle = nightly.replace(/^# .*\n/, "");
    expect(releaseNotesExcerpt(noTitle, "nightly").startsWith("# Nightly Changelog (α)\n")).toBe(true);
    expect(releaseNotesExcerpt(noTitle, "beta").startsWith("# Beta Changelog (β)\n")).toBe(true);
  });

  it("is idempotent: the excerpt of an excerpt is the same text", () => {
    const once = releaseNotesExcerpt(nightly, "nightly", version);
    expect(releaseNotesExcerpt(once, "nightly", version)).toBe(once);
    const big = bigChangelog(400, 20);
    const cut = releaseNotesExcerpt(big, "nightly", "v2026.11.400.1.1 (α)");
    expect(releaseNotesExcerpt(cut, "nightly", "v2026.11.400.1.1 (α)")).toBe(cut);
  });

  describe("a very large changelog", () => {
    // About 12 MB of Markdown: 3000 entries of 20 lines per language, far more than the program accepts
    const big = bigChangelog(3000, 20);
    const entrySize = big.length / 6000;

    it("fits the limit, takes as many of the newest entries as fit and stays under the program's cut", () => {
      expect(big.length).toBeGreaterThan(10 * 1024 * 1024);
      const notes = buildReleaseNotes(big, "nightly", "v2026.11.3000.1.1 (α)");
      expect(notes.text.length).toBeLessThanOrEqual(releaseNotesLimit);
      expect(notes.text.length).toBeGreaterThan(releaseNotesLimit - 2 * entrySize - 1000);
      expect(notes.entries).toBeGreaterThan(50);
      expect(notes.entries).toBeLessThan(3000);
      const parsed = parseChangelogFile(notes.text);
      expect(parsed.en).toHaveLength(notes.entries);
      expect(parsed.de).toHaveLength(notes.entries);
      expect(parsed.en[0]?.heading).toBe("## v2026.11.3000.1.1 (α)");
      expect(parsed.en.at(-1)?.heading).toBe(`## v2026.11.${3000 - notes.entries + 1}.1.1 (α)`);
      // every entry is whole: the last one still ends with its last line
      expect(notes.text).toContain(`en entry ${3000 - notes.entries + 1} line 19 `);
    });

    it("keeps the entry of an old version and all the newer ones, even when that is more than the limit", () => {
      const notes = buildReleaseNotes(big, "nightly", "v2026.11.1.1.1 (α)", 5000);
      expect(notes.entries).toBe(3000);
      const small = buildReleaseNotes(big, "nightly", "v2026.11.2990.1.1 (α)", 5000);
      expect(small.entries).toBe(11);
    });

    it("runs fast (bisection, not entry by entry)", () => {
      const start = Date.now();
      buildReleaseNotes(big, "nightly", null);
      expect(Date.now() - start).toBeLessThan(5000);
    });
  });

  it("the limit stays below what the program accepts (MAX_NOTES_LENGTH in desktop/src/updates/service.ts)", () => {
    const service = readFileSync(join(repoRoot, "desktop", "src", "updates", "service.ts"), "utf8");
    const m = /MAX_NOTES_LENGTH\s*=\s*(\d+)\s*\*\s*1024/.exec(service);
    expect(m).not.toBeNull();
    expect(releaseNotesLimit).toBe(200 * 1024);
    expect(releaseNotesLimit).toBeLessThan(Number(m?.[1]) * 1024);
  });

  // The program's own parser reads it (parseChangelog is implemented by the updater work; the check starts as soon as it is)
  const parserReady = (() => {
    try {
      parseChangelog("", "en");
      return true;
    } catch {
      return false;
    }
  })();
  it.skipIf(!parserReady)("is readable by the program's parser, both languages", () => {
    const text = releaseNotesExcerpt(nightly, "nightly", version);
    expect(parseChangelog(text, "en").some((e) => e.id === "v2026.11.14.3.120")).toBe(true);
    expect(parseChangelog(text, "de").some((e) => e.id === "v2026.11.14.3.120")).toBe(true);
  });
});

describe("update feed of a release", () => {
  const asset = (v: string, type: "Full" | "Delta") => ({
    PackageId: "HalfCube",
    Version: v,
    Type: type,
    FileName: `HalfCube-${v}-nightly-${type.toLowerCase()}.nupkg`,
    SHA1: "AA",
    SHA256: "BB",
    Size: 5,
    NotesMarkdown: `notes ${v}`,
    NotesHTML: `<p>notes ${v}</p>`,
  });
  const v1 = "2026.11.8-alpha.1.100";
  const v2 = "2026.11.9-alpha.2.200";
  // What vpk pack leaves behind after a second build with the first one downloaded: the index lists every package of the channel,
  // assets.<channel>.json only what this build created
  const releasesJson = JSON.stringify({ Assets: [asset(v2, "Full"), asset(v2, "Delta"), asset(v1, "Full")] });
  const assetsJson = JSON.stringify([
    { RelativeFileName: `HalfCube-${v2}-nightly-delta.nupkg`, Type: "Delta" },
    { RelativeFileName: "HalfCube-nightly-Setup.exe", Type: "Installer" },
    { RelativeFileName: `HalfCube-${v2}-nightly-full.nupkg`, Type: "Full" },
  ]);

  it("lists the packages of this build only, without HTML, with the notes on the full package", () => {
    const { feed, files } = buildReleaseFeed(assetsJson, releasesJson);
    const parsed = JSON.parse(feed) as { Assets: { Version: string; Type: string; NotesMarkdown: string; NotesHTML: string; SHA256: string }[] };
    expect(parsed.Assets.map((a) => `${a.Version} ${a.Type}`)).toEqual([`${v2} Full`, `${v2} Delta`]);
    expect(parsed.Assets.every((a) => a.NotesHTML === "")).toBe(true);
    expect(parsed.Assets.find((a) => a.Type === "Full")?.NotesMarkdown).toBe(`notes ${v2}`);
    expect(parsed.Assets.find((a) => a.Type === "Delta")?.NotesMarkdown).toBe("");
    expect(parsed.Assets[0]?.SHA256).toBe("BB");
    expect(files.sort()).toEqual([`HalfCube-${v2}-nightly-delta.nupkg`, `HalfCube-${v2}-nightly-full.nupkg`]);
  });

  it("works for a first build without a delta and fails without a full package", () => {
    const first = buildReleaseFeed(JSON.stringify([{ RelativeFileName: `HalfCube-${v1}-nightly-full.nupkg`, Type: "Full" }]), JSON.stringify({ Assets: [asset(v1, "Full")] }));
    expect(first.files).toEqual([`HalfCube-${v1}-nightly-full.nupkg`]);
    expect(() => buildReleaseFeed("[]", releasesJson)).toThrow(/no full package/);
    expect(() => buildReleaseFeed(assetsJson, JSON.stringify({ Assets: [asset(v1, "Full")] }))).toThrow(/no full package/);
  });

  it("copies exactly the files the updater needs and no Setup.exe", () => {
    const src = join(dir, "vpk");
    const out = join(dir, "out");
    mkdirSync(src);
    for (const f of [`HalfCube-${v2}-nightly-full.nupkg`, `HalfCube-${v2}-nightly-delta.nupkg`, `HalfCube-${v1}-nightly-full.nupkg`, "HalfCube-nightly-Setup.exe"]) writeFileSync(join(src, f), f);
    writeFileSync(join(src, "assets.nightly.json"), assetsJson);
    writeFileSync(join(src, "releases.nightly.json"), releasesJson);
    const names = stageFeedAssets(src, "nightly", out);
    expect(readdirSync(out).sort()).toEqual([`HalfCube-${v2}-nightly-delta.nupkg`, `HalfCube-${v2}-nightly-full.nupkg`, "releases.nightly.json"]);
    expect(names).toContain("releases.nightly.json");
    expect(existsSync(join(out, "HalfCube-nightly-Setup.exe"))).toBe(false);
  });
});
