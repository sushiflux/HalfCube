import { describe, expect, it } from "vitest";
import { createPreferences, type PreferenceStorage } from "../../../app/src/prefs/preferences.ts";

function fakeStorage(): PreferenceStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("preferences", () => {
  it("stores values in the storage under a product prefix", () => {
    const storage = fakeStorage();
    const prefs = createPreferences(() => storage);
    prefs.set("welcome.hide", "1");
    expect(storage.data.get("partcraft.welcome.hide")).toBe("1");
    expect(prefs.get("welcome.hide")).toBe("1");
    expect(prefs.persistent).toBe(true);
    prefs.remove("welcome.hide");
    expect(prefs.get("welcome.hide")).toBeUndefined();
  });

  it("falls back to memory when the storage refuses writes", () => {
    const refusing: PreferenceStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
    };
    const prefs = createPreferences(() => refusing);
    prefs.set("a", "1");
    expect(prefs.get("a")).toBe("1");
    expect(prefs.persistent).toBe(false);
  });

  it("falls back to memory when the storage is missing or throws on access", () => {
    const none = createPreferences(() => undefined);
    none.set("a", "1");
    expect(none.get("a")).toBe("1");
    const throwing = createPreferences(() => {
      throw new Error("SecurityError");
    });
    throwing.set("b", "2");
    expect(throwing.get("b")).toBe("2");
    expect(throwing.get("missing")).toBeUndefined();
  });

  it("memory values win over stale storage values and move back when the storage works again", () => {
    const storage = fakeStorage();
    let broken = true;
    const prefs = createPreferences(() => (broken ? undefined : storage));
    prefs.set("a", "memory");
    broken = false;
    storage.data.set("partcraft.a", "stale");
    expect(prefs.get("a")).toBe("memory");
    prefs.set("a", "fresh");
    expect(prefs.get("a")).toBe("fresh");
    expect(storage.data.get("partcraft.a")).toBe("fresh");
  });
});
