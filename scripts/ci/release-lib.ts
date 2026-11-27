// Pure functions behind the release job of the CI workflow (.github/workflows/ci.yml) and the local installer script:
// tag parsing, the platform line of the annotated tag, the customer changelog (one entry for the release text, an excerpt for
// Velopack's release notes) and the update feed that goes into the GitHub release. Used by scripts/ci/release.ts (command
// line) and by the unit tests in tests/unit/ci/. Node only, no dependencies besides Node itself and app/src/version.ts, the
// project's one place that formats a readable version.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatVersion, parseVersionId, type Channel } from "../../app/src/version.ts";

/** Every failure the release job reports on purpose; the message says what is wrong and what to do. */
export class ReleaseError extends Error {}

export type ReleaseChannel = Exclude<Channel, "dev">;

// ---------------------------------------------------------------- tag

export interface TagInfo {
  tag: string;
  channel: ReleaseChannel;
  /** Five-segment id for nightly and beta tags (it is part of the tag name); null for a release tag (the id comes from version.txt). */
  id: string | null;
  /** The short version "vYear.Month.Commit" of a release tag, null otherwise. */
  short: string | null;
}

/** Nightly and beta: `v<five-segment id>-nightly|-beta`. Release: `v<year>.<month>.<commit>`. Anything else is rejected. */
export function parseTag(tag: string): TagInfo {
  const pre = /^(v\d+\.\d+\.\d+\.\d+\.\d+)-(nightly|beta)$/.exec(tag);
  if (pre) {
    const [, rawId = "", suffix = ""] = pre;
    return { tag, channel: suffix as ReleaseChannel, id: parseVersionId(rawId), short: null };
  }
  if (/^v\d+\.\d+\.\d+$/.test(tag)) return { tag, channel: "release", id: null, short: tag };
  throw new ReleaseError(
    `The tag "${tag}" is not a release tag. Expected v<year>.<month>.<commit>.<prompts>.<lines>-nightly, ...-beta, or v<year>.<month>.<commit> for a release.`,
  );
}

/** The five-segment id of the build the tag sits on, checked against the commit's version.txt (a tag carries its commit's version). */
export function resolveVersionId(info: TagInfo, versionTxt: string): string {
  const lines = versionTxt.split(/\r?\n/);
  const line1 = (lines[0] ?? "").trim();
  const line2 = parseVersionId(lines[1] ?? "");
  if (info.id !== null) {
    if (line2 !== info.id) {
      throw new ReleaseError(`The tag ${info.tag} carries ${info.id}, but version.txt of the tagged commit says ${line2}. A tag must carry the version of its own commit; delete the tag and tag the right commit.`);
    }
    return line2;
  }
  if (line1 !== info.short || !line2.startsWith(`${info.short}.`)) {
    throw new ReleaseError(`The tag ${info.tag} does not match version.txt of the tagged commit (${line1} / ${line2}).`);
  }
  return line2;
}

// ---------------------------------------------------------------- platform line of the annotated tag

export const platformIds = ["unraid", "docker", "linux", "windows-server", "windows-desktop"] as const;

/**
 * The ids of the line `platform: a, b` in a tag message; ["all"] without such a line or with `all`.
 * An unknown id is an error, so a typo never silently builds nothing.
 */
