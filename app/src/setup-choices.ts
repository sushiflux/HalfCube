// Choices the installer writes for the first start (%APPDATA%\Partcraft\setup-choices.json). The Electron main
// process reads and validates the file and hands the result to the page; a file that is not exactly in this shape
// is ignored as a whole.

export const SETUP_CHOICES_VERSION = 1;

export type SetupLanguage = "de" | "en";
export type SetupColorMode = "light" | "dark";

export interface SetupChoices {
  version: 1;
  language: SetupLanguage;
  colorMode: SetupColorMode;
}

const KEYS = ["version", "language", "colorMode"];

/**
 * Strict check of the parsed file content. Returns the choices, or null when anything is off: not an object, an
 * unknown or missing key, another version, a value outside the allowed words.
 */
export function parseSetupChoices(raw: unknown): SetupChoices | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== KEYS.length || !KEYS.every((k) => keys.includes(k))) return null;
  const { version, language, colorMode } = raw as Record<string, unknown>;
  if (version !== SETUP_CHOICES_VERSION) return null;
  if (language !== "de" && language !== "en") return null;
  if (colorMode !== "light" && colorMode !== "dark") return null;
  return { version: SETUP_CHOICES_VERSION, language, colorMode };
}
