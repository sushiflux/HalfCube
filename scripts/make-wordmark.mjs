// Builds every drawn copy of the wordmark from the shipped Geist variable font, so the program, the manuals, the setup
// and the README all show the same letter outlines. The glyph outlines are taken from the font at the exact weights;
// nothing is drawn by hand.
//
// Outputs (all generated, do not edit):
//   branding/wordmark/<slug>-wordmark-{light,dark}[-small].svg   the SVG files (README, manuals)
//   app/src/ui/wordmark.generated.ts                              the outlines for the program's `Wordmark` component
//   installer/setup/Ui/WordmarkOutline.generated.cs               the outlines for the .NET setup (GraphicsPath data)
//
// Needs fontkit (MIT, tested with 3.0.0), which is deliberately not a project dependency because only this script uses
// it: run `npm install --no-save fontkit` first (it leaves package.json and the lock file alone), then
// `node scripts/make-wordmark.mjs`. The product name and slug come from branding/branding.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSync } from "fontkit";

const root = process.env.HC_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const fontPath = join(root, "app/src/assets/fonts/Geist-Variable.woff2");
const outDir = join(root, "branding/wordmark");
const tsOut = join(root, "app/src/ui/wordmark.generated.ts");
const csOut = join(root, "installer/setup/Ui/WordmarkOutline.generated.cs");

const { name, slug } = JSON.parse(readFileSync(join(root, "branding/branding.json"), "utf8"));
// The wordmark is the product name in two colours; the split is where the colour changes.
const parts = ["Half", "Cube"];
if (parts.join("") !== name) throw new Error(`branding.json names "${name}", but the wordmark is split as ${parts.join(" + ")}; adjust "parts" in this script.`);

// Fixed brand colours (Konzept 2.6.2), independent of the UI colour theme.
const colours = {
  light: { half: "#16476E", cube: "#1F75AE" },
  dark: { half: "#FFFFFF", cube: "#4CD1E0" },
};
// Two settings of the same wordmark: weight and letter spacing (in thousandths of an em). The program and the setup switch
// to "small" below this font size in px.
const smallBelow = 28;
const settings = {
  large: { wght: 600, spacing: -28, suffix: "" },
  small: { wght: 640, spacing: 4, suffix: "-small" },
};

const base = openSync(fontPath);
const fmt = (n) => String(Math.round(n * 100) / 100);

// Where the baseline sits inside a line box of height 1 em (line-height: 1): the font's ascent plus half the leading,
// which is negative here because ascent + descent is larger than 1 em. In font units from the top of that box.
const units = base.unitsPerEm;
const baseline = base.ascent + (units - (base.ascent - base.descent)) / 2;

/** Lays out the name at one setting. Commands are in font units, y pointing down, origin at the pen start on the baseline. */
function build(setting) {
  const font = base.getVariation({ wght: setting.wght });
  const full = font.layout(name);
  let pen = 0;
  const glyphs = [];
  full.glyphs.forEach((glyph, i) => {
    const pos = full.positions[i];
    glyphs.push({ glyph, x: pen + pos.xOffset, y: pos.yOffset });
    pen += pos.xAdvance + setting.spacing;
  });
  // Ink bounds (y pointing up here, like the font).
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const g of glyphs) {
    const b = g.glyph.path.bbox;
    minX = Math.min(minX, b.minX + g.x);
    maxX = Math.max(maxX, b.maxX + g.x);
    minY = Math.min(minY, b.minY + g.y);
    maxY = Math.max(maxY, b.maxY + g.y);
  }
  const split = parts[0].length;
  const cmds = { half: [], cube: [] };
  glyphs.forEach((g, i) => {
    const target = cmds[i < split ? "half" : "cube"];
    const px = (x) => x + g.x;
    const py = (y) => -(y + g.y);
    for (const c of g.glyph.path.commands) {
      const a = c.args;
      if (c.command === "moveTo") target.push(["M", px(a[0]), py(a[1])]);
      else if (c.command === "lineTo") target.push(["L", px(a[0]), py(a[1])]);
      else if (c.command === "quadraticCurveTo") target.push(["Q", px(a[0]), py(a[1]), px(a[2]), py(a[3])]);
      else if (c.command === "bezierCurveTo") target.push(["C", px(a[0]), py(a[1]), px(a[2]), py(a[3]), px(a[4]), py(a[5])]);
      else if (c.command === "closePath") target.push(["Z"]);
    }
  });
  return { cmds, width: maxX - minX, height: maxY - minY, minX, maxY, advance: pen };
}

/** SVG path data of commands, translated by (dx, dy). */
function pathData(cmds, dx, dy) {
  return cmds
    .map(([op, ...v]) => op + v.map((n, i) => fmt(n + (i % 2 === 0 ? dx : dy))).join(" "))
    .join("");
}

const built = Object.fromEntries(Object.entries(settings).map(([key, setting]) => [key, build(setting)]));