export function parsePlatforms(message: string): string[] {
  const line = /^platform:[ \t]*(.*)$/im.exec(message);
  if (!line) return ["all"];
  const ids = (line[1] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
  if (ids.length === 0 || ids.includes("all")) return ["all"];
  const unknown = ids.filter((id) => !(platformIds as readonly string[]).includes(id));
  if (unknown.length > 0) {
    throw new ReleaseError(`Unknown platform "${unknown.join(", ")}" in the tag message. Valid: ${platformIds.join(", ")}, all.`);
  }
  return [...new Set(ids)];
}

export function targetsWindowsDesktop(platforms: readonly string[]): boolean {
  return platforms.includes("all") || platforms.includes("windows-desktop");
}

/** The message of a tag in a local clone. `annotated` is false for a lightweight tag (checkout flattened it, or it never had a message). */
export function readTagMessage(root: string, tag: string): { annotated: boolean; message: string } {
  const run = (format: string) =>
    spawnSync("git", ["-C", root, "for-each-ref", `--format=${format}`, `refs/tags/${tag}`], { encoding: "utf8" });
  const type = run("%(objecttype)");
  if (type.status !== 0 || type.stdout.trim() === "") {
    throw new ReleaseError(`The tag ${tag} does not exist in this clone (${type.stderr.trim() || "no output"}). Fetch it first: git fetch --force origin +refs/tags/${tag}:refs/tags/${tag}`);
  }
  if (type.stdout.trim() !== "tag") return { annotated: false, message: "" };
  const contents = run("%(contents)");
  return { annotated: true, message: contents.stdout };
}

// ---------------------------------------------------------------- customer changelog

export const changelogFiles: Record<ReleaseChannel, string> = {
  nightly: "CHANGELOG.nightly.md",
  beta: "CHANGELOG.beta.md",
  release: "CHANGELOG.md",
};

/** The readable version of a build, from the project's one formatter. */
export function readableVersion(id: string, channel: ReleaseChannel): string {
  return formatVersion(id, channel);
}

const defaultTitles: Record<ReleaseChannel, string> = {
  nightly: "Nightly Changelog (α)",
  beta: "Beta Changelog (β)",
  release: "Changelog",
};

export const neutralEnglish = "No user-visible changes.";
export const neutralGerman = "Keine sichtbaren Änderungen.";

export interface Entry {
  /** The heading line as written, e.g. "## v2026.11.12.13.557 (α) · Windows". */
  heading: string;
  /** Everything up to the next entry, without leading or trailing blank lines and a trailing rule. */
  lines: string[];
}

export interface ChangelogFile {
  /** The "# ..." title of the file, null when there is none. */
  title: string | null;
  en: Entry[];
  de: Entry[];
}

const anchorPattern = /^<a\s+(?:name|id)="(english|deutsch)"\s*>\s*<\/a>/i;
const languageHeadings = new Set(["English", "Deutsch"]);

function trimBlock(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && (out[out.length - 1] ?? "").trim() === "") out.pop();
  while (out.length > 0 && (out[out.length - 1] ?? "").trim() === "---") {
    out.pop();
    while (out.length > 0 && (out[out.length - 1] ?? "").trim() === "") out.pop();
  }
  while (out.length > 0 && (out[0] ?? "").trim() === "") out.shift();
  return out;
}

/** Splits a customer changelog (frame: title, link line, then the anchors english and deutsch) into its entries, newest first as written. */
export function parseChangelogFile(markdown: string): ChangelogFile {
  const result: ChangelogFile = { title: null, en: [], de: [] };
  let language: "en" | "de" | null = null;
  let afterAnchor = false;
  let current: Entry | null = null;
  let sawAnchor = false;
  const finish = () => {
    if (current && language) {
      current.lines = trimBlock(current.lines);
      result[language].push(current);
    }
    current = null;
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const anchor = anchorPattern.exec(raw);
    if (anchor) {
      finish();
      const [, name = ""] = anchor;
      language = name.toLowerCase() === "english" ? "en" : "de";
      afterAnchor = true;
      sawAnchor = true;
      continue;
    }
    if (language === null) {
      const title = /^# (.+?)\s*$/.exec(raw);
      if (title?.[1] !== undefined && result.title === null) result.title = title[1];
      continue;
    }
    const heading = /^## (.+?)\s*$/.exec(raw);
    if (heading) {
      if (afterAnchor && languageHeadings.has(heading[1] ?? "")) {
        afterAnchor = false;
        continue;
      }
      afterAnchor = false;
      finish();
      current = { heading: raw.trimEnd(), lines: [] };
      continue;
    }
    if (raw.trim() !== "") afterAnchor = false;
    if (current) current.lines.push(raw);
  }
  finish();
  if (!sawAnchor) {
    throw new ReleaseError('The changelog has no language sections. Expected <a name="english"></a> and <a name="deutsch"></a> as in the channel file frame.');
  }
  return result;
}

