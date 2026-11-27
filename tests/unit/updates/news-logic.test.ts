import { describe, expect, it } from "vitest";
import { parseChangelog } from "../../../app/src/updates/changelog.ts";
import { demoChangelogMarkdown, demoIds } from "../../../app/src/updates/demo-changelog.ts";
import { allEntries, decideNewsOnStart, entryOfVersion, entryTitle, newsReadiness, orderSections } from "../../../app/src/updates/news-logic.ts";

const installed = "v2026.11.8.1.3883";
const ids = demoIds(installed);
const markdown = demoChangelogMarkdown(installed);
const base = { autoAllowed: true, supported: true, currentId: ids.offer, lastShownId: installed, markdown, language: "de" } as const;

describe("when 'Was ist neu' opens by itself", () => {
  it("opens on the first start after an update that brought user lines", () => {
    expect(decideNewsOnStart(base)).toEqual({ kind: "open" });
  });

  it("never opens on a first installation: it remembers its own version instead", () => {
    expect(decideNewsOnStart({ ...base, lastShownId: null })).toEqual({ kind: "remember" });
  });

  it("never opens in a dev build or without an installed updater", () => {
    expect(decideNewsOnStart({ ...base, autoAllowed: false })).toEqual({ kind: "none" });
    expect(decideNewsOnStart({ ...base, supported: false })).toEqual({ kind: "none" });
  });

  it("does not open again for a version that was shown, and not after a downgrade", () => {
    expect(decideNewsOnStart({ ...base, lastShownId: ids.offer })).toEqual({ kind: "none" });
    expect(decideNewsOnStart({ ...base, lastShownId: "v2026.12.1.1.1" })).toEqual({ kind: "none" });
  });

  it("remembers the version without opening when the entry of the running version has no user line", () => {
    const maintenanceOnly = [
      '<a name="english"></a>',
      "## English",
      "",
      `## ${ids.offer} (α)`,
      "",
      "### General",
      "- 🔧 Several small bugs fixed.",
      "",
    ].join("\n");
    expect(decideNewsOnStart({ ...base, markdown: maintenanceOnly, language: "en" })).toEqual({ kind: "remember" });
    // A missing changelog file (an empty text) gives the same.
    expect(decideNewsOnStart({ ...base, markdown: "" })).toEqual({ kind: "remember" });
  });

  it("does not open for skipped versions: only the running version's own entry counts, even if the skipped ones had user lines", () => {
    // The changelog has entries for the two skipped versions (with user lines) but the running version has none of its own.
    const onlyOlder = demoChangelogMarkdown(installed).split(ids.offer).join("v2026.11.99.9.9");
    expect(decideNewsOnStart({ ...base, markdown: onlyOlder })).toEqual({ kind: "remember" });
  });
});

