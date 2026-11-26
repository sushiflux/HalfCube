import { describe, expect, it } from "vitest";
import { createPreferences } from "../../../app/src/prefs/preferences.ts";
import { createSettingsStore, defaultSettings } from "../../../app/src/prefs/settings.ts";

function memoryPreferences(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial).map(([k, v]) => [`halfcube.${k}`, v]));
  return {
    data,
    prefs: createPreferences(() => ({
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
    })),
  };
}

describe("settings store", () => {
  it("starts with the decided defaults: inner band, green, symbols only, view initials, wheel down zooms out, dimension-line fields", () => {
    expect(defaultSettings).toEqual({ timelineLabels: "icons", axisLabels: "views", wheelZoom: "down-out", sketchFill: "band", sketchColour: "green", fieldLook: "dimension" });
    expect(createSettingsStore(memoryPreferences().prefs).getState()).toEqual(defaultSettings);
  });

  it("stores a choice at once and reads it back in the next session", () => {
    const { prefs, data } = memoryPreferences();
    const store = createSettingsStore(prefs);
    store.set("sketchFill", "fill");
    store.set("sketchColour", "blue");
    expect(data.get("halfcube.settings.sketchFill")).toBe("fill");
    expect(createSettingsStore(prefs).getState()).toMatchObject({ sketchFill: "fill", sketchColour: "blue" });
  });

  it("the wheel zoom direction is stored, read back, and an unknown stored value falls back to the default", () => {
    const { prefs, data } = memoryPreferences();
    const store = createSettingsStore(prefs);
    expect(store.getState().wheelZoom).toBe("down-out");
    store.set("wheelZoom", "down-in");
    expect(data.get("halfcube.settings.wheelZoom")).toBe("down-in");
    expect(createSettingsStore(prefs).getState().wheelZoom).toBe("down-in");
    store.set("wheelZoom", "sideways" as "down-in");
    expect(store.getState().wheelZoom).toBe("down-in");
    expect(createSettingsStore(memoryPreferences({ "settings.wheelZoom": "sideways" }).prefs).getState().wheelZoom).toBe("down-out");
  });

  it("the look of the input fields is stored, read back, and an unknown stored value falls back to the dimension line", () => {
    const { prefs, data } = memoryPreferences();
    const store = createSettingsStore(prefs);
    expect(store.getState().fieldLook).toBe("dimension");
    store.set("fieldLook", "tag");
    expect(data.get("halfcube.settings.fieldLook")).toBe("tag");
    expect(createSettingsStore(prefs).getState().fieldLook).toBe("tag");
    store.set("fieldLook", "box" as "tag");
    expect(store.getState().fieldLook).toBe("tag");
    expect(createSettingsStore(memoryPreferences({ "settings.fieldLook": "box" }).prefs).getState().fieldLook).toBe("dimension");
  });

  it("falls back to the default for a stored value that does not exist (any more)", () => {
    const { prefs } = memoryPreferences({ "settings.sketchFill": "gradient", "settings.timelineLabels": "names" });
    expect(createSettingsStore(prefs).getState()).toMatchObject({ sketchFill: "band", timelineLabels: "names" });
  });

  it("refuses a value that is not an option and does not notify when nothing changes", () => {
    const store = createSettingsStore(memoryPreferences().prefs);
    let calls = 0;
    store.subscribe(() => calls++);
    store.set("axisLabels", "views");
    store.set("axisLabels", "nonsense" as "xyz");
    expect(calls).toBe(0);
    store.set("axisLabels", "xyz");
    expect(calls).toBe(1);
    expect(store.getState().axisLabels).toBe("xyz");
  });

  it("resets to the defaults and forgets the stored values", () => {
    const { prefs, data } = memoryPreferences();
    const store = createSettingsStore(prefs);
    store.set("timelineLabels", "names");
    store.reset();
    expect(store.getState()).toEqual(defaultSettings);
    expect([...data.keys()].filter((k) => k.includes("settings."))).toEqual([]);
  });
});