export function headingMatches(headingLine: string, readable: string): boolean {
  const heading = headingLine.replace(/^##\s+/, "").trim();
  return heading === readable || heading.startsWith(`${readable} · `);
}

function findEntry(entries: readonly Entry[], readable: string): Entry | undefined {
  return entries.find((e) => headingMatches(e.heading, readable));
}

function entryText(entry: Entry): string {
  return [entry.heading, ...(entry.lines.length > 0 ? ["", ...entry.lines] : [])].join("\n");
}

/** No customer entry: the heading stands, nothing below it. */
export function isEmptyEntry(entry: Entry): boolean {
  return entry.lines.every((l) => l.trim() === "" || l.trim() === "---");
}

/** Why the release text is what it is; the workflow logs the two neutral cases. */
export type BodyKind = "entry" | "empty-entry" | "no-entry" | "no-file";

export interface ReleaseBody {
  body: string;
  kind: BodyKind;
}

const neutralBody = `${neutralEnglish}\n\n---\n\n${neutralGerman}\n`;

function missingInOneLanguage(file: string, readable: string, present: string, absent: string): ReleaseError {
  return new ReleaseError(
    `${file} has the entry "## ${readable}" in the ${present} section but not in the ${absent} section. Both languages carry the same entry.`,
  );
}

/**
 * The body of the GitHub release: only the entry of this version, English, a rule, German.
 * A build without a customer entry (no heading in either language, a heading without lines, or no channel file yet) gets the neutral
 * text; an entry that holds only maintenance lines is the release text like any other. An entry in only one language is an error.
 * `markdown` is null when the channel file does not exist.
 */
export function releaseBodyFor(markdown: string | null, readable: string, file: string): ReleaseBody {
  if (markdown === null) return { body: neutralBody, kind: "no-file" };
  const parsed = parseChangelogFile(markdown);
  const en = findEntry(parsed.en, readable);
  const de = findEntry(parsed.de, readable);
  if (!en && !de) return { body: neutralBody, kind: "no-entry" };
  if (!en) throw missingInOneLanguage(file, readable, "German", "English");
  if (!de) throw missingInOneLanguage(file, readable, "English", "German");
  const enEmpty = isEmptyEntry(en);
  const deEmpty = isEmptyEntry(de);
  if (enEmpty !== deEmpty) {
    throw new ReleaseError(`The entry "## ${readable}" of ${file} has lines in only one language. Both languages carry the same entry.`);
  }
  if (enEmpty) return { body: neutralBody, kind: "empty-entry" };
  return { body: `${entryText(en)}\n\n---\n\n${entryText(de)}\n`, kind: "entry" };
}

export function releaseBody(markdown: string | null, readable: string, file: string): string {
  return releaseBodyFor(markdown, readable, file).body;
}

/** The line the workflow logs when the release text is neutral; null when the entry is used. */
export function neutralNotice(kind: BodyKind, readable: string, file: string): string | null {
  switch (kind) {
    case "entry":
      return null;
    case "no-file":
      return `No customer entry for ${readable}: ${file} does not exist yet. The release text is neutral.`;
    case "no-entry":
      return `No customer entry for ${readable} in ${file}. The release text is neutral.`;
    case "empty-entry":
      return `The customer entry for ${readable} in ${file} has no lines. The release text is neutral.`;
  }
}

/**
 * Size limit of Velopack's release notes, in characters. The program cuts notes at 256 KB (MAX_NOTES_LENGTH in
 * desktop/src/updates/service.ts); 200 KB leaves room for the frame and for the cut at a line break. A test keeps both numbers apart.
 */
export const releaseNotesLimit = 200 * 1024;

export interface ReleaseNotes {
  text: string;
  /** How many entries per language the text carries (the languages can differ in length, this is the larger count taken). */
  entries: number;
}

/**
 * Velopack's release notes: the channel file's own frame (title, link line, English section, German section) with the newest entries
 * per language, as many as fit `maxLength` characters, so the program's parser reads it like the shipped file and the app can show the
 * channel's whole recent history from the notes of the new version (the "all changes" dialog of the update window).
 * Cut only between entries, the same number in both languages. The entry of `readable` (this build's version) is always in, with
 * everything newer than it, even when that alone is over the limit. `markdown` is null when the channel file does not exist: the frame
 * with empty sections.
 */
export function buildReleaseNotes(markdown: string | null, channel: ReleaseChannel, readable: string | null = null, maxLength = releaseNotesLimit): ReleaseNotes {
  const parsed: ChangelogFile = markdown === null ? { title: null, en: [], de: [] } : parseChangelogFile(markdown);
  const section = (anchor: string, title: string, entries: Entry[]) =>
    [`<a name="${anchor}"></a>`, `## ${title}`, "", ...entries.map((e) => `${entryText(e)}\n`)].join("\n").trimEnd();
  const render = (count: number) =>
    [
      `# ${parsed.title ?? defaultTitles[channel]}`,
      "",
      "**[English](#english) · [Deutsch](#deutsch)**",
      "",
      "---",
      "",
      section("english", "English", parsed.en.slice(0, count)),
      "",
      "---",
      "",
      section("deutsch", "Deutsch", parsed.de.slice(0, count)),
      "",
    ].join("\n");
  const all = Math.max(parsed.en.length, parsed.de.length);
  // Everything up to and including this version's entry, in either language
  const required =
    readable === null ? 0 : Math.max(...[parsed.en, parsed.de].map((entries) => entries.findIndex((e) => headingMatches(e.heading, readable)) + 1));
  // The text only grows with the count, so the largest count under the limit is found by bisection (a changelog can be huge)
  let low = Math.min(required, all);
  let high = all;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (render(mid).length <= maxLength) low = mid;
    else high = mid - 1;
  }
  return { text: render(low), entries: low };
}

