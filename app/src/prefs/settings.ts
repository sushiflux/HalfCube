// User settings that only the settings dialog changes (no setting control lives in the work area). Colour theme,
// light or dark and the language have their own stores (theme/, i18n/); this is the rest. Values are validated when read,
// so a stored value that no longer exists falls back to the default instead of breaking the window.
import type { Preferences } from "./preferences.ts";

export const timelineLabelModes = ["icons", "names"] as const;
/** "icons": the timeline shows only symbols; "names": symbols with the step names. */
export type TimelineLabelMode = (typeof timelineLabelModes)[number];

export const axisLabelModes = ["views", "xyz"] as const;
/** View initials (O, H, R) or X, Y, Z, for the axis navigator and the origin axes alike. */
export type AxisLabelSetting = (typeof axisLabelModes)[number];

export const sketchFillModes = ["band", "fill"] as const;
/** How a fully constrained closed loop of a sketch is highlighted: the narrow inner band or the full area. */
export type SketchFillMode = (typeof sketchFillModes)[number];

export const sketchColourModes = ["green", "blue"] as const;
/** The colour of the state "fully constrained": green (default) or blue. */
export type SketchColourMode = (typeof sketchColourModes)[number];

export const fieldLooks = ["dimension", "tag"] as const;
/**
 * How a value looks that floats at the geometry while drawing or editing a dimension: "dimension" (default) draws the
 * measuring graphics and sets the value on the dimension line, "tag" is a filled label with a thin leader line.
 */
export type FieldLook = (typeof fieldLooks)[number];

export const wheelZoomModes = ["down-out", "down-in"] as const;
/** Which way the mouse wheel zooms: "down-out" = wheel down zooms out (default), "down-in" = wheel down zooms in. */
export type WheelZoomSetting = (typeof wheelZoomModes)[number];

export interface UiSettings {
  timelineLabels: TimelineLabelMode;
  axisLabels: AxisLabelSetting;
  wheelZoom: WheelZoomSetting;
  sketchFill: SketchFillMode;
  sketchColour: SketchColourMode;
  fieldLook: FieldLook;
}

export const defaultSettings: UiSettings = {
  timelineLabels: "icons",
  axisLabels: "views",
  wheelZoom: "down-out",
  sketchFill: "band",
  sketchColour: "green",
  fieldLook: "dimension",
};

const allowed: { [K in keyof UiSettings]: readonly UiSettings[K][] } = {
  timelineLabels: timelineLabelModes,
  axisLabels: axisLabelModes,
  wheelZoom: wheelZoomModes,
  sketchFill: sketchFillModes,
  sketchColour: sketchColourModes,
  fieldLook: fieldLooks,
};

export const settingKeys = Object.keys(defaultSettings) as (keyof UiSettings)[];

const preferenceKey = (key: keyof UiSettings): string => `settings.${key}`;

export interface SettingsStore {
  getState: () => UiSettings;
  subscribe: (listener: () => void) => () => void;
  set: <K extends keyof UiSettings>(key: K, value: UiSettings[K]) => void;
  /** Back to the defaults (the settings dialog's reset). */
  reset: () => void;
}

function read(preferences: Pick<Preferences, "get">): UiSettings {
  const out = { ...defaultSettings } as Record<keyof UiSettings, string>;
  for (const key of settingKeys) {
    const stored = preferences.get(preferenceKey(key));
    if (stored !== undefined && (allowed[key] as readonly string[]).includes(stored)) out[key] = stored;
  }
  return out as unknown as UiSettings;
}

export function createSettingsStore(preferences: Pick<Preferences, "get" | "set" | "remove">): SettingsStore {
  let state = read(preferences);
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(key, value) {
      if (!(allowed[key] as readonly string[]).includes(value) || state[key] === value) return;
      state = { ...state, [key]: value };
      preferences.set(preferenceKey(key), value);
      emit();
    },
    reset() {
      for (const key of settingKeys) preferences.remove(preferenceKey(key));
      state = { ...defaultSettings };
      emit();
    },
  };
}
