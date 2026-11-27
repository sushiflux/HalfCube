// "Was ist neu": which entries the window shows, when it opens by itself and how the sections are ordered. Pure, so the rules are
// unit-tested without a window.
import type { Language } from "../i18n/types.ts";
import type { Channel } from "../version.ts";
import { compareVersionIds, parseChangelog, type ChangelogEntry, type ChangelogSection } from "./changelog.ts";

/** The product areas of HalfCube in their fixed order (owner, 2026-11-26); "Allgemein" / "General" always comes last. */
export const productAreas: readonly Record<Language, string>[] = [
  { de: "Skizze", en: "Sketch" },
  { de: "Körper", en: "Bodies" },
  { de: "Ansicht & Navigation", en: "View & navigation" },
  { de: "Oberfläche & Einstellungen", en: "Interface & settings" },
  { de: "Installation & Updates", en: "Installation & updates" },
];

const norm = (s: string) => s.trim().toLowerCase();

/**
 * The sections of an entry in the fixed order: the ungrouped part first, then the known areas in their order, areas the list does
 * not know after them (in file order), the general maintenance section last. The sort is stable.
 */
export function orderSections(sections: readonly ChangelogSection[], language: Language): ChangelogSection[] {
  const rank = (s: ChangelogSection): number => {
    if (s.general) return 1_000_000;
    if (s.area === null) return -1;
    const known = productAreas.findIndex((a) => norm(a[language]) === norm(s.area ?? ""));
    return known >= 0 ? known : productAreas.length;
  };
  return sections.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s);
}

/** The parsed entries of a Markdown text; never throws (a text that cannot be read gives an empty list). */
export function safeParse(markdown: string, language: Language): ChangelogEntry[] {
  try {
    return parseChangelog(markdown, language);
  } catch {
    return [];
  }
}

/** Where "Was ist neu" gets its facts from: the real program or, in a dev build, the demo. */
export interface NewsSource {
  currentId: string;
  channel: Channel;
  /** A dev build never opens the window by itself, except in the demo that shows exactly this. */
  autoAllowed: boolean;
  lastShownId(): string | null;
  remember(id: string): void;
  markdown(): string;
}

/**
 * The entry of one version with at least one user line, or null: "Was ist neu" and the update window show only the entry of the
 * version that was installed or is offered, not the ones of skipped versions in between (owner, 2026-11-26). An entry with nothing but
 * general maintenance lines has no user line and counts as missing.
 */
export function entryOfVersion(markdown: string, language: Language, versionId: string): ChangelogEntry | null {
  const found = safeParse(markdown, language).find((entry) => entry.id !== null && compareVersionIds(entry.id, versionId) === 0);
  return found && found.userVisible ? found : null;
}

/** Every stamped entry of a changelog, newest first, for the dialog "Alle Änderungen" (unstamped "vNEXT" entries are left out). */
export function allEntries(markdown: string, language: Language): ChangelogEntry[] {
  return safeParse(markdown, language)
    .filter((entry) => entry.id !== null && entry.sections.some((section) => section.lines.length > 0))
    .sort((a, b) => compareVersionIds(b.id ?? "", a.id ?? ""));
}

/** The version of an entry as its heading writes it, without the date and the platforms ("v2026.11.12.13.557 (α)"). */
export function entryTitle(entry: ChangelogEntry): string {
  return entry.heading.split(" · ")[0] ?? entry.heading;
}

export type StartDecision =
  /** Open the window now. */
  | { kind: "open" }
  /** Nothing to show, but the running version counts as seen (a first installation, or an update without user lines). */
  | { kind: "remember" }
  | { kind: "none" };

export interface StartInput {
  autoAllowed: boolean;
  /** The updater is there and this program is an installed one. */
  supported: boolean;
  currentId: string;
  lastShownId: string | null;
  markdown: string;
  language: Language;
}

/**
 * First start after an update: the window opens when the running version is newer than the last shown one and the entry of the
 * running version has a user line (entries of skipped versions do not count). A first installation (nothing stored) opens nothing and stores its own version.
 */
export function decideNewsOnStart(input: StartInput): StartDecision {
  if (!input.autoAllowed || !input.supported) return { kind: "none" };
  if (input.lastShownId === null) return { kind: "remember" };
  if (compareVersionIds(input.lastShownId, input.currentId) >= 0) return { kind: "none" };
  return entryOfVersion(input.markdown, input.language, input.currentId) !== null ? { kind: "open" } : { kind: "remember" };
}

/**
 * Whether "Was ist neu" may be decided now, and whether this program counts as one that gets updates. It waits for the updater's
 * first answer and only an installed program (not a dev build, not a copy that was not installed) counts.
 */
export function newsReadiness(input: { state: { supported: boolean } | null }): { known: boolean; supported: boolean } {
  return { known: input.state !== null, supported: input.state?.supported === true };
}