/** The text of `buildReleaseNotes`. */
export function releaseNotesExcerpt(markdown: string | null, channel: ReleaseChannel, readable: string | null = null, maxLength = releaseNotesLimit): string {
  return buildReleaseNotes(markdown, channel, readable, maxLength).text;
}

// ---------------------------------------------------------------- update feed of the release

interface FeedAsset {
  PackageId?: string;
  Version?: string;
  Type?: string;
  FileName?: string;
  SHA1?: string;
  SHA256?: string;
  Size?: number;
  NotesMarkdown?: string;
  NotesHTML?: string;
}

/**
 * The feed one release carries (`releases.<channel>.json`): the full package and the delta of this build, like `vpk upload` writes
 * it (the assets of this build only, not the older packages that were downloaded for the delta). Every client reads this file of each
 * of the newest GitHub releases on every check, so the notes stay small: no HTML (the program reads the Markdown), and only the full
 * package carries the Markdown (it is the target of an update; a missing field reads as empty in Velopack's Rust library, manager.rs).
 */
export function buildReleaseFeed(assetsJson: string, releasesJson: string): { feed: string; files: string[] } {
  const built = JSON.parse(assetsJson.replace(/^﻿/, "")) as { RelativeFileName?: string; Type?: string }[];
  const all = (JSON.parse(releasesJson.replace(/^﻿/, "")) as { Assets?: FeedAsset[] }).Assets ?? [];
  const wanted = built.filter((a) => a.Type === "Full" || a.Type === "Delta").map((a) => a.RelativeFileName ?? "");
  const assets = all.filter((a) => wanted.includes(a.FileName ?? "")).map((a) => ({ ...a, NotesHTML: "", NotesMarkdown: a.Type === "Full" ? (a.NotesMarkdown ?? "") : "" }));
  if (!assets.some((a) => a.Type === "Full")) {
    throw new ReleaseError("The Velopack output has no full package of this build in its releases file; nothing to publish.");
  }
  const missing = wanted.filter((w) => !assets.some((a) => a.FileName === w));
  if (missing.length > 0) throw new ReleaseError(`The releases file of Velopack does not list ${missing.join(", ")}.`);
  return { feed: JSON.stringify({ Assets: assets }), files: wanted };
}

