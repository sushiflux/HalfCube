// Parser for the bilingual customer changelogs (CHANGELOG.nightly.md, CHANGELOG.beta.md, CHANGELOG.md) and the excerpts the
// releases carry. Used by "Was ist neu", the preview in the update window and the release-notes script of CI.
//
// File frame: title, a link line, `<a name="english"></a>` + `## English`, the entries, then `<a name="deutsch"></a>` +
// `## Deutsch` and the same entries in German. An entry is `## v2026.11.12.13.557 (α)` (or the unstamped `## vNEXT α`),
// followed by `### <product area>` headings and bullet lines `- ✨ **New:** text`. Maintenance lines under `### General`
// carry no label (`- 🔧 Several small bugs fixed.`). The first entry of a file is ungrouped.
//
// The parser is forgiving on purpose: the text comes from files and release bodies, and a malformed part must never take
// "Was ist neu" down. Whatever cannot be understood is skipped.
import type { Language } from "../i18n/types.ts";

export type ChangelogCategory = "new" | "change" | "fix" | "security" | "removed" | "deprecated";

export interface ChangelogLine {
  /** The badge of the line; null for a line without a category (e.g. general maintenance lines). */
  category: ChangelogCategory | null;
  /** The line's text as inline Markdown, without the category label. */
  text: string;
}

export interface ChangelogSection {
  /** The product area as written in the file ("Skizze", "Sketch", ...); null for the ungrouped first entry. */
  area: string | null;
  /** True for the "Allgemein" / "General" section of maintenance lines. */
  general: boolean;
  lines: ChangelogLine[];
}

export interface ChangelogEntry {
  /** Five-segment id from the stamped heading, e.g. "v2026.11.12.4.4410"; null for an unstamped "vNEXT" heading. */
  id: string | null;
  /** The heading as written, without the leading "## ". */
  heading: string;
  /** ISO date ("2026-11-27") the commit stamped after the version ("## v2026.11.12.4.4410 (α) · 2026-11-27 · Unraid"); null when the heading has none. */
  date: string | null;
  sections: ChangelogSection[];
  /** True when the entry has at least one line outside the general maintenance section ("Was ist neu" shows only these). */
  userVisible: boolean;
}

/** Category label words of both languages (lower case, without the colon) and what they mean. */
const categoryWords: Readonly<Record<string, ChangelogCategory>> = {
  new: "new",
  neu: "new",
  change: "change",
  changed: "change",
  geändert: "change",
  fix: "fix",
  fixed: "fix",
  behoben: "fix",
  security: "security",
  sicherheit: "security",
  removed: "removed",
  entfernt: "removed",
  deprecated: "deprecated",
  veraltet: "deprecated",
};

const generalNames = new Set(["general", "allgemein"]);

/** The first " · " segment after the version when it is a real ISO date, else null (an entry without a date shows none). */
function headingDate(heading: string): string | null {
  const part = heading.split(" · ")[1]?.trim() ?? "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(part);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const real = d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
  return real ? part : null;
}

const stampedId = /^v(\d+)\.(\d+)\.(\d+)\.(\d+)\.(\d+)(?![\d.])/;

/** Emoji (with variation selector or joiner) and spaces at the start of a text; quotes and digits are kept. */
const leadingDecoration = /^(?:\p{Extended_Pictographic}|\p{Variation_Selector}|\p{Join_Control}|\p{Me}|\s)+/u;

function categoryOf(word: string): ChangelogCategory | null {
  return categoryWords[word.trim().toLowerCase()] ?? null;
}

/** "✨ New" / "🔄 Geändert" as a heading: a category block of the old ungrouped layout, not a product area. */
function categoryFromHeading(heading: string): ChangelogCategory | null {
  return categoryOf(heading.replace(leadingDecoration, ""));
}

/** Splits `**New:** text` or `**New**: text` off the front of a line's text. */
function splitLabel(text: string): { category: ChangelogCategory; rest: string } | null {
  // The label word is taken greedily up to the first "*" or ":" and trimmed by categoryOf; a lazy word followed by "\s*" would try
  // every split of a long run of spaces (quadratic on a crafted line of the network feed's release notes).
  const match = /^\*\*([^*:]+):\s*\*\*\s*(.*)$/su.exec(text) ?? /^\*\*([^*:]+)\*\*\s*:\s*(.*)$/su.exec(text);
  if (!match) return null;
  const category = categoryOf(match[1] ?? "");
  return category === null ? null : { category, rest: (match[2] ?? "").trim() };
}

function makeLine(raw: string, fallback: ChangelogCategory | null): ChangelogLine | null {
  const withoutDecoration = raw.trim().replace(leadingDecoration, "").trim();
  if (withoutDecoration === "") return null;
  const labelled = splitLabel(withoutDecoration);
  if (labelled) return labelled.rest === "" ? null : { category: labelled.category, text: labelled.rest };
  return { category: fallback, text: withoutDecoration };
}

/** The part of the file for one language; the whole text when the file has no language headings at all (an excerpt). */
function languageLines(lines: readonly string[], language: Language): string[] {
  const wanted = language === "de" ? "deutsch" : "english";
  let sawLanguageHeading = false;
  let current: string | null = null;
  const picked: string[] = [];
  for (const line of lines) {
    const heading = /^##\s+(English|Deutsch)\s*$/i.exec(line);
    if (heading) {
      sawLanguageHeading = true;
      current = (heading[1] ?? "").toLowerCase();
      continue;
    }
    if (current === wanted) picked.push(line);
  }
  return sawLanguageHeading ? picked : [...lines];
}

