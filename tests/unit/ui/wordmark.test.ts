// The wordmark is one drawing: the program, the manuals (SVG), the setup (C#) and the README all use the letter outlines
// that scripts/make-wordmark.mjs makes from the Geist variable font.
import { readFileSync } from "node:fs";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { branding } from "../../../app/src/branding.ts";
import { wordmarkColours } from "../../../app/src/theme/themes.ts";
import { wordmarkBaseline, wordmarkOutlines, wordmarkSmallBelow } from "../../../app/src/ui/wordmark.generated.ts";

// Brand.tsx is loaded through a variable path: the node project of the tests has no JSX setting, Vitest compiles the file itself.
const brandPath = "../../../app/src/ui/Brand.tsx";
const { Wordmark } = (await import(/* @vite-ignore */ brandPath)) as { Wordmark: ComponentType<{ size: number | string; small?: boolean }> };

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/** All numbers of path data in order, and the command letters. */
function parsePath(d: string) {
  return { letters: d.replace(/[^MLQCZ]/g, ""), numbers: (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number) };
}

describe("Wordmark component", () => {
  it("draws the generated outlines instead of text", () => {
    const html = renderToStaticMarkup(createElement(Wordmark, { size: 18 }));
    expect(html).toContain(`d="${wordmarkOutlines.small.half}"`);
    expect(html).toContain(`d="${wordmarkOutlines.small.cube}"`);
    expect(html).not.toContain("<text");
    expect(html).not.toContain("Half<");
  });

  it("names the product from the branding source, not from a literal", () => {
    const html = renderToStaticMarkup(createElement(Wordmark, { size: 18 }));
    expect(html).toContain('role="img"');
    expect(html).toContain(`aria-label="${branding.name}"`);
  });

  it("switches from the small to the large setting at 28 px, like the SVG files", () => {
    const below = renderToStaticMarkup(createElement(Wordmark, { size: wordmarkSmallBelow - 1 }));
    const at = renderToStaticMarkup(createElement(Wordmark, { size: wordmarkSmallBelow }));
    expect(below).toContain(`d="${wordmarkOutlines.small.half}"`);
    expect(at).toContain(`d="${wordmarkOutlines.large.half}"`);
    expect(at).not.toContain(`d="${wordmarkOutlines.small.half}"`);
  });

  it("lets a CSS length size use an explicit setting (loading screen)", () => {
    const large = renderToStaticMarkup(createElement(Wordmark, { size: "calc(68 * var(--u))", small: false }));
    expect(large).toContain(`d="${wordmarkOutlines.large.cube}"`);
    expect(large).toContain("font-size:calc(68 * var(--u))");
  });

  it("colours the two parts with the fixed brand colour variables and gives the line box 1 em", () => {
    const html = renderToStaticMarkup(createElement(Wordmark, { size: 30 }));
    expect(html).toContain("fill-wm-half");
    expect(html).toContain("fill-wm-cube");
    expect(html).toContain("height:1em");
    expect(html).toContain(`viewBox="0 -${wordmarkBaseline} ${wordmarkOutlines.large.advance} 1000"`);
  });
});

describe("one source for every copy of the wordmark", () => {
  // The SVG files have a tight view box, the program's outlines start at the pen origin on the baseline: the same shapes
  // shifted by one constant offset.
  for (const [setting, suffix] of [["large", ""], ["small", "-small"]] as const) {
    it(`the ${setting} SVG files and the program's outlines are the same drawing`, () => {
      const svg = read(`branding/wordmark/${branding.slug}-wordmark-light${suffix}.svg`);
      const paths = [...svg.matchAll(/<path fill="(#[0-9A-F]{6})" d="([^"]+)"/g)];
      expect(paths).toHaveLength(2);
      const parts = [wordmarkOutlines[setting].half, wordmarkOutlines[setting].cube];
      let offset: [number, number] | undefined;
      paths.forEach((match, index) => {
        const fromSvg = parsePath(match[2]!);
        const fromProgram = parsePath(parts[index]!);
        expect(fromSvg.letters).toBe(fromProgram.letters);
        expect(fromSvg.numbers).toHaveLength(fromProgram.numbers.length);
        fromSvg.numbers.forEach((value, i) => {
          const delta = value - fromProgram.numbers[i]!;
          offset ??= [NaN, NaN];
          const axis = i % 2;
          if (Number.isNaN(offset[axis]!)) offset[axis] = delta;
          // Both files round to two decimals, so equal shifts agree within 0.02.
          expect(Math.abs(delta - offset[axis]!)).toBeLessThan(0.021);
        });
      });
    });

    it(`the setup's generated outline has the ${setting} advance of the program`, () => {
      const cs = read("installer/setup/Ui/WordmarkOutline.generated.cs");
      expect(cs).toContain("auto-generated");
      expect(cs).toContain(`${setting[0]!.toUpperCase()}${setting.slice(1)}Advance = ${wordmarkOutlines[setting].advance}f;`);
    });
  }

  it("uses the same fixed brand colours in the program's themes, the SVG files and the setup", () => {
    const cs = read("installer/setup/Ui/WordmarkOutline.generated.cs");
    for (const mode of ["light", "dark"] as const) {
      const svg = read(`branding/wordmark/${branding.slug}-wordmark-${mode}.svg`).toLowerCase();
      const colours = wordmarkColours[mode];
      expect(svg).toContain(`fill="${colours.half.toLowerCase()}"`);
      expect(svg).toContain(`fill="${colours.cube.toLowerCase()}"`);
      const pascal = mode === "light" ? "Light" : "Dark";
      expect(cs.toLowerCase()).toContain(`${pascal.toLowerCase()}half = "${colours.half.toLowerCase()}"`);
      expect(cs.toLowerCase()).toContain(`${pascal.toLowerCase()}cube = "${colours.cube.toLowerCase()}"`);
    }
  });
});