/** Copies what the updater needs into `outDir`: the packages of this build and the feed. Returns the file names. */
export function stageFeedAssets(velopackDir: string, channel: string, outDir: string): string[] {
  const feedName = `releases.${channel}.json`;
  const { feed, files } = buildReleaseFeed(readFileSync(join(velopackDir, `assets.${channel}.json`), "utf8"), readFileSync(join(velopackDir, feedName), "utf8"));
  mkdirSync(outDir, { recursive: true });
  for (const f of files) copyFileSync(join(velopackDir, f), join(outDir, f));
  writeFileSync(join(outDir, feedName), feed);
  return [...files, feedName];
}

// ---------------------------------------------------------------- build info baked into the bundles

/** A build id and channel as the bundler baked them into a bundle (`__BUILD_INFO__`, see config/build-info.ts). */
export interface BakedBuildInfo {
  id: string;
  channel: string;
}

// The web bundle is minified (`{id:`v2026.11.8.1.3883`,channel:`dev`}`), the desktop bundle is not (`"id": "v...", "channel": "dev"`).
// One pattern covers both: optional quotes around the keys, any of the three quote kinds around the values.
const bakedBuildInfo = /["']?\bid["']?\s*:\s*[`'"](v\d+(?:\.\d+){4})[`'"]\s*,\s*["']?channel["']?\s*:\s*[`'"](dev|nightly|beta|release)[`'"]/g;

function bundleScripts(path: string): string[] {
  const stat = statSync(path);
  if (!stat.isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((e) => {
    const full = join(path, e.name);
    if (e.isDirectory()) return bundleScripts(full);
    return /\.(?:js|cjs|mjs)$/.test(e.name) ? [full] : [];
  });
}

/** Every id/channel pair baked into the scripts below `path` (a bundle file or a folder). */
export function readBakedBuildInfo(path: string): BakedBuildInfo[] {
  const found: BakedBuildInfo[] = [];
  for (const file of bundleScripts(path)) {
    for (const m of readFileSync(file, "utf8").matchAll(bakedBuildInfo)) found.push({ id: m[1] ?? "", channel: m[2] ?? "" });
  }
  return found;
}

/**
 * Whether the bundles in `_build` were built for this id and channel. The web bundle and the desktop bundle are shared with the local
 * dev start script (scripts/dev.ps1), so a bundle can come from another build than the one the installer script just started.
 * Returns null when every given bundle carries exactly the expected pair, else the problem as a sentence. A bundle without any baked pair is
 * a problem too (the check never passes silently when the bundler changes its output).
 */
export function checkBundleBuildInfo(bundles: Record<string, string>, expected: BakedBuildInfo): string | null {
  for (const [label, path] of Object.entries(bundles)) {
    if (!existsSync(path)) return `The ${label} bundle is missing: ${path}`;
    const found = readBakedBuildInfo(path);
    if (found.length === 0) {
      return `The ${label} bundle (${path}) carries no build id and channel; the bundler's output may have changed (see readBakedBuildInfo in scripts/ci/release-lib.ts).`;
    }
    const wrong = found.filter((f) => f.id !== expected.id || f.channel !== expected.channel);
    if (wrong.length > 0) {
      const shown = [...new Set(wrong.map((f) => `${f.id} / ${f.channel}`))].join(", ");
      return `The ${label} bundle (${path}) was built for ${shown}, this build is ${expected.id} / ${expected.channel}.`;
    }
  }
  return null;
}
