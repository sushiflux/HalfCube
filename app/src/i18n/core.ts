// Translation core: no React, no DOM, so it can be tested on its own.
// German and English are fixed in the code; every other language comes only through the browser's own translation.
import type { Preferences } from "../prefs/preferences.ts";
import { de } from "./de.ts";
import { en } from "./en.ts";
import type { Language, MessageKey, MessageParams, Messages } from "./types.ts";

export const catalogues: Record<Language, Messages> = { de, en };

export const languagePreferenceKey = "language";

/** "de", "de-AT", "de_CH" -> de; everything else -> en. */
export function normalizeLanguage(tag: string | undefined): Language | undefined {
  if (!tag) return undefined;
  const base = tag.trim().toLowerCase().split(/[-_]/)[0];
  if (!base) return undefined;
  return base === "de" ? "de" : "en";
}

export interface InitialLanguageSources {
  /** A language handed over by the desktop setup (the language the user chose while installing), if any. */
  handedOver?: string | undefined;
  /** navigator.languages, most preferred first. */
  browserLanguages?: readonly string[] | undefined;
}

/** The first-start language: the setup's choice, otherwise the system/browser language (de* -> de, else en). */
export function resolveInitialLanguage(sources: InitialLanguageSources): Language {
  const handed = normalizeLanguage(sources.handedOver);
  if (handed) return handed;
  const first = sources.browserLanguages?.find((tag) => tag.trim() !== "");
  return normalizeLanguage(first) ?? "en";
}

/** Fills {name} placeholders. A placeholder without a value stays visible, so a missing parameter is easy to spot. */
export function formatMessage(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

export function lookup(messages: Messages, key: MessageKey): string {
  let node: unknown = messages;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) throw new Error(`Missing message "${key}".`);
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== "string") throw new Error(`Missing message "${key}".`);
  return node;
}

export type Translate = (key: MessageKey, params?: MessageParams) => string;

export interface I18nState {
  language: Language;
  t: Translate;
}

export interface I18nStore {
  getState: () => I18nState;
  subscribe: (listener: () => void) => () => void;
  setLanguage: (language: Language) => void;
}

export interface I18nDeps {
  preferences: Pick<Preferences, "get" | "set">;
  /** Injectable first-start language, so the desktop setup can hand its choice over later. */
  initialLanguage: () => Language;
  /** Called with the language at start and after every change (the app writes <html lang>). */
  apply?: (language: Language) => void;
  /** Dev builds only: forces a language for this page load without storing it. */
  override?: Language | undefined;
}

export function makeState(language: Language): I18nState {
  const messages = catalogues[language];
  return { language, t: (key, params) => formatMessage(lookup(messages, key), params) };
}

export function createI18nStore(deps: I18nDeps): I18nStore {
  const stored = deps.preferences.get(languagePreferenceKey);
  let language: Language;
  if (stored === "de" || stored === "en") {
    language = stored;
  } else {
    // First start: the system (or the setup) decides once, then the choice is stored.
    language = deps.initialLanguage();
    deps.preferences.set(languagePreferenceKey, language);
  }
  let state = makeState(deps.override ?? language);
  deps.apply?.(state.language);

  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setLanguage(next) {
      if (next === state.language) return;
      state = makeState(next);
      deps.preferences.set(languagePreferenceKey, next);
      deps.apply?.(next);
      for (const listener of [...listeners]) listener();
    },
  };
}

/** "de-DE" style date and time for messages that carry a time, e.g. 25.11.2026 14:32:07 / 2026-11-25 14:32:07. */
export function formatTimestamp(date: Date, language: Language): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const time = `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
  return language === "de"
    ? `${p(date.getDate())}.${p(date.getMonth() + 1)}.${date.getFullYear()} ${time}`
    : `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${time}`;
}
