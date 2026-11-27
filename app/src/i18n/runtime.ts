// The running app's translation store and its React hook.
import { useSyncExternalStore } from "react";
import { devParams } from "../dev/params.ts";
import { getDesktopBridge } from "../platform.ts";
import { preferences } from "../prefs/preferences.ts";
import { createI18nStore, resolveInitialLanguage, type I18nState, type I18nStore } from "./core.ts";
import type { Language } from "./types.ts";

/**
 * The language the user chose in the desktop setup (read from window.desktopBridge.setupChoices, already validated by
 * the main process). Undefined when the setup left no choice.
 */
export function handedOverLanguage(): string | undefined {
  return getDesktopBridge()?.setupChoices?.language;
}

export function systemInitialLanguage(): Language {
  return resolveInitialLanguage({
    handedOver: handedOverLanguage(),
    browserLanguages: typeof navigator === "undefined" ? undefined : navigator.languages,
  });
}

export const i18n: I18nStore = createI18nStore({
  preferences,
  initialLanguage: systemInitialLanguage,
  apply: (language) => {
    if (typeof document !== "undefined") document.documentElement.lang = language;
  },
  override: devParams().lang,
});

/** The current translate function and language; re-renders when the language changes. */
export function useI18n(): I18nState {
  return useSyncExternalStore(i18n.subscribe, i18n.getState, i18n.getState);
}

export function useT(): I18nState["t"] {
  return useI18n().t;
}
