import { describe, expect, it } from "vitest";
import {
  catalogues,
  createI18nStore,
  formatMessage,
  formatTimestamp,
  languagePreferenceKey,
  lookup,
  normalizeLanguage,
  resolveInitialLanguage,
} from "../../../app/src/i18n/core.ts";
import type { MessageKey } from "../../../app/src/i18n/types.ts";

/** All dotted keys of a catalogue, with the string they hold. */
function flatten(node: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof node === "string") {
    out.set(prefix, node);
  } else if (typeof node === "object" && node !== null) {
    for (const [k, v] of Object.entries(node)) {
      for (const [path, text] of flatten(v, prefix === "" ? k : `${prefix}.${k}`)) out.set(path, text);
    }
  }
  return out;
}

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();

describe("catalogue parity (the type system already rejects a missing key; this checks at run time)", () => {
  const de = flatten(catalogues.de);
  const en = flatten(catalogues.en);

  it("has the same keys in German and English", () => {
    expect([...en.keys()].sort()).toEqual([...de.keys()].sort());
  });

  it("uses the same placeholders in both languages", () => {
    const mismatched = [...de].filter(([key, text]) => placeholders(en.get(key) ?? "").join() !== placeholders(text).join());
    expect(mismatched.map(([key]) => key)).toEqual([]);
  });

  it("has no empty text except the English credit tail", () => {
    for (const [lang, map] of [["de", de], ["en", en]] as const) {
      for (const [key, text] of map) {
        if (key === "credit.after" && lang === "en") continue;
        expect(text.trim(), `${lang}.${key}`).not.toBe("");
      }
    }
  });

  it("keeps the German text apart from the English one (no key left untranslated by accident)", () => {
    const same = [...de].filter(([key, text]) => en.get(key) === text && /[a-zäöüß]{4,}/i.test(text));
    // Texts that are the same in both languages on purpose (names, code-like or template-only texts).
    const allowed = new Set([
      "theme.graphit",
      "error.meta",
      "error.environmentDesktop",
      "common.stepOf",
      "main.tree.label",
      "main.timeline.constraints.horizontal",
      "main.timeline.constraints.parallel",
      "welcome.openProjectHint",
      // "About HalfCube": tab name, channel names, the copyright line and the product name Electron read the same in both.
      "about.tabInfo",
      "about.channelNightly",
      "about.channelBeta",
      "about.copyright",
      "about.techElectron",
      // The update views: tab and section name, the link "Details", the date line of a check, the channel names and the label "Download" read the same in both.
      "main.settings.tabUpdates",
      "updates.heading",
      "updates.showDetails",
      "updates.whenDate",
      "updates.channelNightly",
      "updates.channelBeta",
      "updates.window.download",
      // Sketch tools and texts that read the same in German and English.
      "sketch.tools.horizontal",
      "sketch.tools.parallel",
      "sketch.tools.tip",
      "sketch.palette.status",
      "sketch.dim.radius",
      "sketch.reject.engineMessage",
      "sketch.dim.tip",
      "sketch.shape.spline",
      // The graphics probe line of the 3D view's error: two technical names and two filled-in words.
      "viewport.probeLine",
    ]);
    const unexpected = same.map(([key]) => key).filter((key) => !allowed.has(key));
    expect(unexpected).toEqual([]);
  });
});

describe("normalizeLanguage and the initial language", () => {
  it.each([
    ["de", "de"],
    ["de-DE", "de"],
    ["de_AT", "de"],
    ["DE-ch", "de"],
    ["en-US", "en"],
    ["fr", "en"],
    ["ja-JP", "en"],
    ["deu", "en"],
  ])("%s -> %s", (tag, expected) => {
    expect(normalizeLanguage(tag)).toBe(expected);
  });

  it("returns nothing for empty input", () => {
    expect(normalizeLanguage(undefined)).toBeUndefined();
    expect(normalizeLanguage("  ")).toBeUndefined();
  });

  it("follows the first system language (de* -> de, else en)", () => {
    expect(resolveInitialLanguage({ browserLanguages: ["de-AT", "en"] })).toBe("de");
    expect(resolveInitialLanguage({ browserLanguages: ["fr-FR", "de"] })).toBe("en");
    expect(resolveInitialLanguage({ browserLanguages: [] })).toBe("en");
    expect(resolveInitialLanguage({})).toBe("en");
  });

  it("prefers a language handed over by the desktop setup", () => {
    expect(resolveInitialLanguage({ handedOver: "en-GB", browserLanguages: ["de"] })).toBe("en");
    expect(resolveInitialLanguage({ handedOver: "de", browserLanguages: ["en"] })).toBe("de");
    expect(resolveInitialLanguage({ handedOver: "", browserLanguages: ["de"] })).toBe("de");
  });
});

describe("formatMessage and lookup", () => {
  it("fills placeholders and keeps unknown ones visible", () => {
    expect(formatMessage("{a} von {b}", { a: 5, b: "8" })).toBe("5 von 8");
    expect(formatMessage("{a} und {c}", { a: 1 })).toBe("1 und {c}");
    expect(formatMessage("no placeholders")).toBe("no placeholders");
  });

  it("looks keys up and throws for unknown ones", () => {
    expect(lookup(catalogues.en, "common.copy")).toBe("Copy");
    expect(() => lookup(catalogues.en, "common.nope" as MessageKey)).toThrow(/Missing message/);
    expect(() => lookup(catalogues.en, "common" as MessageKey)).toThrow(/Missing message/);
  });

  it("formats time stamps per language", () => {
    const d = new Date(2026, 10, 25, 14, 32, 7);
    expect(formatTimestamp(d, "de")).toBe("25.11.2026 14:32:07");
    expect(formatTimestamp(d, "en")).toBe("2026-11-25 14:32:07");
  });
});

describe("i18n store", () => {
  const memory = (initial: Record<string, string> = {}) => {
    const data = new Map(Object.entries(initial));
    return { data, get: (k: string) => data.get(k), set: (k: string, v: string) => void data.set(k, v) };
  };

  it("uses the injected initial language once and stores it", () => {
    const prefs = memory();
    const store = createI18nStore({ preferences: prefs, initialLanguage: () => "de" });
    expect(store.getState().language).toBe("de");
    expect(store.getState().t("common.copy")).toBe("Kopieren");
    expect(prefs.data.get(languagePreferenceKey)).toBe("de");
    const again = createI18nStore({ preferences: prefs, initialLanguage: () => "en" });
    expect(again.getState().language).toBe("de");
  });

  it("switches, stores, notifies and applies", () => {
    const prefs = memory();
    const applied: string[] = [];
    const store = createI18nStore({ preferences: prefs, initialLanguage: () => "en", apply: (l) => applied.push(l) });
    let calls = 0;
    store.subscribe(() => calls++);
    store.setLanguage("de");
    store.setLanguage("de");
    expect(calls).toBe(1);
    expect(store.getState().t("common.cancel")).toBe("Abbrechen");
    expect(prefs.data.get(languagePreferenceKey)).toBe("de");
    expect(applied).toEqual(["en", "de"]);
  });

  it("an override does not store anything", () => {
    const prefs = memory({ [languagePreferenceKey]: "de" });
    const store = createI18nStore({ preferences: prefs, initialLanguage: () => "de", override: "en" });
    expect(store.getState().language).toBe("en");
    expect(prefs.data.get(languagePreferenceKey)).toBe("de");
  });
});