describe("what the windows show", () => {
  it("shows only the entry of the one version, in the UI language", () => {
    const de = entryOfVersion(markdown, "de", ids.offer);
    expect(de?.id).toBe(ids.offer);
    expect(de?.sections[0]?.area).toBe("Skizze");
    expect(entryOfVersion(markdown, "en", ids.offer)?.sections[0]?.area).toBe("Sketch");
    // The entries of the skipped versions are not part of it.
    expect(entryOfVersion(markdown, "de", ids.middle)?.id).toBe(ids.middle);
    expect(entryOfVersion(markdown, "de", "v2026.11.99.1.1")).toBeNull();
  });

  it("has no entry for a version without user lines, and none for an empty text", () => {
    expect(entryOfVersion("", "de", ids.offer)).toBeNull();
    const maintenanceOnly = ['<a name="english"></a>', "## English", "", `## ${ids.offer} (α)`, "", "### General", "- 🔧 Several small bugs fixed.", ""].join("\n");
    expect(entryOfVersion(maintenanceOnly, "en", ids.offer)).toBeNull();
  });

  it("lists every entry of the channel for 'Alle Änderungen', newest first", () => {
    expect(allEntries(markdown, "de").map((e) => e.id)).toEqual([ids.offer, ids.middle, ids.oldest]);
    expect(allEntries(markdown, "en")[0]?.sections[0]?.area).toBe("Sketch");
    expect(allEntries("", "de")).toEqual([]);
  });

  it("sorts the entries even when the file is not in order, and leaves out the unstamped next entry", () => {
    const shuffled = ['<a name="english"></a>', "## English", "", "## vNEXT α", "", "### Sketch", "- ✨ **New:** Next.", "", `## ${ids.oldest} (α)`, "", "### Sketch", "- ✨ **New:** Old.", "", `## ${ids.offer} (α)`, "", "### Sketch", "- ✨ **New:** New.", ""].join("\n");
    expect(allEntries(shuffled, "en").map((e) => e.id)).toEqual([ids.offer, ids.oldest]);
  });

  it("carries the day the version came out, from the demo's stamped headings", () => {
    expect(allEntries(markdown, "de").map((e) => e.date)).toEqual(["2026-11-26", "2026-11-24", "2026-11-19"]);
    expect(allEntries(markdown, "en").map((e) => e.date)).toEqual(["2026-11-26", "2026-11-24", "2026-11-19"]);
  });

  it("titles an entry by its version only, without the date and the platforms", () => {
    const stamped = ['<a name="english"></a>', "## English", "", `## ${ids.offer} (β) · 2026-11-27 · Unraid`, "", "### Sketch", "- ✨ **New:** A.", ""].join("\n");
    const entry = entryOfVersion(stamped, "en", ids.offer);
    expect(entry?.date).toBe("2026-11-27");
    expect(entry ? entryTitle(entry) : null).toBe(`${ids.offer} (β)`);
    // A heading without a date has none to show.
    const undated = stamped.replace(" · 2026-11-27 · Unraid", "");
    expect(entryOfVersion(undated, "en", ids.offer)?.date).toBeNull();
    expect(entryTitle(entryOfVersion(undated, "en", ids.offer)!)).toBe(`${ids.offer} (β)`);
  });

  it("puts the sections in the fixed order with 'Allgemein' last", () => {
    const entry = parseChangelog(markdown, "de")[0]!;
    const shuffled = [...entry.sections].reverse();
    expect(orderSections(shuffled, "de").map((s) => s.area)).toEqual(["Skizze", "Körper", "Installation & Updates", "Allgemein"]);
    const english = parseChangelog(markdown, "en")[0]!;
    expect(orderSections([...english.sections].reverse(), "en").map((s) => s.area)).toEqual(["Sketch", "Bodies", "Installation & updates", "General"]);
  });
});

describe("'Was ist neu' in the browser version (no updater)", () => {
  it("is decided at once and counts as supported; the desktop waits for the updater's answer", () => {
    expect(newsReadiness({ bridge: false, state: null })).toEqual({ known: true, supported: true });
    expect(newsReadiness({ bridge: true, state: null })).toEqual({ known: false, supported: false });
    expect(newsReadiness({ bridge: true, state: { supported: true } })).toEqual({ known: true, supported: true });
    // A desktop program that is not an installed one (dev build, unpacked copy, portable) never shows it.
    expect(newsReadiness({ bridge: true, state: { supported: false } })).toEqual({ known: true, supported: false });
  });

  it("first visit stores the own id and shows nothing; a later visit of a newer build opens it once", () => {
    const browser = newsReadiness({ bridge: false, state: null });
    const first = decideNewsOnStart({ ...base, ...browser, lastShownId: null });
    expect(first).toEqual({ kind: "remember" });
    const later = decideNewsOnStart({ ...base, ...browser, lastShownId: installed });
    expect(later).toEqual({ kind: "open" });
    expect(decideNewsOnStart({ ...base, ...browser, lastShownId: ids.offer })).toEqual({ kind: "none" });
    // Never in a dev build.
    expect(decideNewsOnStart({ ...base, ...browser, autoAllowed: false })).toEqual({ kind: "none" });
  });
});
