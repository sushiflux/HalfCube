// Dev-only URL parameters for looking at states that are hard to reach: ?theme=graphit&mode=dark&lang=en&demo=start
// They only work in the dev channel; every other build ignores them.
import { currentVersion } from "../version.ts";
import { isMode, isThemeKey, type Mode, type ThemeKey } from "../theme/themes.ts";

export interface DevParams {
  theme?: ThemeKey;
  mode?: Mode;
  lang?: "de" | "en";
  /** Name of a demo scene, see dev/demos.tsx. */
  demo?: string;
  /** Show the calm crash page of the other channels instead of the diagnostic console. */
  calm?: boolean;
}

export function parseDevParams(search: string): DevParams {
  const q = new URLSearchParams(search);
  const out: DevParams = {};
  const theme = q.get("theme");
  if (isThemeKey(theme)) out.theme = theme;
  const mode = q.get("mode");
  if (isMode(mode)) out.mode = mode;
  const lang = q.get("lang");
  if (lang === "de" || lang === "en") out.lang = lang;
  const demo = q.get("demo");
  if (demo) out.demo = demo;
  if (q.get("calm") === "1") out.calm = true;
  return out;
}

let cached: DevParams | undefined;

export function devParams(): DevParams {
  if (cached) return cached;
  const isDev = currentVersion().channel === "dev";
  cached = isDev && typeof location !== "undefined" ? parseDevParams(location.search) : {};
  return cached;
}
