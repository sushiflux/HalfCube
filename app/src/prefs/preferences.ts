import { branding } from "../branding.ts";
// Tiny preferences store (provisional: the real settings storage comes later).
// Values live in localStorage when it works. When the storage is missing or refuses (private mode, locked-down
// profile, quota) they stay in memory for the running session, so a failing storage never breaks the app.

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Preferences {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** False once a write had to fall back to memory. */
  readonly persistent: boolean;
}

const keyPrefix = `${branding.slug}.`;

/** `getStorage` may throw or return undefined: both mean "no storage". */
export function createPreferences(getStorage: () => PreferenceStorage | undefined): Preferences {
  const memory = new Map<string, string>();
  let persistent = true;

  const storage = (): PreferenceStorage | undefined => {
    try {
      return getStorage();
    } catch {
      return undefined;
    }
  };

  return {
    get(key) {
      const fromMemory = memory.get(key);
      if (fromMemory !== undefined) return fromMemory;
      try {
        return storage()?.getItem(keyPrefix + key) ?? undefined;
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      try {
        const target = storage();
        if (!target) throw new Error("no storage");
        target.setItem(keyPrefix + key, value);
        memory.delete(key);
      } catch {
        persistent = false;
        memory.set(key, value);
      }
    },
    remove(key) {
      memory.delete(key);
      try {
        storage()?.removeItem(keyPrefix + key);
      } catch {
        // Nothing stored that could be removed.
      }
    },
    get persistent() {
      return persistent;
    },
  };
}

/** The preferences of the running app. */
export const preferences: Preferences = createPreferences(() =>
  typeof localStorage === "undefined" ? undefined : localStorage,
);
