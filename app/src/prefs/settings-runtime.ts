// The running app's settings store and its React hook.
import { useSyncExternalStore } from "react";
import { preferences } from "./preferences.ts";
import { createSettingsStore, type SettingsStore, type UiSettings } from "./settings.ts";

export const settingsStore: SettingsStore = createSettingsStore(preferences);

export function useSettings(): UiSettings {
  return useSyncExternalStore(settingsStore.subscribe, settingsStore.getState, settingsStore.getState);
}
