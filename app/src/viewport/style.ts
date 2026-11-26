// What the viewport draws with: colours, line weights, dash patterns and fill opacities. The renderer owns no colour and
// no weight of its own; everything comes from a ViewportStyle, which is derived from the active theme (K 2.6.1).
import { getTheme, lineTypeNames, type LineTypeName, type Mode, type ThemeKey } from "../theme/themes.ts";
import { BAND_HUE, bandColour } from "./sketch/band-colour.ts";

/** The line kinds of the 3D view, named like the theme tokens (sketchUnder, bodyEdge, gridMajor, axisX, selection ...). */
export type LineKind = LineTypeName;
export const lineKinds: readonly LineKind[] = lineTypeNames;

export interface LineStyle {
  /** CSS colour, "#rrggbb". */
  color: string;
  /** Width in CSS pixels. */
  width: number;
  /** Dash pattern in CSS pixels, dash first: [8, 5] or [14, 4, 3, 4]. Empty = solid. */
  dash: readonly number[];
}

export interface ViewportStyle {
  /** Clear colour of the view. */
  background: string;
  /** Surface colours of a body: lit from above, side, in shade. The base colour of the shaded body is `top`. */
  body: { top: string; left: string; right: string };
  lines: Record<LineKind, LineStyle>;
  /** Fill opacities (0..1) of the origin planes, the selection and the hover highlight. */
  opacity: { plane: number; selection: number; hover: number; profileFill: number };
  /**
   * Colours of the sketch layer that are no line kind: the alternative colour of fully constrained geometry (token
   * sketchFullBlue), the colour of a tool's rubber band (the theme's primary colour; there is no token of its own yet),
   * the colours of the live dimensions of a shape being drawn (the other values, and a wrong value; the active one uses `preview`),
   * the colour of dimension texts, and the colours of the inner band of determined regions (searched per theme and mode so the
   * contour line stays readable on it, see sketch/band-colour.ts).
   */
  sketch: { fullBlue: string; preview: string; liveQuiet: string; liveInvalid: string; dimText: string; band: { green: string; blue: string } };
  /**
   * The preview of a command (the extrude body before OK): a translucent tint in the theme's primary colour with a dashed edge
   * in the same colour (extrude preview). The primary colour has at least 3:1 against the view colour and
   * the lit top of a body in every theme and mode (tested), so the edges read over both the body and the grid.
   */
  preview: { fill: string; fillOpacity: number; edge: LineStyle };
  /**
   * The flat fills of pickable profiles (extrude command). At rest the fill uses the profile colour, hovered and selected ones use the
   * hover and selection colours at a higher opacity plus an outline in the line style of that state, so the three states differ in
   * colour or strength, not by a faint change (tested). Opacities are the encoded ones (as in CSS); the renderer corrects them for
   * its linear blending.
   */
  profile: {
    rest: { color: string; opacity: number };
    hover: { color: string; opacity: number; outline: LineStyle };
    selected: { color: string; opacity: number; outline: LineStyle };
  };
  /**
   * The extrude arrow: its colour at rest, its colour while hovered or dragged, the colour of the halo around it (the view colour:
   * it keeps the arrow apart from the tinted preview it points through), and its head size in CSS pixels (constant on the screen).
   */
  handle: { color: string; hoverColor: string; halo: string; width: number; headLengthPx: number; headRadiusPx: number };
}

/** Opacity of the translucent body of a preview (encoded, as in CSS). */
export const PREVIEW_FILL_OPACITY = 0.34;
/** Dashes of the preview's edges (5 3). */
export const PREVIEW_EDGE_DASH: readonly number[] = [5, 3];
/** Opacities of the profile fills at rest, hovered and selected. The hover and selection fills are stronger than the ones of body faces (theme opacity 0.14 and 0.22): a profile is a thin flat area. */
export const PROFILE_REST_OPACITY = 0.2;
export const PROFILE_HOVER_OPACITY = 0.34;
export const PROFILE_SELECTED_OPACITY = 0.5;
/** The extrude arrow: shaft width and head size in CSS pixels. */
export const HANDLE_WIDTH_PX = 2;
export const HANDLE_HEAD_LENGTH_PX = 20;
export const HANDLE_HEAD_RADIUS_PX = 8;
/** The halo around the arrow reaches this many pixels beyond it. */
export const HANDLE_HALO_PX = 1.75;

