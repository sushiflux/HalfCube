// Layout and colours of the axis navigator (disc style): a Blender-like view control that shows the
// current orientation. Positive axis ends are filled discs in the axis colours, negative ends are hollow rings. Pure
// functions, so the layout is tested in Node; the React component only draws what this returns. There is no cube.
import { cameraBasis, axisDirection, axisKeys, viewNameOfAxis, type AxisKey, type StandardViewName, type ViewState } from "./camera.ts";
import { dot } from "./math.ts";
import { contrastRatio } from "../theme/contrast.ts";

/** "views": the view initials (O, H, R / T, Bk, R). "xyz": X, Y, Z. A setting of the settings dialog, never of the view. */
export type AxisLabelMode = "views" | "xyz";

export interface NavigatorEnd {
  key: AxisKey;
  axis: "x" | "y" | "z";
  positive: boolean;
  /** Centre in the navigator's own coordinates (0..size). */
  x: number;
  y: number;
  /** How far the end is towards the viewer; ends are sorted so the farthest comes first and is drawn first. */
  depth: number;
}

export interface NavigatorMetrics {
  size: number;
  /** Distance of an axis end from the centre. */
  reach: number;
  /** Radius of a filled disc (positive end). */
  disc: number;
  /** Radius of a hollow ring at rest (negative end). */
  ring: number;
  /** Radius of a ring that shows two letters under the pointer. */
  ringWide: number;
  fontSize: number;
  lineWidth: number;
}

export function navigatorMetrics(size: number): NavigatorMetrics {
  return {
    size,
    reach: size * 0.33,
    disc: size * 0.104,
    ring: size * 0.062,
    ringWide: size * 0.118,
    fontSize: size * 0.105,
    lineWidth: Math.max(2.6, size * 0.026),
  };
}

/** The six axis ends for a view, farthest first (the nearest end is drawn on top). */
export function navigatorEnds(view: ViewState, size: number): NavigatorEnd[] {
  const basis = cameraBasis(view);
  const m = navigatorMetrics(size);
  const c = size / 2;
  const ends = axisKeys.map((key): NavigatorEnd => {
    const d = axisDirection(key);
    return {
      key,
      axis: key[1] as "x" | "y" | "z",
      positive: key[0] === "+",
      x: c + dot(d, basis.right) * m.reach,
      y: c - dot(d, basis.up) * m.reach,
      depth: -dot(d, basis.forward),
    };
  });
  return ends.sort((a, b) => a.depth - b.depth);
}

/** The letters of an axis end. A hollow ring shows its letter only under the pointer (the opposite side follows from the disc). */
export function endLabel(key: AxisKey, mode: AxisLabelMode, initials: Record<StandardViewName, string>, hovered: boolean): string {
  const positive = key[0] === "+";
  if (!positive && !hovered) return "";
  if (mode === "xyz") return (positive ? "" : "−") + key[1]!.toUpperCase();
  return initials[viewNameOfAxis[key]];
}

// --- disc colours -----------------------------------------------------------------------------------------------

const toRgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const toHex = (c: readonly number[]): string => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
/** Keeps t of a and 1 - t of b. */
function mix(a: string, b: string, t: number): string {
  const A = toRgb(a), B = toRgb(b);
  return toHex(A.map((v, i) => v * t + B[i]! * (1 - t)));
}

/**
 * Fill and letter colour of a disc. The letter takes the surface or the text colour, whichever reads better on the axis
 * colour; the fill is then moved towards black or white until the letter has at least 4.5:1 (7:1 in high contrast).
 */
export function discColours(axisColour: string, surface: string, text: string, highContrast = false): { fill: string; letter: string } {
  const letter = contrastRatio(surface, axisColour) >= contrastRatio(text, axisColour) ? surface : text;
  const need = highContrast ? 7 : 4.5;
  const letterIsLight = contrastRatio(letter, "#000000") > contrastRatio(letter, "#ffffff");
  const toward = letterIsLight ? "#000000" : "#ffffff";
  let fill = axisColour;
  for (let i = 0; i < 60 && contrastRatio(fill, letter) < need; i++) fill = mix(fill, toward, 0.95);
  return { fill, letter };
}
