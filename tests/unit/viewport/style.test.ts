import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dashPasses, lineKinds, parseDash, styleFromTheme } from "../../../app/src/viewport/style.ts";
import { getTheme, lineTypeNames, modes, themeKeys } from "../../../app/src/theme/themes.ts";
import { contrastRatio } from "../../../app/src/theme/contrast.ts";

describe("dash patterns", () => {
  it("parses the token strings", () => {
    expect(parseDash("")).toEqual([]);
    expect(parseDash("none")).toEqual([]);
    expect(parseDash("8 5")).toEqual([8, 5]);
    expect(parseDash("14 4 3 4")).toEqual([14, 4, 3, 4]);
    expect(parseDash("1.5 4")).toEqual([1.5, 4]);
    expect(parseDash("5")).toEqual([5, 5]);
    expect(parseDash("0 3 x 4")).toEqual([3, 4]);
  });

  it("a plain dash and gap is one pass", () => {
    expect(dashPasses([8, 5])).toEqual([{ dash: 8, gap: 5, offset: 0 }]);
  });

  it("a dash-dot pattern is one pass per dash, each shifted to its place in the period", () => {
    // "14 4 3 4": period 25; the long dash at 0..14, the short one at 18..21
    expect(dashPasses([14, 4, 3, 4])).toEqual([
      { dash: 14, gap: 11, offset: 0 },
      { dash: 3, gap: 22, offset: 7 },
    ]);
  });

  it("every pass, drawn with its offset, covers exactly its dash of the pattern", () => {
    // The line material shows a pixel where (distance + offset) mod period < dash.
    const pattern = [14, 4, 3, 4];
    const passes = dashPasses(pattern);
    const period = 25;
    const covered = (d: number) => passes.some((p) => (((d + p.offset) % period) + period) % period < p.dash);
    const expected = (d: number) => {
      const t = d % period;
      return t < 14 || (t >= 18 && t < 21);
    };
    for (let d = 0; d < 100; d += 0.25) expect(covered(d), `at ${d}`).toBe(expected(d));
  });

  it("no pattern, no passes", () => {
    expect(dashPasses([])).toEqual([]);
  });
});