/** All entries of one language section, newest first. Unknown or malformed parts are skipped, never thrown. */
export function parseChangelog(markdown: string, language: Language): ChangelogEntry[] {
  if (typeof markdown !== "string" || markdown === "") return [];
  const entries: ChangelogEntry[] = [];

  let entry: ChangelogEntry | null = null;
  let section: ChangelogSection | null = null;
  /** Category given by an old-style "### ✨ New" heading; applies to unlabelled lines below it. */
  let headingCategory: ChangelogCategory | null = null;
  let lastLine: ChangelogLine | null = null;
  /** True right after a blank line or a heading: an unindented text line then starts a paragraph of its own. */
  let atBlock = true;

  const ensureSection = (): ChangelogSection | null => {
    if (!entry) return null;
    if (!section) {
      section = { area: null, general: false, lines: [] };
      entry.sections.push(section);
    }
    return section;
  };

  for (const rawLine of languageLines(markdown.split(/\r?\n/), language)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    // "## ..." starts an entry; any other level-2 heading (or stray anchor) ends the current one.
    const entryHeading = /^##\s+(.*\S)\s*$/.exec(line);
    if (entryHeading) {
      const heading = entryHeading[1] ?? "";
      const stamped = stampedId.exec(heading);
      const unstamped = /^vNEXT(?![\w.])/i.test(heading);
      lastLine = null;
      section = null;
      headingCategory = null;
      atBlock = true;
      if (stamped) {
        entry = { id: `v${stamped[1]}.${stamped[2]}.${stamped[3]}.${stamped[4]}.${stamped[5]}`, heading, date: headingDate(heading), sections: [], userVisible: false };
        entries.push(entry);
      } else if (unstamped) {
        entry = { id: null, heading, date: headingDate(heading), sections: [], userVisible: false };
        entries.push(entry);
      } else {
        entry = null;
      }
      continue;
    }
    if (!entry) continue;

    const subHeading = /^###\s+(.*\S)\s*$/.exec(line);
    if (subHeading) {
      const title = (subHeading[1] ?? "").trim();
      lastLine = null;
      atBlock = true;
      const asCategory = categoryFromHeading(title);
      if (asCategory) {
        // The old ungrouped layout: the category is a heading, the lines have no label.
        headingCategory = asCategory;
        section = entry.sections.find((s) => s.area === null) ?? null;
        if (!section) {
          section = { area: null, general: false, lines: [] };
          entry.sections.push(section);
        }
      } else {
        headingCategory = null;
        const name = title.replace(leadingDecoration, "").trim();
        section = { area: title, general: generalNames.has(name.toLowerCase()), lines: [] };
        entry.sections.push(section);
      }
      continue;
    }
    // Deeper headings, rules and anchors carry no lines.
    if (/^#{4,}\s/.test(line) || /^<a\s+name=/i.test(trimmed) || /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      lastLine = null;
      atBlock = true;
      continue;
    }

    if (trimmed === "") {
      atBlock = true;
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const target = ensureSection();
      const made = makeLine(bullet[1] ?? "", headingCategory);
      lastLine = null;
      atBlock = false;
      if (target && made) {
        target.lines.push(made);
        lastLine = made;
      }
      continue;
    }

    // A text line that is not a bullet: a wrapped continuation of the previous line, or a paragraph of its own.
    const continuation = lastLine !== null && (!atBlock || /^\s/.test(line));
    if (continuation && lastLine) {
      lastLine.text = `${lastLine.text} ${trimmed}`;
      atBlock = false;
      continue;
    }
    const target = ensureSection();
    const made = makeLine(trimmed, headingCategory);
    atBlock = false;
    lastLine = null;
    if (target && made) {
      target.lines.push(made);
      lastLine = made;
    }
  }

  for (const found of entries) {
    // Sections without any line (an area heading with nothing below it) say nothing.
    found.sections = found.sections.filter((s) => s.lines.length > 0);
    found.userVisible = found.sections.some((s) => !s.general);
  }
  return entries;
}

export interface InlineToken {
  kind: "text" | "strong" | "code" | "em" | "link";
  /** The visible text, without the Markdown marks; for a link only its text (the address is dropped). */
  text: string;
}

// Every alternative stops at the next character that could open or close it ("[" and "]" inside link text, "(" and ")" inside
// the address), so a line of thousands of "[" or "[a](" cannot make the search quadratic. Release notes come from the network feed.
const inlinePattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\[[^[\]]+\]\([^()]*\))/g;

/** Inline Markdown of a changelog line: **bold**, *italic*, `code` and [links]; everything else is plain text. */
export function inlineTokens(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  let last = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
    const token = match[0];
    if (token.startsWith("**")) out.push({ kind: "strong", text: token.slice(2, -2) });
    else if (token.startsWith("`")) out.push({ kind: "code", text: token.slice(1, -1) });
    else if (token.startsWith("[")) out.push({ kind: "link", text: token.slice(1, token.indexOf("](")) });
    else out.push({ kind: "em", text: token.slice(1, -1) });
    last = at + token.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** Year, month and commit of the year of an id ("v2026.11.12" or the five-segment form); null when unreadable. */
function orderingKey(id: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?![\d])/.exec(id.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** -1, 0 or 1: order of two five-segment ids by year, month and commit of the year (the last two segments do not order). */
export function compareVersionIds(a: string, b: string): number {
  const keyA = orderingKey(a);
  const keyB = orderingKey(b);
  // An id that cannot be read sorts before every readable one; two unreadable ones are equal.
  if (keyA === null || keyB === null) return keyA === keyB ? 0 : keyA === null ? -1 : 1;
  for (let i = 0; i < 3; i++) {
    const diff = (keyA[i] ?? 0) - (keyB[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}
