// The licence list of "About HalfCube": the project's own texts plus the generated third-party data, grouped and
// searched. Pure functions; the generated data comes in as an argument, so tests can use a fixture.
import { catalogues } from "../i18n/core.ts";
import type { Language } from "../i18n/types.ts";
import { licenceGroups, type LicenceGroup, type LicenceItem, type LocalizedText, type ThirdPartyEntry } from "./types.ts";
import { branding } from "../branding.ts";

/** The public repository (the "Source code on GitHub" link and the source of the project's own entries). */
export const REPOSITORY_URL = "https://github.com/sushiflux/HalfCube";

/** HalfCube is in early access until the first real release (ROADMAP); the label goes away by turning this off. */
export const EARLY_ACCESS = true;

/** Id of the entry that holds the HalfCube licence text; "Lizenztext anzeigen" opens it. */
export const LICENCE_ITEM: string = branding.slug;
/** Id of the entry that holds the NOTICE file; "NOTICE-Datei ansehen" opens it. */
export const NOTICE_ITEM = "notice";

const both = (pick: (messages: (typeof catalogues)["de"]) => string): LocalizedText => ({ de: pick(catalogues.de), en: pick(catalogues.en) });

/** The project's own licence texts. `version` is the running version id without the leading "v". */
export function selfItems(version: string): LicenceItem[] {
  return [
    {
      id: LICENCE_ITEM,
      group: "self",
      name: branding.name,
      version,
      license: "PolyForm-Shield-1.0.0",
      copyright: [catalogues.de.about.copyright],
      source: REPOSITORY_URL,
      purpose: both((m) => m.about.self.halfCubeUse),
      textFile: "licenses/halfcube-license.txt",
    },
    {
      id: NOTICE_ITEM,
      group: "self",
      name: "NOTICE",
      version: both((m) => m.about.self.noticeVersion),
      license: both((m) => m.about.self.noticeLicence),
      licenseLabel: both((m) => m.about.self.noticeList),
      copyright: [`Required Notice: Copyright 2026 SushiFlux (${REPOSITORY_URL})`],
      source: `${REPOSITORY_URL}/blob/main/NOTICE`,
      purpose: both((m) => m.about.self.noticeUse),
      textFile: "licenses/halfcube-notice.txt",
    },
  ];
}

export function thirdPartyItem(entry: ThirdPartyEntry): LicenceItem {
  return {
    id: entry.id,
    group: entry.group,
    name: entry.name,
    version: entry.version,
    license: entry.license,
    ...(entry.licenseLabel !== undefined ? { licenseLabel: entry.licenseLabel } : {}),
    copyright: entry.copyright,
    source: entry.source,
    purpose: entry.purpose,
    textFile: entry.textFile,
    ...(entry.note !== undefined ? { note: entry.note } : {}),
  };
}

/** Every bundled component: the project's own entries first, then the generated data in its own order. */
export function buildItems(entries: readonly ThirdPartyEntry[], version: string): LicenceItem[] {
  return [...selfItems(version), ...entries.map(thirdPartyItem)];
}

export function pickText(value: string | LocalizedText | undefined, language: Language): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : value[language];
}

/** What the right-hand side of a list row says about the licence: the friendly name when there is one, else the SPDX expression. */
export function listLicence(item: LicenceItem, language: Language): string {
  return pickText(item.licenseLabel ?? item.license, language);
}

/** Items per group in the fixed group order; a group without items is left out. */
export function groupItems(items: readonly LicenceItem[]): { group: LicenceGroup; items: LicenceItem[] }[] {
  return licenceGroups.map((group) => ({ group, items: items.filter((i) => i.group === group) })).filter((g) => g.items.length > 0);
}

/** Every word of the query has to appear somewhere in the item's texts of the given language; case does not matter. */
export function searchItems(items: readonly LicenceItem[], query: string, language: Language): LicenceItem[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "");
  if (words.length === 0) return [...items];
  return items.filter((item) => {
    const haystack = [
      item.name,
      item.id,
      pickText(item.license, language),
      pickText(item.licenseLabel, language),
      pickText(item.version, language),
      pickText(item.purpose, language),
      item.copyright.join(" "),
    ]
      .join(" ")
      .toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

export function findItem(items: readonly LicenceItem[], id: string | null | undefined): LicenceItem | undefined {
  return id ? items.find((i) => i.id === id) : undefined;
}

/**
 * The part of a copyright line that names the years and the holder: "Copyright (c) 1999-2014 OPEN CASCADE SAS" becomes
 * "1999-2014 OPEN CASCADE SAS". Lines without a year or a copyright word are free-form remarks and give null.
 */
export function holderOfCopyrightLine(line: string): string | null {
  const trimmed = line.trim();
  if (!/(copyright|\(c\)|©)/i.test(trimmed) || !/\d{4}/.test(trimmed)) return null;
  const holder = trimmed
    .replace(/^required notice:\s*/i, "")
    .replace(/^(?:(?:copyright|\(c\)|©)\s*)+/i, "")
    .replace(/\s*all rights reserved\.?$/i, "")
    .replace(/[\s.;,]+$/, "")
    .trim();
  return holder === "" ? null : holder;
}

/** A name without its trailing parenthesis: "Open CASCADE Technology (OCCT)" becomes "Open CASCADE Technology". */
export function shortName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "").trim() || name;
}

/**
 * The copyright notice of a component for the one short line: the line of its licence files that names the component's own
 * holder (a line whose holder shares a word with the component's name: "1999-2026 OPEN CASCADE SAS" for "Open CASCADE
 * Technology"; the newest one if several do), otherwise the first three holders. E-mail addresses are left out.
 */
export function compactCopyright(name: string, lines: readonly string[]): string {
  const holders = lines
    .map(holderOfCopyrightLine)
    .filter((h): h is string => h !== null)
    .map((h) => h.replace(/\s*<[^>]*>/g, "").trim());
  const words = shortName(name)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && w !== "technology");
  const endYear = (h: string) => Math.max(0, ...(h.match(/\d{4}/g) ?? []).map(Number));
  const own = holders.filter((h) => words.some((w) => h.toLowerCase().includes(w)));
  const best = own.reduce<string | undefined>((a, h) => (a === undefined || endYear(h) > endYear(a) ? h : a), undefined);
  return best ?? holders.slice(0, 3).join(", ");
}

/** The bundled components under the LGPL: their copyright notice has to be shown wherever the program shows its own (LGPL-2.1 section 6). */
export function lgplItems(items: readonly LicenceItem[]): LicenceItem[] {
  return items.filter((i) => i.group !== "self" && /\bLGPL\b/i.test(pickText(i.license, "en")));
}

/** "Open CASCADE Technology (© 1999-2026 OPEN CASCADE SAS) and planegcs (© ...)": the names for the one line on the Info tab. */
export function lgplLibraries(items: readonly LicenceItem[], and: string): string {
  const parts = lgplItems(items).map((item) => {
    const holders = compactCopyright(item.name, item.copyright);
    return holders === "" ? shortName(item.name) : `${shortName(item.name)} (© ${holders})`;
  });
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} ${and} ${parts[parts.length - 1]}`;
}

/** The kernel version for the technical details: the OCCT entry of the data. */
export function kernelVersion(items: readonly LicenceItem[]): string | null {
  const occt = items.find((i) => i.id === "occt");
  return occt && typeof occt.version === "string" ? occt.version : null;
}