/** "8 5" -> [8, 5]; "" and "none" -> []. Values that are not positive numbers are dropped. */
export function parseDash(text: string): number[] {
  const t = text.trim();
  if (t === "" || t === "none") return [];
  const parts = t.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  // Like SVG: an odd number of values repeats once, so "5" is 5 on, 5 off.
  return parts.length % 2 === 1 ? [...parts, ...parts] : parts;
}

/** The viewport style of a theme in light or dark mode. */
export function styleFromTheme(themeKey: ThemeKey, mode: Mode): ViewportStyle {
  const theme = getTheme(themeKey);
  const tokens = theme.tokens[mode];
  const lines = {} as Record<LineKind, LineStyle>;
  for (const kind of lineKinds) {
    // Every line kind has a colour token of the same name, except "centre" which also has one ("centre") and the axes.
    const color = (tokens as Record<string, string>)[kind];
    if (color === undefined) throw new Error(`The theme "${themeKey}" has no colour for the line kind "${kind}".`);
    lines[kind] = { color, width: theme.weights[kind], dash: parseDash(theme.dashes[kind]) };
  }
  return {
    background: tokens.viewport,
    body: { top: tokens.faceTop, left: tokens.faceLeft, right: tokens.faceRight },
    lines,
    opacity: { ...theme.opacity },
    sketch: {
      fullBlue: tokens.sketchFullBlue,
      preview: tokens.primary,
      liveQuiet: tokens.muted,
      liveInvalid: tokens.error,
      dimText: tokens.dimText,
      band: {
        green: bandColour(tokens.sketchFull, [tokens.viewport, tokens.viewport2], BAND_HUE.green, theme.highContrast),
        blue: bandColour(tokens.sketchFullBlue, [tokens.viewport, tokens.viewport2], BAND_HUE.blue, theme.highContrast),
      },
    },
    preview: { fill: tokens.primary, fillOpacity: PREVIEW_FILL_OPACITY, edge: { color: tokens.primary, width: theme.weights.bodyEdge, dash: PREVIEW_EDGE_DASH } },
    profile: {
      rest: { color: tokens.profileFill, opacity: PROFILE_REST_OPACITY },
      hover: { color: lines.hover.color, opacity: PROFILE_HOVER_OPACITY, outline: lines.hover },
      selected: { color: lines.selection.color, opacity: PROFILE_SELECTED_OPACITY, outline: lines.selection },
    },
    handle: { color: tokens.primary, hoverColor: lines.hover.color, halo: tokens.viewport, width: HANDLE_WIDTH_PX, headLengthPx: HANDLE_HEAD_LENGTH_PX, headRadiusPx: HANDLE_HEAD_RADIUS_PX },
  };
}

/** A fixed pattern of dashes expressed as passes the line material can draw: one pass per dash of the pattern. */
export interface DashPass {
  /** Length of the dash, px. */
  dash: number;
  /** Gap that completes the period (the whole pattern length minus the dash), px. */
  gap: number;
  /** Shift of the pattern, px, so this dash starts at its place in the period. */
  offset: number;
}

/**
 * Line materials draw one dash and one gap. A pattern with several dashes ("14 4 3 4": long, gap, short, gap) is drawn as
 * several passes of the same line, each with the period of the whole pattern: pass i shows only dash i.
 */
export function dashPasses(pattern: readonly number[]): DashPass[] {
  if (pattern.length < 2) return [];
  const period = pattern.reduce((a, b) => a + b, 0);
  const passes: DashPass[] = [];
  let start = 0;
  for (let i = 0; i < pattern.length; i += 2) {
    const dash = pattern[i]!;
    const gapAfter = pattern[i + 1] ?? 0;
    passes.push({ dash, gap: period - dash, offset: (period - start) % period });
    start += dash + gapAfter;
  }
  return passes;
}
