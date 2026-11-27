// The pre-commit hook stamps customer headings with version, date and platforms ("## v2026.11.14.3.120 (α) · 2026-11-27 · Windows").
// The release script reads such headings the same way as the older ones without a date: entry boundaries, the entry of a version,
// the release text, Velopack's release notes. The release title on GitHub stays the version without a date.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildReleaseNotes,
  headingMatches,
  parseChangelogFile,
  releaseBodyFor,
  releaseNotesExcerpt,
} from "../../../scripts/ci/release-lib.ts";

const ID = "v2026.11.14.3.120";
const cli = join(import.meta.dirname, "..", "..", "..", "scripts", "ci", "release.ts");

const section = (anchor: string, title: string, entries: string[]) => `<a name="${anchor}"></a>\n## ${title}\n\n${entries.join("\n")}`;
const entry = (heading: string, line: string) => `## ${heading}\n\n### Sketch\n- ✨ **New:** ${line}\n`;
const changelog = (en: string[], de: string[]) =>
  `# Nightly Changelog (α)\n\n**[English](#english) · [Deutsch](#deutsch)**\n\n---\n\n${section("english", "English", en)}\n---\n\n${section("deutsch", "Deutsch", de)}`;

const dated = changelog(
  [
    entry("vNEXT α", "Next."),
    entry(`${ID} (α) · 2026-11-27 · Windows`, "Rectangle."),
    entry("v2026.11.13.2.80 (α) · 2026-11-26", "Fillet preview."),
    entry("v2026.11.12.1.40 (α)", "Old entry without a date."),
  ],
  [
    entry("vNEXT α", "Als Nächstes."),
    entry(`${ID} (α) · 2026-11-27 · Windows`, "Rechteck."),
    entry("v2026.11.13.2.80 (α) · 2026-11-26", "Verrundungsvorschau."),
    entry("v2026.11.12.1.40 (α)", "Alter Eintrag ohne Datum."),
  ],
);

describe("headings with a date", () => {
  it("headingMatches finds the version in front of the date and the platforms, with and without them", () => {
    const readable = `${ID} (α)`;
    expect(headingMatches(`## ${ID} (α) · 2026-11-27 · Windows`, readable)).toBe(true);
    expect(headingMatches(`## ${ID} (α) · 2026-11-27`, readable)).toBe(true);
    expect(headingMatches(`## ${ID} (α)`, readable)).toBe(true);
    expect(headingMatches(`## ${ID} · 2026-11-27`, ID)).toBe(true);
    // another version, another channel symbol, a longer id: no match
    expect(headingMatches("## v2026.11.14.3.1200 (α) · 2026-11-27", readable)).toBe(false);
    expect(headingMatches(`## ${ID} (β) · 2026-11-27`, readable)).toBe(false);
    expect(headingMatches(`## ${ID} (α) 2026-11-27`, readable)).toBe(false);
  });

  it("the changelog file is split at every entry heading, dated or not", () => {
    const parsed = parseChangelogFile(dated);
    expect(parsed.en.map((e) => e.heading)).toEqual([
      "## vNEXT α",
      `## ${ID} (α) · 2026-11-27 · Windows`,
      "## v2026.11.13.2.80 (α) · 2026-11-26",
      "## v2026.11.12.1.40 (α)",
    ]);
    expect(parsed.de).toHaveLength(4);
    expect(parsed.en[1]?.lines).toContain("- ✨ **New:** Rectangle.");
  });

  it("the release text carries only the entry of the version, heading as written, English then German", () => {
    const { body, kind } = releaseBodyFor(dated, `${ID} (α)`, "CHANGELOG.nightly.md");
    expect(kind).toBe("entry");
    expect(body).toContain(`## ${ID} (α) · 2026-11-27 · Windows\n`);
    expect(body).toContain("Rectangle.");
    expect(body).toContain("Rechteck.");
    expect(body).not.toContain("Fillet preview.");
    expect(body).not.toContain("Next.");
    expect(body.match(/^## /gm)).toHaveLength(2);
  });

  it("an entry that exists in only one language is still an error", () => {
    const oneSided = changelog([entry(`${ID} (α) · 2026-11-27`, "x")], [entry("v2026.11.13.2.80 (α) · 2026-11-26", "y")]);
    expect(() => releaseBodyFor(oneSided, `${ID} (α)`, "CHANGELOG.nightly.md")).toThrow(/not in the German section/);
  });

  it("Velopack's release notes keep the headings with their dates and cut only between entries", () => {
    const whole = releaseNotesExcerpt(dated, "nightly", `${ID} (α)`);
    expect(whole).toContain(`## ${ID} (α) · 2026-11-27 · Windows\n`);
    expect(whole).toContain("## v2026.11.13.2.80 (α) · 2026-11-26\n");
    expect(parseChangelogFile(whole).en).toHaveLength(4);
    const cut = buildReleaseNotes(dated, "nightly", `${ID} (α)`, 1);
    expect(cut.entries).toBe(2);
    expect(parseChangelogFile(cut.text).en.map((e) => e.heading)).toEqual(["## vNEXT α", `## ${ID} (α) · 2026-11-27 · Windows`]);
    expect(releaseNotesExcerpt(whole, "nightly", `${ID} (α)`)).toBe(whole);
  });
});

describe("release.ts with a dated changelog", () => {
  let dir: string;
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [cli, ...args, "--root", dir], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "", ...env } });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "release-dated-"));
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("config", "tag.gpgsign", "false");
    writeFileSync(join(dir, "version.txt"), `v2026.11.14\n${ID}\n`);
    writeFileSync(join(dir, "CHANGELOG.nightly.md"), dated);
    git("add", ".");
    git("commit", "-q", "-m", "x");
    git("tag", "-a", `${ID}-nightly`, "-m", "Nightly", "-m", "platform: windows-desktop");
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("info: the title is the version without a date", () => {
    const out = join(dir, "gh-output");
    const r = run(["info", "--tag", `${ID}-nightly`], { GITHUB_OUTPUT: out });
    expect(r.status).toBe(0);
    const lines = readFileSync(out, "utf8").trim().split("\n");
    expect(lines).toContain(`title=${ID} (α)`);
    expect(lines.find((l) => l.startsWith("title="))).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("body and excerpt: the entry of the tagged version is found behind its date", () => {
    const body = join(dir, "body.md");
    const notes = join(dir, "notes.md");
    const r = run(["body", "--tag", `${ID}-nightly`, "--out", body]);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain("::notice::");
    expect(readFileSync(body, "utf8")).toContain(`## ${ID} (α) · 2026-11-27 · Windows`);
    expect(run(["excerpt", "--tag", `${ID}-nightly`, "--out", notes]).status).toBe(0);
    expect(readFileSync(notes, "utf8")).toContain("## v2026.11.13.2.80 (α) · 2026-11-26");
  });
});