// ---- SVG files: tight view box around the ink, y pointing down ----
mkdirSync(outDir, { recursive: true });
const report = {};
for (const [sizeName, setting] of Object.entries(settings)) {
  const r = built[sizeName];
  report[sizeName] = { width: r.width, height: r.height, inkLeft: r.minX, ascentToBaseline: r.maxY };
  for (const [mode, c] of Object.entries(colours)) {
    const w = fmt(r.width), h = fmt(r.height);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${fmt(r.width / 10)}" height="${fmt(r.height / 10)}" role="img" aria-label="${name}">\n` +
      `  <title>${name}</title>\n` +
      `  <path fill="${c.half}" d="${pathData(r.cmds.half, -r.minX, r.maxY)}"/>\n` +
      `  <path fill="${c.cube}" d="${pathData(r.cmds.cube, -r.minX, r.maxY)}"/>\n` +
      `</svg>\n`;
    writeFileSync(join(outDir, `${slug}-wordmark-${mode}${setting.suffix}.svg`), svg);
  }
}

// ---- TypeScript module for the program: coordinates relative to the pen start and the baseline ----
let ts =
  `// Generated by scripts/make-wordmark.mjs from the Geist variable font, do not edit. The wordmark outlines of the program.\n` +
  `// Font units (1 em = ${units}), y pointing down, origin at the start of the text on the baseline. \`advance\` is the width\n` +
  `// of the text including the letter spacing after every letter, \`baseline\` the distance of the baseline from the top of\n` +
  `// a line box of height 1 em, \`smallBelow\` the font size in px below which the small setting is used.\n\n` +
  `export interface WordmarkOutline {\n  /** Outline path data of the first part of the name ("Half"). */\n  half: string;\n  /** Outline path data of the second part of the name ("Cube"). */\n  cube: string;\n  /** Width of the text in font units, letter spacing included. */\n  advance: number;\n}\n\n` +
  `export const wordmarkUnitsPerEm = ${units};\n` +
  `export const wordmarkBaseline = ${fmt(baseline)};\n` +
  `export const wordmarkSmallBelow = ${smallBelow};\n\n` +
  `export const wordmarkOutlines: { readonly large: WordmarkOutline; readonly small: WordmarkOutline } = {\n`;
for (const key of Object.keys(settings)) {
  const r = built[key];
  ts += `  ${key}: {\n    half: "${pathData(r.cmds.half, 0, 0)}",\n    cube: "${pathData(r.cmds.cube, 0, 0)}",\n    advance: ${fmt(r.advance)},\n  },\n`;
}
ts += `};\n`;
writeFileSync(tsOut, ts);

// ---- C# file for the setup: flat operation and point arrays, quadratic curves converted to cubic ones ----
function csArrays(cmds) {
  const ops = [];
  const pts = [];
  let cx = 0, cy = 0;
  for (const [op, ...v] of cmds) {
    if (op === "M" || op === "L") {
      ops.push(op === "M" ? 0 : 1);
      pts.push(v[0], v[1]);
      [cx, cy] = v;
    } else if (op === "Q") {
      // A quadratic curve (control q, end e) is the cubic curve with the control points c0 + 2/3 (q - c0) and e + 2/3 (q - e).
      const [qx, qy, ex, ey] = v;
      ops.push(2);
      pts.push(cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey);
      [cx, cy] = [ex, ey];
    } else if (op === "C") {
      ops.push(2);
      pts.push(...v);
      [cx, cy] = [v[4], v[5]];
    } else if (op === "Z") ops.push(3);
  }
  return { ops, pts };
}
const f = (n) => `${fmt(n)}f`;
let cs =
  `// <auto-generated> Generated by scripts/make-wordmark.mjs from the Geist variable font, do not edit. </auto-generated>\n` +
  `// The wordmark outlines of the setup. Font units (1 em = ${units}), y pointing down, origin at the start of the text on the baseline.\n` +
  `// Operations: 0 = move to, 1 = line to, 2 = cubic curve to (three points), 3 = close figure.\n\n` +
  `namespace HalfCube.Setup.Ui;\n\n` +
  `/// <summary>Letter outlines of the wordmark in the large and the small setting, both brand colour pairs.</summary>\n` +
  `internal static class WordmarkOutline\n{\n` +
  `    public const float UnitsPerEm = ${units}f;\n\n` +
  `    /// <summary>Distance of the baseline from the top of a line box of height 1 em, in font units.</summary>\n` +
  `    public const float Baseline = ${f(baseline)};\n\n` +
  `    /// <summary>Font size in pixels below which the small setting is used.</summary>\n` +
  `    public const float SmallBelow = ${smallBelow}f;\n\n` +
  `    public const string LightHalf = "${colours.light.half}";\n    public const string LightCube = "${colours.light.cube}";\n` +
  `    public const string DarkHalf = "${colours.dark.half}";\n    public const string DarkCube = "${colours.dark.cube}";\n\n`;
const pascal = (s) => s[0].toUpperCase() + s.slice(1);
for (const key of Object.keys(settings)) {
  const r = built[key];
  cs += `    public const float ${pascal(key)}Advance = ${f(r.advance)};\n`;
  for (const part of ["half", "cube"]) {
    const { ops, pts } = csArrays(r.cmds[part]);
    cs += `    public static readonly byte[] ${pascal(key)}${pascal(part)}Ops = [${ops.join(", ")}];\n`;
    cs += `    public static readonly float[] ${pascal(key)}${pascal(part)}Points = [${pts.map(f).join(", ")}];\n`;
  }
  cs += `\n`;
}
cs = cs.replace(/\n\n$/, "\n") + `}\n`;
writeFileSync(csOut, cs);

console.log(JSON.stringify({ ...report, baseline, unitsPerEm: units }, null, 2));
