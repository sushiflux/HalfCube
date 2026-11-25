import { describe, expect, it } from "vitest";
import { createPreferences, type PreferenceStorage } from "../../../app/src/prefs/preferences.ts";
import { isWelcomeHidden, setWelcomeHidden } from "../../../app/src/screens/welcome/preference.ts";

function storage(): PreferenceStorage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("welcome screen preference", () => {
  it("shows the welcome screen at every start until the box is ticked", () => {
    const prefs = createPreferences(() => storage());
    expect(isWelcomeHidden(prefs)).toBe(false);
    expect(isWelcomeHidden(prefs)).toBe(false);
  });

  it("remembers the tick and the untick", () => {
    const shared = storage();
    const first = createPreferences(() => shared);
    setWelcomeHidden(true, first);
    expect(isWelcomeHidden(createPreferences(() => shared))).toBe(true);
    setWelcomeHidden(false, first);
    expect(isWelcomeHidden(createPreferences(() => shared))).toBe(false);
  });

  it("works for the running session even when the storage refuses", () => {
    const prefs = createPreferences(() => undefined);
    setWelcomeHidden(true, prefs);
    expect(isWelcomeHidden(prefs)).toBe(true);
  });
});
