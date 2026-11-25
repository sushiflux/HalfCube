// Theme store: which colour theme and which mode (light or dark) are active.
// Light or dark starts from the operating system exactly once and is stored then; afterwards only the user's choice
// counts. There is no "System" option. The settings dialog will call setTheme and setMode; nothing else switches themes.
import type { Preferences } from "../prefs/preferences.ts";
import { defaultThemeKey, isMode, isThemeKey, type Mode, type ThemeKey } from "./themes.ts";

export interface ThemeState {
  theme: ThemeKey;
  mode: Mode;
}

export interface ThemeStore {
  getState: () => ThemeState;
  subscribe: (listener: () => void) => () => void;
  setTheme: (theme: ThemeKey) => void;
  setMode: (mode: Mode) => void;
}

export interface ThemeStoreDeps {
  preferences: Pick<Preferences, "get" | "set">;
  /** The operating system's preference, read once on the very first start. */
  prefersDark: () => boolean;
  /** Called with the initial state and after every change (the app writes the attributes on <html>). */
  apply?: (state: ThemeState) => void;
  /** Dev builds only: forces a state for this page load without storing it. */
  override?: Partial<ThemeState>;
}

export const themePreferenceKeys = { theme: "theme.key", mode: "theme.mode" } as const;

export function createThemeStore(deps: ThemeStoreDeps): ThemeStore {
  const { preferences, prefersDark, apply, override } = deps;

  const storedTheme = preferences.get(themePreferenceKeys.theme);
  const storedMode = preferences.get(themePreferenceKeys.mode);

  const theme: ThemeKey = isThemeKey(storedTheme) ? storedTheme : defaultThemeKey;
  let mode: Mode;
  if (isMode(storedMode)) {
    mode = storedMode;
  } else {
    // First start: the system decides once, then the choice is stored and the system is not asked again.
    mode = prefersDark() ? "dark" : "light";
    preferences.set(themePreferenceKeys.mode, mode);
  }

  let state: ThemeState = { theme, mode };
  if (override) state = { theme: override.theme ?? state.theme, mode: override.mode ?? state.mode };

  const listeners = new Set<() => void>();
  const commit = (next: ThemeState, persist: Partial<Record<keyof ThemeState, string>>) => {
    if (next.theme === state.theme && next.mode === state.mode) return;
    state = next;
    if (persist.theme !== undefined) preferences.set(themePreferenceKeys.theme, persist.theme);
    if (persist.mode !== undefined) preferences.set(themePreferenceKeys.mode, persist.mode);
    apply?.(state);
    for (const listener of [...listeners]) listener();
  };

  apply?.(state);

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setTheme: (next) => commit({ ...state, theme: next }, { theme: next }),
    setMode: (next) => commit({ ...state, mode: next }, { mode: next }),
  };
}

/** Writes the state to the attributes the generated stylesheet selects on. */
export function applyThemeToDocument(state: ThemeState, root: HTMLElement = document.documentElement): void {
  root.dataset["theme"] = state.theme;
  root.dataset["mode"] = state.mode;
}
