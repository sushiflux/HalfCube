import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../../../config/build-info.ts";
import { contrastRatio, evaluatePairs, parseHex } from "../../../app/src/theme/contrast.ts";
import { buildThemeCss, kebab } from "../../../app/src/theme/css.ts";
import { createThemeStore, themePreferenceKeys, type ThemeState } from "../../../app/src/theme/store.ts";
import {
  colourTokenNames,
  defaultThemeKey,
  getTheme,
  isMode,
  isThemeKey,
  modes,
  themeKeys,
  themes,
} from "../../../app/src/theme/themes.ts";

const hex = /^#[0-9a-f]{6}$/;

describe("theme data", () => {
  it("has the seven themes, Präzision is the default", () => {
    expect(themeKeys).toHaveLength(7);
    expect(defaultThemeKey).toBe("praezision");
    expect(themes.filter((t) => t.isDefault).map((t) => t.key)).toEqual(["praezision"]);
  });

  it.each(themes.map((t) => t.key))("%s has every token in light and dark as #rrggbb", (key) => {
    const theme = getTheme(key);
    for (const mode of modes) {
      for (const name of colourTokenNames) expect(theme.tokens[mode][name], `${key}.${mode}.${name}`).toMatch(hex);
    }
  });

  it("recognises keys and modes", () => {
    expect(isThemeKey("graphit")).toBe(true);
    expect(isThemeKey("unknown")).toBe(false);
    expect(isMode("dark")).toBe(true);
    expect(isMode("system")).toBe(false);
  });
});

describe("contrast maths", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // #767676 on white is the classic 4.54:1 case.
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });
});

/**
 * Accepted exceptions, owner decision of 2026-11-24 (written down in the project rules, "Look and themes"):
 * in High contrast light the wordmark's "craft" reaches only 4.98:1 instead of 7:1.
 * The other two accepted points are not contrast numbers (Farbsicher toggles are blue/orange; the sharpened line colours
 * of the first two themes are their defaults).
 */
const accepted: Record<string, { atLeast: number }> = {
  "kontrast/light/m2": { atLeast: 4.5 },
};

describe("contrast of every theme in both modes", () => {
  for (const theme of themes) {
    for (const mode of modes) {
      it(`${theme.key} ${mode}: text 4.5:1, UI and lines 3:1 (High contrast: 7:1 and 4.5:1)`, () => {
        const failures: string[] = [];
        for (const result of evaluatePairs(theme, mode)) {
          const exception = accepted[`${theme.key}/${mode}/${result.pair.id}`];
          const need = exception ? exception.atLeast : result.target;
          if (result.ratio < need) {
            failures.push(
              `${result.pair.id} ${result.pair.label}: ${result.ratio.toFixed(2)} on ${result.worstBg}, needs ${need}`,
            );
          }
        }
        expect(failures).toEqual([]);
      });
    }
  }

  it("the accepted exception really is one (so it disappears from the list when fixed)", () => {
    const m2 = evaluatePairs(getTheme("kontrast"), "light").find((r) => r.pair.id === "m2");
    expect(m2?.ratio).toBeGreaterThanOrEqual(4.5);
    expect(m2?.ratio).toBeLessThan(7);
    expect(m2?.ratio.toFixed(2)).toBe("4.98");
  });

  it("the toggle tokens differ clearly from each other in every theme (not by colour alone: the toggle also shows a symbol)", () => {
    for (const theme of themes) {
      for (const mode of modes) {
        const t = theme.tokens[mode];
        expect(t.toggleOn).not.toBe(t.toggleOff);
      }
    }
  });
});

describe("generated stylesheet", () => {
  it("kebab-cases token names", () => {
    expect(kebab("surface2")).toBe("surface-2");
    expect(kebab("primarySoft")).toBe("primary-soft");
    expect(kebab("accent1")).toBe("accent-1");
    expect(kebab("sketchUnder")).toBe("sketch-under");
  });

  it("is up to date (run `npm run make:theme-css` after changing the theme data)", () => {
    const file = readFileSync(join(repoRoot, "app", "src", "theme", "themes.generated.css"), "utf8").replace(/\r\n/g, "\n");
    expect(file).toBe(buildThemeCss());
  });

  it("has one block per theme and mode and every colour token in it", () => {
    const css = buildThemeCss();
    for (const theme of themes) {
      for (const mode of modes) {
        const start = css.indexOf(`:root[data-theme="${theme.key}"][data-mode="${mode}"] {`);
        expect(start, `${theme.key} ${mode}`).toBeGreaterThan(-1);
        const body = css.slice(start, css.indexOf("\n}\n", start));
        for (const name of colourTokenNames) {
          expect(body).toContain(`--c-${kebab(name)}: ${theme.tokens[mode][name]};`);
        }
      }
    }
  });

  it("keeps the wordmark colours out of the theme blocks (fixed per mode)", () => {
    const css = buildThemeCss();
    const start = css.indexOf(':root[data-theme="graphit"][data-mode="dark"] {');
    const body = css.slice(start, css.indexOf("\n}\n", start));
    expect(body).not.toContain("--wm-");
    expect(css).toContain(':root[data-mode="dark"] {\n  --wm-part: #ffffff;\n  --wm-craft: #4cd1e0;');
  });
});

