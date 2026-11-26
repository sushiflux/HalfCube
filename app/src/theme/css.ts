// Turns the theme data into CSS custom properties. The result is committed as themes.generated.css (a strict
// Content-Security-Policy forbids inline styles, so the stylesheet has to be a real file); a unit test keeps both in sync.
import {
  colourTokenNames,
  defaultThemeKey,
  getTheme,
  lineTypeNames,
  modes,
  opacityNames,
  themes,
  wordmarkColours,
  type Mode,
  type Theme,
} from "./themes.ts";

/** "surface2" -> "surface-2", "sketchUnder" -> "sketch-under", "accent1" -> "accent-1". */
export function kebab(name: string): string {
  return name.replace(/([a-z])([A-Z0-9])/g, "$1-$2").toLowerCase();
}

export const colourVar = (name: string): string => `--c-${kebab(name)}`;
export const weightVar = (name: string): string => `--w-${kebab(name)}`;
export const dashVar = (name: string): string => `--d-${kebab(name)}`;
export const opacityVar = (name: string): string => `--o-${kebab(name)}`;

function declarations(theme: Theme, mode: Mode): string[] {
  const lines: string[] = [`color-scheme: ${mode};`];
  const tokens = theme.tokens[mode];
  for (const name of colourTokenNames) lines.push(`${colourVar(name)}: ${tokens[name]};`);
  for (const name of lineTypeNames) {
    lines.push(`${weightVar(name)}: ${theme.weights[name]};`);
    lines.push(`${dashVar(name)}: ${theme.dashes[name] === "" ? "none" : theme.dashes[name]};`);
  }
  for (const name of opacityNames) lines.push(`${opacityVar(name)}: ${theme.opacity[name]};`);
  return lines;
}

const block = (selector: string, lines: readonly string[], indent = ""): string =>
  `${indent}${selector} {\n${lines.map((l) => `${indent}  ${l}`).join("\n")}\n${indent}}\n`;

function wordmarkLines(mode: Mode): string[] {
  return [`--wm-half: ${wordmarkColours[mode].half};`, `--wm-cube: ${wordmarkColours[mode].cube};`];
}

/** The complete stylesheet: brand constants, the fallback before the script runs and all 14 theme blocks. */
export function buildThemeCss(): string {
  const fallback = getTheme(defaultThemeKey);
  const out: string[] = [
    "/* Generated from app/src/theme/themes.ts by `npm run make:theme-css`. Do not edit by hand. */\n",
    block(":root", [
      "/* Brand colours of the logo: the same in every theme. */",
      "--brand-navy: #16476e;",
      "--brand-blue: #1f75ae;",
      "--brand-cyan: #4cd1e0;",
    ]),
    "/* Before the script has chosen a theme: the default theme, light or dark as the system says. */\n" +
      block(":root:not([data-theme])", [...declarations(fallback, "light"), ...wordmarkLines("light")]),
    `@media (prefers-color-scheme: dark) {\n${block(
      ":root:not([data-theme])",
      [...declarations(fallback, "dark"), ...wordmarkLines("dark")],
      "  ",
    )}}\n`,
  ];
  for (const mode of modes) out.push(block(`:root[data-mode="${mode}"]`, wordmarkLines(mode)));
  for (const theme of themes) {
    for (const mode of modes) {
      out.push(block(`:root[data-theme="${theme.key}"][data-mode="${mode}"]`, declarations(theme, mode)));
    }
  }
  return out.join("\n");
}