describe("style from the theme tokens", () => {
  it("gives every line kind a colour, weight and dash pattern, for all seven themes in light and dark", () => {
    for (const key of themeKeys) {
      for (const mode of modes) {
        const style = styleFromTheme(key, mode);
        const theme = getTheme(key);
        const tokens = theme.tokens[mode];
        for (const kind of lineTypeNames) {
          const line = style.lines[kind];
          expect(line.color, `${key}/${mode}/${kind}`).toBe((tokens as Record<string, string>)[kind]);
          expect(line.color).toMatch(/^#[0-9a-f]{6}$/);
          expect(line.width).toBe(theme.weights[kind]);
          expect(line.width).toBeGreaterThan(0);
          expect(line.dash).toEqual(parseDash(theme.dashes[kind]));
        }
        expect(style.background).toBe(tokens.viewport);
        expect(style.body).toEqual({ top: tokens.faceTop, left: tokens.faceLeft, right: tokens.faceRight });
        expect(style.opacity).toEqual(theme.opacity);
      }
    }
  });

  it("covers the same line kinds as the theme", () => {
    expect([...lineKinds]).toEqual([...lineTypeNames]);
  });

  it("light and dark differ (the view really follows the mode)", () => {
    for (const key of themeKeys) {
      expect(styleFromTheme(key, "light").background).not.toBe(styleFromTheme(key, "dark").background);
      expect(styleFromTheme(key, "light").lines.sketchFull.color).not.toBe(styleFromTheme(key, "dark").lines.sketchFull.color);
    }
  });

  it("the three constraint states of a sketch line can be told apart in every theme: under and fully constrained differ in colour or dashes, over-constrained in colour", () => {
    for (const key of themeKeys) {
      for (const mode of modes) {
        const l = styleFromTheme(key, mode).lines;
        const underVsFull = l.sketchUnder.color !== l.sketchFull.color || l.sketchUnder.dash.join() !== l.sketchFull.dash.join();
        expect(underVsFull, `${key}/${mode}`).toBe(true);
        expect(l.sketchOver.color, `${key}/${mode}`).not.toBe(l.sketchFull.color);
        expect(l.sketchOver.color, `${key}/${mode}`).not.toBe(l.sketchUnder.color);
      }
    }
  });
});

describe("the extrude command: preview, profiles and arrow", () => {
  const all = themeKeys.flatMap((key) => modes.map((mode) => ({ key, mode, style: styleFromTheme(key, mode), tokens: getTheme(key).tokens[mode] })));

  it("the preview edge reads at 3:1 over the view colour and over the lit top of a body, in every theme and mode", () => {
    for (const { key, mode, style, tokens } of all) {
      expect(contrastRatio(style.preview.edge.color, style.background), `${key}/${mode} over the view`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(style.preview.edge.color, tokens.faceTop), `${key}/${mode} over the body`).toBeGreaterThanOrEqual(3);
      expect(style.preview.edge.dash.length, "dashed: tells a preview from a body").toBeGreaterThanOrEqual(2);
      expect(style.preview.fillOpacity).toBeGreaterThan(0.15);
      expect(style.preview.fillOpacity).toBeLessThan(0.7);
    }
  });

  it("the preview has its own look: its colour is the theme's primary colour, not a body colour", () => {
    for (const { key, mode, style, tokens } of all) {
      expect(style.preview.fill, `${key}/${mode}`).toBe(tokens.primary);
      expect(style.preview.fill).not.toBe(tokens.faceTop);
    }
  });

  it("the three states of a profile differ: stronger and in other colours from rest to hover to selected, with an outline for the last two", () => {
    for (const { key, mode, style } of all) {
      const { rest, hover, selected } = style.profile;
      expect(rest.opacity, `${key}/${mode}`).toBeLessThan(hover.opacity);
      expect(hover.opacity).toBeLessThan(selected.opacity);
      expect(hover.opacity - rest.opacity).toBeGreaterThanOrEqual(0.1);
      expect(selected.opacity - hover.opacity).toBeGreaterThanOrEqual(0.1);
      expect(hover.color).not.toBe(selected.color);
      expect(hover.outline.width).toBeLessThan(selected.outline.width);
      expect(hover.outline.color).toBe(style.lines.hover.color);
      expect(selected.outline.color).toBe(style.lines.selection.color);
    }
  });

  it("the outlines of hover and selection and the arrow read at 3:1 over the view colour, in every theme and mode", () => {
    for (const { key, mode, style } of all) {
      for (const [what, colour] of [["hover outline", style.profile.hover.outline.color], ["selected outline", style.profile.selected.outline.color], ["arrow", style.handle.color], ["arrow hovered", style.handle.hoverColor]] as const) {
        expect(contrastRatio(colour, style.background), `${key}/${mode} ${what}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("the arrow at rest and hovered differ in colour, and its head has a usable size", () => {
    for (const { key, mode, style } of all) {
      expect(style.handle.color, `${key}/${mode}`).not.toBe(style.handle.hoverColor);
      expect(style.handle.headLengthPx).toBeGreaterThanOrEqual(12);
      expect(style.handle.headRadiusPx).toBeGreaterThanOrEqual(5);
    }
  });
});

describe("the renderer owns no colour", () => {
  const dir = join(__dirname, "../../../app/src/viewport");
  const rendererFiles = readdirSync(dir).filter((f) => f.startsWith("three-") && f.endsWith(".ts"));

  it("has renderer files to check", () => {
    expect(rendererFiles).toEqual(expect.arrayContaining(["three-viewport.ts", "three-lines.ts", "three-grid.ts"]));
  });

  it("contains no colour literal: no #rgb, no 0xrrggbb, no named CSS colour", () => {
    const patterns = [/#[0-9a-fA-F]{3,8}\b/, /0x[0-9a-fA-F]{6}\b/, /["'](white|black|red|green|blue|gray|grey|orange|yellow|cyan|magenta)["']/i];
    const offenders = rendererFiles.filter((file) => {
      const code = readFileSync(join(dir, file), "utf8")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
        .join("\n");
      return patterns.some((p) => p.test(code));
    });
    expect(offenders).toEqual([]);
  });
});