describe("Tailwind wiring", () => {
  const indexCss = readFileSync(join(repoRoot, "app", "src", "index.css"), "utf8");

  it("maps every colour token to a Tailwind colour (text is called fg)", () => {
    const missing = colourTokenNames.filter((name) => {
      const tw = name === "text" ? "fg" : kebab(name);
      return !indexCss.includes(`--color-${tw}: var(--c-${kebab(name)});`);
    });
    expect(missing).toEqual([]);
  });

  it("removes the default palette so components cannot hard-code colours", () => {
    expect(indexCss).toContain("--color-*: initial;");
  });
});

function memoryPrefs(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: (k: string) => data.get(k),
    set: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}

describe("theme store", () => {
  it("starts from the system once, stores it, and then ignores the system", () => {
    const prefs = memoryPrefs();
    const first = createThemeStore({ preferences: prefs, prefersDark: () => true });
    expect(first.getState()).toEqual({ theme: "praezision", mode: "dark" });
    expect(prefs.data.get(themePreferenceKeys.mode)).toBe("dark");
    const second = createThemeStore({ preferences: prefs, prefersDark: () => false });
    expect(second.getState().mode).toBe("dark");
  });

  it("falls back to light and the default theme for unusable stored values", () => {
    const prefs = memoryPrefs({ [themePreferenceKeys.theme]: "nope", [themePreferenceKeys.mode]: "system" });
    const store = createThemeStore({ preferences: prefs, prefersDark: () => false });
    expect(store.getState()).toEqual({ theme: "praezision", mode: "light" });
  });

  it("stores the choice, notifies listeners and applies it", () => {
    const prefs = memoryPrefs();
    const applied: ThemeState[] = [];
    const store = createThemeStore({ preferences: prefs, prefersDark: () => false, apply: (s) => applied.push(s) });
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.setTheme("graphit");
    store.setMode("dark");
    store.setMode("dark");
    expect(store.getState()).toEqual({ theme: "graphit", mode: "dark" });
    expect(prefs.data.get(themePreferenceKeys.theme)).toBe("graphit");
    expect(calls).toBe(2);
    expect(applied.at(-1)).toEqual({ theme: "graphit", mode: "dark" });
    off();
    store.setMode("light");
    expect(calls).toBe(2);
  });

  it("an override changes the state without storing it", () => {
    const prefs = memoryPrefs({ [themePreferenceKeys.mode]: "light" });
    const store = createThemeStore({ preferences: prefs, prefersDark: () => false, override: { theme: "blaupause", mode: "dark" } });
    expect(store.getState()).toEqual({ theme: "blaupause", mode: "dark" });
    expect(prefs.data.get(themePreferenceKeys.mode)).toBe("light");
    expect(prefs.data.has(themePreferenceKeys.theme)).toBe(false);
  });
});

describe("pairs of the shared components that are not in the pair table", () => {
  const blend = (fg: string, bg: string, alpha: number): string => {
    const f = parseHex(fg);
    const b = parseHex(bg);
    const c = f.map((v, i) => Math.round(v * alpha + (b[i] ?? 0) * (1 - alpha)));
    return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  };

  it("the overlay scroll thumb (muted at 70 % opacity) stays at 3:1 on the surfaces it sits on", () => {
    const failures: string[] = [];
    for (const theme of themes) {
      for (const mode of modes) {
        const t = theme.tokens[mode];
        for (const bg of ["surface", "surface2"] as const) {
          const ratio = contrastRatio(blend(t.muted, t[bg], 0.7), t[bg]);
          if (ratio < 3) failures.push(`${theme.key} ${mode} on ${bg}: ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("the warning colour (the hover amber) stays at 3:1 on surface as an icon", () => {
    const failures: string[] = [];
    for (const theme of themes) {
      for (const mode of modes) {
        const t = theme.tokens[mode];
        const ratio = contrastRatio(t.hover, t.surface);
        if (ratio < 3) failures.push(`${theme.key} ${mode}: ${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
