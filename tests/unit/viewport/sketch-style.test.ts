// Colours, weights and the highlight of determined regions come from the theme tokens: the same weight for fully
// constrained and under-constrained lines, blue as the alternative colour, and a band the line stays readable on.
import { describe, expect, it } from "vitest";
import { contrastRatio, parseHex } from "../../../app/src/theme/contrast.ts";
import { getTheme, modes, themeKeys } from "../../../app/src/theme/themes.ts";
import { styleFromTheme } from "../../../app/src/viewport/style.ts";
import { fullColour } from "../../../app/src/viewport/sketch/scene.ts";
import { axisKindOf } from "../../../app/src/viewport/sketch/three-sketch-layer.ts";
import { BAND_OPACITY, bandColour, BAND_HUE, linearAlpha } from "../../../app/src/viewport/sketch/band-colour.ts";
import { PROFILE_FILL_OPACITY } from "../../../app/src/viewport/sketch/three-profile-fill.ts";

const mix = (fg: string, bg: string, a: number): string => {
  const f = parseHex(fg), b = parseHex(bg);
  return `#${[0, 1, 2].map((i) => Math.round(f[i]! * a + b[i]! * (1 - a)).toString(16).padStart(2, "0")).join("")}`;
};

describe("sketch styles from the theme", () => {
  it("fully constrained lines have the same weight as under-constrained ones in every theme", () => {
    for (const key of themeKeys) {
      const s = styleFromTheme(key, "light");
      expect(s.lines.sketchFull.width).toBe(s.lines.sketchUnder.width);
      expect(s.lines.sketchFull.dash).toEqual(s.lines.sketchUnder.dash.length === 0 ? [] : s.lines.sketchFull.dash);
    }
  });

  it("the style carries the blue alternative, the preview colour, the live dimension colours (quiet = muted, invalid = error) and the dimension text colour of the theme tokens", () => {
    for (const key of themeKeys) {
      for (const mode of modes) {
        const t = getTheme(key).tokens[mode];
        const s = styleFromTheme(key, mode);
        expect(s.sketch).toMatchObject({ fullBlue: t.sketchFullBlue, preview: t.primary, liveQuiet: t.muted, liveInvalid: t.error, dimText: t.dimText });
      }
    }
  });

  it("the colour option picks the green line colour or the blue one", () => {
    const s = styleFromTheme("praezision", "light");
    expect(fullColour(s.lines.sketchFull.color, s.sketch.fullBlue, "green")).toBe(s.lines.sketchFull.color);
    expect(fullColour(s.lines.sketchFull.color, s.sketch.fullBlue, "blue")).toBe(s.sketch.fullBlue);
    expect(s.sketch.fullBlue).not.toBe(s.lines.sketchFull.color);
  });

  it("the opacities are the owner's: 25 % for the full fill; the band is a light tint", () => {
    expect(PROFILE_FILL_OPACITY).toBe(0.25);
    expect(BAND_OPACITY).toBeGreaterThan(0.2);
    expect(BAND_OPACITY).toBeLessThan(0.5);
  });

  it("the line stays readable on its own band: at least 3:1 against the band's ground, in every theme, mode and colour", () => {
    const failures: string[] = [];
    for (const key of themeKeys) {
      const theme = getTheme(key);
      for (const mode of modes) {
        const t = theme.tokens[mode];
        for (const [name, colour] of [["green", t.sketchFull], ["blue", t.sketchFullBlue]] as const) {
          for (const ground of [t.viewport, t.viewport2]) {
            const band = bandColour(colour, [t.viewport, t.viewport2], name === "green" ? BAND_HUE.green : BAND_HUE.blue, theme.highContrast);
            expect(styleFromTheme(key, mode).sketch.band[name]).toBe(band);
            const bandGround = mix(band, ground, BAND_OPACITY);
            const need = theme.highContrast ? 4.5 : 3;
            const ratio = contrastRatio(colour, bandGround);
            if (ratio < need) failures.push(`${key} ${mode} ${name}: ${ratio.toFixed(2)}:1 (needs ${need})`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("the fill of 25 % does not take the line below 3:1 either", () => {
    const failures: string[] = [];
    for (const key of themeKeys) {
      const theme = getTheme(key);
      for (const mode of modes) {
        const t = theme.tokens[mode];
        for (const [name, colour] of [["green", t.sketchFull], ["blue", t.sketchFullBlue]] as const) {
          for (const ground of [t.viewport, t.viewport2]) {
            const ratio = contrastRatio(colour, mix(colour, ground, PROFILE_FILL_OPACITY));
            if (ratio < (theme.highContrast ? 4.5 : 3)) failures.push(`${key} ${mode} ${name}: ${ratio.toFixed(2)}:1`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("translucent parts keep their look: a linear blend with the corrected opacity matches the mixed encoded colours", () => {
    const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const enc = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
    const worst: number[] = [];
    for (const key of themeKeys) {
      for (const mode of modes) {
        const t = getTheme(key).tokens[mode];
        for (const alpha of [0.25, BAND_OPACITY, 0.4]) {
          const a = linearAlpha(t.sketchFull, t.viewport, alpha);
          expect(a).toBeGreaterThan(0);
          expect(a).toBeLessThanOrEqual(1);
          const f = parseHex(t.sketchFull), b = parseHex(t.viewport);
          // The channel the colours differ most in decides what the eye sees.
          const c = [0, 1, 2].reduce((best, i) => (Math.abs(f[i]! - b[i]!) > Math.abs(f[best]! - b[best]!) ? i : best), 0);
          const shown = enc(a * lin(f[c]! / 255) + (1 - a) * lin(b[c]! / 255)) * 255;
          const wanted = f[c]! * alpha + b[c]! * (1 - alpha);
          worst.push(Math.abs(shown - wanted));
        }
      }
    }
    // Within about 12 of 255 levels in the channel that matters (an uncorrected linear blend is off by 20 to 45 levels on the same colours; the least-squares fit shares the rest over the other channels).
    expect(Math.max(...worst)).toBeLessThan(14);
  });

  it("an uncorrected linear blend would look quite different: the reason for the correction", () => {
    const t = getTheme("praezision").tokens;
    const light = linearAlpha(t.light.sketchFull, t.light.viewport, 0.25), dark = linearAlpha(t.dark.sketchFull, t.dark.viewport, 0.25);
    expect(light).toBeGreaterThan(0.3);
    expect(dark).toBeLessThan(0.2);
  });

  it("the plane axes take the colour of the world axis they point along", () => {
    expect(axisKindOf([1, 0, 0])).toBe("axisX");
    expect(axisKindOf([0, -1, 0])).toBe("axisY");
    expect(axisKindOf([0, 0.2, 1])).toBe("axisZ");
  });
});
