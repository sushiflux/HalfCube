// The colour of the inner band. The band is a light tint along the inside of the contour; the contour line must stay readable
// against the tinted ground right beside it. A tint of the line colour itself is not enough in several themes (2.7:1 to 2.98:1
// against a need of 3:1), so the band colour is searched per theme, mode and colour choice: same hue as
// the line, saturation 0.6, the lightness that gives the line at least 3.5:1 (4.5:1 in high-contrast themes) against the
// band's ground on both view colours and stands out most from the view. Pure functions, tested in Node.
import { contrastRatio, parseHex } from "../../theme/contrast.ts";

/** Opacity of the band at full strength (inner-band look). */
export const BAND_OPACITY = 0.34;
/** Hue of the colour of "fully constrained": green (the default) and blue. */
export const BAND_HUE = { green: 142, blue: 222 } as const;
const SATURATION = 0.6;

const toHex = (c: readonly number[]): string => `#${c.map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0")).join("")}`;

export function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

/** The colour that shows when `fg` is drawn over `bg` with the given opacity. */
export function blend(fg: string, bg: string, alpha: number): string {
  const f = parseHex(fg), b = parseHex(bg);
  return toHex([0, 1, 2].map((i) => f[i]! * alpha + b[i]! * (1 - alpha)));
}

const distance = (a: string, b: string): number => {
  const p = parseHex(a), q = parseHex(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};

/**
 * The band colour for a line colour on the view colours of a theme (the two grounds of the 3D view).
 * `hue` is the hue of the line (BAND_HUE).
 */
export function bandColour(line: string, grounds: readonly string[], hue: number, highContrast: boolean): string {
  const need = highContrast ? 4.5 : 3.5;
  let best: { colour: string; spread: number } | null = null;
  let top: { colour: string; ratio: number } | null = null;
  for (let l = 6; l <= 94; l++) {
    const colour = hslToHex(hue, SATURATION, l / 100);
    const tinted = grounds.map((g) => blend(colour, g, BAND_OPACITY));
    const ratio = Math.min(...tinted.map((t) => contrastRatio(line, t)));
    const spread = Math.min(...tinted.map((t, i) => distance(t, grounds[i]!)));
    if (!top || ratio > top.ratio) top = { colour, ratio };
    if (ratio >= need && (!best || spread > best.spread)) best = { colour, spread };
  }
  return (best ?? top)!.colour;
}

const toLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/**
 * The renderer blends translucent triangles in linear light, but the design values (25 % and 34 %)
 * blend the encoded colours, as CSS and SVG do. Blended linearly, 25 % of a dark green over a light view looks like 13 % and
 * over a dark view like 47 %. This is the opacity that, blended linearly, gives on the given ground what `alpha` gives when
 * the encoded colours are mixed (least squares over the three channels).
 */
export function linearAlpha(fg: string, bg: string, alpha: number): number {
  const f = parseHex(fg), b = parseHex(bg);
  let num = 0, den = 0;
  for (let i = 0; i < 3; i++) {
    const lf = toLinear(f[i]! / 255), lb = toLinear(b[i]! / 255);
    const target = toLinear((f[i]! * alpha + b[i]! * (1 - alpha)) / 255);
    num += (target - lb) * (lf - lb);
    den += (lf - lb) ** 2;
  }
  return den < 1e-12 ? alpha : Math.min(1, Math.max(0, num / den));
}
