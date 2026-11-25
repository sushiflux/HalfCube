// The running app's theme store and its React hook.
import { useSyncExternalStore } from "react";
import { devParams } from "../dev/params.ts";
import { getDesktopBridge } from "../platform.ts";
import { preferences } from "../prefs/preferences.ts";
import { applyThemeToDocument, createThemeStore, type ThemeState, type ThemeStore } from "./store.ts";

const params = devParams();

export const themeStore: ThemeStore = createThemeStore({
  preferences,
  // First start only: the setup's choice (light or dark) if the desktop setup left one, otherwise the system.
  prefersDark: () => {
    const chosen = getDesktopBridge()?.setupChoices?.colorMode;
    if (chosen) return chosen === "dark";
    return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  },
  apply: (state) => applyThemeToDocument(state),
  override: { ...(params.theme ? { theme: params.theme } : {}), ...(params.mode ? { mode: params.mode } : {}) },
});

export function useTheme(): ThemeState {
  return useSyncExternalStore(themeStore.subscribe, themeStore.getState, themeStore.getState);
}
