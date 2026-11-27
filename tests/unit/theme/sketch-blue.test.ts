// The blue alternative for "fully constrained" (settings dialog: Grün / Blau): it has to read against the view, stay visibly
// distinct from the other sketch and highlight colours of the same theme, and its area fill and inner band have to show.
import { describe, expect, it } from "vitest";
import { contrastRatio, parseHex } from "../../../app/src/theme/contrast.ts";
import { getTheme, modes, themeKeys, themes, type Mode, type ThemeKey } from "../../../app/src/theme/themes.ts";
import { BAND_HUE, BAND_OPACITY, bandColour, blend } from "../../../app/src/viewport/sketch/band-colour.ts";
import { PROFILE_FILL_OPACITY } from "../../../app/src/viewport/sketch/three-profile-fill.ts";

/** CIE76 colour distance (sRGB, D65), the measure of the designer's collision table: below 20 two colours count as colliding. */
function deltaE(a: string, b: string): number {
  const lab = (hex: string): [number, number, number] => {
    const [r, g, bl] = parseHex(hex).map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    }) as [number, number, number];
    const f = (v: number) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
    const x = (0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    const z = (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883;
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  };
  const p = lab(a);
  const q = lab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** Below this distance two colours collide (the designer's rule of mockup round 5). */
const COLLISION = 20;
/** The least distance the area fill or the band must have from the view to count as visible (the mockup's own "barely visible" limit was 6). */
const VISIBLE = 12;

const combos = themeKeys.flatMap((key) => modes.map((mode) => [key, mode] as const));

describe("the blue of 'fully constrained'", () => {
  it("replacement tones of the designer's round 5 for the five colliding combinations are in the themes (minimal adjustments noted)", () => {
    // Hoher Kontrast light: proposal #0855c9 reached only 4.08:1 against its own 25 % fill (4.5:1 needed there), so #084cbd.
    // Blaupause dark: proposal #5d8cf9 reached 2.99:1 against its own fill (3:1 needed), so #5d8ef9.
    const pinned: [ThemeKey, Mode, string][] = [
      ["kontrast", "light", "#084cbd"],
      ["kontrast", "dark", "#6793f9"],
      ["blaupause", "dark", "#5d8ef9"],
    ];
    for (const [key, mode, colour] of pinned) expect(getTheme(key).tokens[mode].sketchFullBlue, `${key} ${mode}`).toBe(colour);
  });

  it("the other combinations keep their blue (the full fill is the line colour itself, so Graphit light and Dämmerung light need no stronger fill colour)", () => {
    const kept: [ThemeKey, Mode, string][] = [
      ["praezision", "light", "#094ae1"],
      ["praezision", "dark", "#4f81f8"],
      ["skizze", "light", "#094ae1"],
      ["skizze", "dark", "#457af7"],
      ["graphit", "light", "#094ae1"],
      ["graphit", "dark", "#4f81f8"],
      ["blaupause", "light", "#094ae1"],
      ["farbsicher", "light", "#094ae1"],
      ["farbsicher", "dark", "#4f81f8"],
      ["daemmerung", "light", "#0949dc"],
      ["daemmerung", "dark", "#3b73f7"],
    ];
    for (const [key, mode, colour] of kept) expect(getTheme(key).tokens[mode].sketchFullBlue, `${key} ${mode}`).toBe(colour);
  });

  it.each(combos)("%s %s: the line has 3:1 against both view colours (4.5:1 in Hoher Kontrast) and keeps it on its own 25 % fill and on its band", (key, mode) => {
    const theme = getTheme(key);
    const t = theme.tokens[mode];
    const need = theme.highContrast ? 4.5 : 3;
    const band = bandColour(t.sketchFullBlue, [t.viewport, t.viewport2], BAND_HUE.blue, theme.highContrast);
    for (const ground of [t.viewport, t.viewport2]) {
      expect(contrastRatio(t.sketchFullBlue, ground), `view ${ground}`).toBeGreaterThanOrEqual(need);
      expect(contrastRatio(t.sketchFullBlue, blend(t.sketchFullBlue, ground, PROFILE_FILL_OPACITY)), `fill on ${ground}`).toBeGreaterThanOrEqual(need);
      expect(contrastRatio(t.sketchFullBlue, blend(band, ground, BAND_OPACITY)), `band on ${ground}`).toBeGreaterThanOrEqual(need);
    }
  });

  it.each(combos)("%s %s: the blue is not mistaken for under-constrained, selection, hover, the theme accent or over-constrained (CIE76 distance 20 or more)", (key, mode) => {
    const t = getTheme(key).tokens[mode];
    const refs = { sketchUnder: t.sketchUnder, selection: t.selection, hover: t.hover, primary: t.primary, sketchOver: t.sketchOver };
    const collisions = Object.entries(refs)
      .map(([name, colour]) => [name, deltaE(t.sketchFullBlue, colour)] as const)
      .filter(([, distance]) => distance < COLLISION)
      .map(([name, distance]) => `${name} ${distance.toFixed(1)}`);
    expect(collisions).toEqual([]);
  });

  it.each(combos)("%s %s: the area fill (25 %) and the inner band in blue are visibly distinct from the view (distance 12 or more)", (key, mode) => {
    const theme = getTheme(key);
    const t = theme.tokens[mode];
    const band = bandColour(t.sketchFullBlue, [t.viewport, t.viewport2], BAND_HUE.blue, theme.highContrast);
    for (const ground of [t.viewport, t.viewport2]) {
      expect(deltaE(blend(t.sketchFullBlue, ground, PROFILE_FILL_OPACITY), ground), `fill on ${ground}`).toBeGreaterThanOrEqual(VISIBLE);
      expect(deltaE(blend(band, ground, BAND_OPACITY), ground), `band on ${ground}`).toBeGreaterThanOrEqual(VISIBLE);
    }
  });

  it("the distance measure is sane: identical colours 0, black to white 100", () => {
    expect(deltaE("#123456", "#123456")).toBe(0);
    expect(deltaE("#000000", "#ffffff")).toBeCloseTo(100, 0);
  });

  it("the sets cover all seven themes in both modes", () => {
    expect(combos).toHaveLength(themes.length * 2);
    expect(themes).toHaveLength(7);
  });
});
