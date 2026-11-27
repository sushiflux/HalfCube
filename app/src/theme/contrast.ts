// WCAG 2.x contrast maths and the list of text/background pairs that every theme has to meet in both modes.
import type { ColourTokenName, Mode, Theme } from "./themes.ts";

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m?.[1]) throw new Error(`Not a #rrggbb colour: "${hex}".`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The share of the primary colour in the tint behind the active value field (index.css: --c-field-tint). */
export const FIELD_TINT_SHARE = 0.18;
/** The share of the error colour in the tint behind a wrong value field (index.css: --c-field-tint-error). */
export const FIELD_TINT_ERROR_SHARE = 0.12;

/** The share of the muted colour in the track of progress bars and rings (index.css: --c-progress-track). */
export const PROGRESS_TRACK_SHARE = 0.18;

/** A colour mixed over the surface as index.css's color-mix does it (srgb, rounded per channel). */
export function mixOverSurface(colour: string, surface: string, share: number): string {
  const [pr, pg, pb] = parseHex(colour);
  const [sr, sg, sb] = parseHex(surface);
  const mix = (a: number, b: number) => Math.round(a * share + b * (1 - share));
  return `#${[mix(pr, sr), mix(pg, sg), mix(pb, sb)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export type PairKind = "text" | "brand" | "ui" | "line";

/** Colours that are mixed in the stylesheet, not stored in a theme: the tints behind the value field (index.css). */
export type DerivedColourName = "fieldTint" | "fieldTintError" | "progressTrack";

/** Foreground: a theme token, a derived tint, or a fixed brand colour per mode (the wordmark). */
export type PairColour = ColourTokenName | DerivedColourName | { fixed: Record<Mode, string> };

export interface ContrastPair {
  id: string;
  label: string;
  kind: PairKind;
  fg: PairColour;
  /** The worst of these backgrounds counts. */
  bgs: readonly (ColourTokenName | DerivedColourName)[];
}

function resolveColour(tokens: Theme["tokens"][Mode], name: ColourTokenName | DerivedColourName): string {
  if (name === "fieldTint") return mixOverSurface(tokens.primary, tokens.surface, FIELD_TINT_SHARE);
  if (name === "fieldTintError") return mixOverSurface(tokens.error, tokens.surface, FIELD_TINT_ERROR_SHARE);
  if (name === "progressTrack") return mixOverSurface(tokens.muted, tokens.surface, PROGRESS_TRACK_SHARE);
  return tokens[name];
}

/** Minimum ratio per kind: normal themes, and the High contrast theme. */
export const contrastTargets: Record<PairKind, { normal: number; high: number }> = {
  text: { normal: 4.5, high: 7 },
  brand: { normal: 4.5, high: 7 },
  ui: { normal: 3, high: 4.5 },
  line: { normal: 3, high: 4.5 },
};

const view: readonly ColourTokenName[] = ["viewport", "viewport2"];
const bodyFaces: readonly ColourTokenName[] = ["faceTop", "faceLeft", "faceRight"];

export const contrastPairs: readonly ContrastPair[] = [
  { id: "t1", label: "Text on background", kind: "text", fg: "text", bgs: ["bg"] },
  { id: "t2", label: "Text on surface", kind: "text", fg: "text", bgs: ["surface"] },
  { id: "t3", label: "Text on surface 2", kind: "text", fg: "text", bgs: ["surface2"] },
  { id: "t4", label: "Text on selected surface", kind: "text", fg: "text", bgs: ["primarySoft"] },
  { id: "t5", label: "Muted text on background", kind: "text", fg: "muted", bgs: ["bg"] },
  { id: "t6", label: "Muted text on surface", kind: "text", fg: "muted", bgs: ["surface"] },
  { id: "t7", label: "Muted text on surface 2", kind: "text", fg: "muted", bgs: ["surface2"] },
  { id: "t8", label: "Primary colour as text on surface", kind: "text", fg: "primary", bgs: ["surface"] },
  { id: "t9", label: "Muted text on selected surface (error code in the hint of the update slot)", kind: "text", fg: "muted", bgs: ["primarySoft"] },
  { id: "t10", label: "Text on primary button", kind: "text", fg: "onPrimary", bgs: ["primary"] },
  { id: "t11", label: "Text on create button", kind: "text", fg: "onCreate", bgs: ["create"] },
  { id: "t12", label: "Create colour as text on surface", kind: "text", fg: "create", bgs: ["surface"] },
  { id: "t13", label: "Destructive colour as text on surface", kind: "text", fg: "destructive", bgs: ["surface"] },
  { id: "t14", label: "Text on destructive button", kind: "text", fg: "onDestructive", bgs: ["destructive"] },
  { id: "t15", label: "Text in the view", kind: "text", fg: "text", bgs: view },
  { id: "t16", label: "Muted text in the view", kind: "text", fg: "muted", bgs: view },
  { id: "t18", label: "Error colour as text on surface (status bar)", kind: "text", fg: "error", bgs: ["surface"] },
  { id: "t17", label: "Dimension text in the view", kind: "text", fg: "dimText", bgs: view },
  { id: "t19", label: "Dimension text on its value label (surface)", kind: "text", fg: "dimText", bgs: ["surface"] },
  // The value fields at the geometry: the filled label ("Etikett") and the text on the dimension line.
  { id: "t20", label: "Value label, grey (follows the pointer): text on the muted fill", kind: "text", fg: "surface", bgs: ["muted"] },
  { id: "t21", label: "Value label, red (wrong value): text on the error fill", kind: "text", fg: "surface", bgs: ["error"] },
  { id: "t22", label: "Message under a value (error colour) in the view", kind: "text", fg: "error", bgs: view },
  { id: "t23", label: "Value label, selected text: primary on the on-primary colour", kind: "text", fg: "primary", bgs: ["onPrimary"] },
  { id: "u8", label: "Live dimension line and the frame of the active value field (primary) in the view", kind: "ui", fg: "primary", bgs: view },
  // The active and the wrong value field: a tint with a frame all round. Selected text inside them is on-primary on primary (t10) and surface on error (t21).
  { id: "t24", label: "Value field, active: text on the primary tint", kind: "text", fg: "text", bgs: ["fieldTint"] },
  { id: "t25", label: "Value field, wrong value: error text on the error tint", kind: "text", fg: "error", bgs: ["fieldTintError"] },
  { id: "u9", label: "Value field, active: primary frame on the primary tint", kind: "ui", fg: "primary", bgs: ["fieldTint"] },
  { id: "u11", label: "Value field, editable but not active: neutral (muted) frame in the view and on the surface; its text is t2", kind: "ui", fg: "muted", bgs: [...view, "surface"] },
  { id: "u10", label: "Value field, wrong value: error frame in the view and on the error tint", kind: "ui", fg: "error", bgs: [...view, "fieldTintError"] },
  {
    id: "m1",
    label: 'Wordmark "Half" on title bar',
    kind: "brand",
    fg: { fixed: { light: "#16476e", dark: "#ffffff" } },
    bgs: ["surface"],
  },
  {
    id: "m2",
    label: 'Wordmark "Cube" on title bar',
    kind: "brand",
    fg: { fixed: { light: "#1f75ae", dark: "#4cd1e0" } },
    bgs: ["surface"],
  },
  { id: "u1", label: "Input border on surface", kind: "ui", fg: "lineStrong", bgs: ["surface"] },
  { id: "u2", label: "Primary on selected surface", kind: "ui", fg: "primary", bgs: ["primarySoft"] },
  { id: "u3", label: "Toggle on, on surface", kind: "ui", fg: "toggleOn", bgs: ["surface"] },
  { id: "u4", label: "Toggle off, on surface", kind: "ui", fg: "toggleOff", bgs: ["surface"] },
  {
    id: "u5",
    label: "Primary (selection line, focus) on surface and background",
    kind: "ui",
    fg: "primary",
    bgs: ["surface", "bg"],
  },
  { id: "u6", label: "Function icon accent on toolbar, background and selected surface", kind: "ui", fg: "fn", bgs: ["surface", "bg", "primarySoft"] },
  // The update views (title bar dot, update slot, update window): marks in the primary, destructive and toggle colours on the surfaces they sit on.
  { id: "u12", label: "Update dot and ring (primary) on the title bar, its hover surface and the tinted update slot", kind: "ui", fg: "primary", bgs: ["surface", "surface2", "primarySoft"] },
  { id: "u13", label: "Update warning triangle (destructive) on the title bar, its hover surface and the tinted update slot", kind: "ui", fg: "destructive", bgs: ["surface", "surface2", "primarySoft"] },
  { id: "u14", label: "Progress arc and bar (primary) on their track (muted over the surface)", kind: "ui", fg: "primary", bgs: ["progressTrack"] },
  { id: "u15", label: "Progress bar 'ready' (toggle on) on its track, the check 'up to date' on the slot card", kind: "ui", fg: "toggleOn", bgs: ["progressTrack", "surface2", "primarySoft"] },
  { id: "u16", label: "Warning icon of the restart dialog (the amber of the hover highlight) on the surface", kind: "ui", fg: "hover", bgs: ["surface"] },
  { id: "u7", label: "Failed-step icon on the tree band and surface", kind: "ui", fg: "error", bgs: ["surface", "primarySoft", "surface2"] },
  { id: "l1", label: "Sketch line, under-constrained", kind: "line", fg: "sketchUnder", bgs: view },
  { id: "l2", label: "Sketch line, fully constrained", kind: "line", fg: "sketchFull", bgs: view },
  { id: "l2b", label: "Sketch line, fully constrained, blue (setting)", kind: "line", fg: "sketchFullBlue", bgs: view },
  { id: "l3", label: "Sketch line, over-constrained", kind: "line", fg: "sketchOver", bgs: view },
  { id: "l4", label: "Construction line", kind: "line", fg: "construction", bgs: view },
  { id: "l5", label: "Centre line", kind: "line", fg: "centre", bgs: view },
  { id: "l6", label: "Dimension line", kind: "line", fg: "dimLine", bgs: view },
  { id: "l7", label: "Constraint symbols", kind: "line", fg: "constraint", bgs: view },
  { id: "l8", label: "Projected geometry", kind: "line", fg: "projected", bgs: view },
  { id: "l9", label: "Body edges", kind: "line", fg: "bodyEdge", bgs: [...view, ...bodyFaces] },
  { id: "l10", label: "Silhouette edges", kind: "line", fg: "silhouette", bgs: [...view, ...bodyFaces] },
  { id: "l11", label: "Hidden edges", kind: "line", fg: "hiddenEdge", bgs: [...view, ...bodyFaces] },
  { id: "l12", label: "Grid, major lines", kind: "line", fg: "gridMajor", bgs: view },
  { id: "l13", label: "Grid, minor lines", kind: "line", fg: "gridMinor", bgs: view },
  { id: "l14", label: "Axis X", kind: "line", fg: "axisX", bgs: view },
  { id: "l15", label: "Axis Y", kind: "line", fg: "axisY", bgs: view },
  { id: "l16", label: "Axis Z", kind: "line", fg: "axisZ", bgs: view },
  { id: "l17", label: "Origin plane outline", kind: "line", fg: "plane", bgs: view },
  { id: "l18", label: "Selection highlight", kind: "line", fg: "selection", bgs: [...view, "faceLeft"] },
  { id: "l19", label: "Hover highlight", kind: "line", fg: "hover", bgs: [...view, "faceTop"] },
  { id: "l20", label: "Error", kind: "line", fg: "error", bgs: [...view, "faceTop", "faceLeft"] },
  { id: "l21", label: "Dimension label border on surface", kind: "line", fg: "dimLine", bgs: ["surface"] },
  { id: "l22", label: "Sketch state sample in the palette: under-constrained", kind: "line", fg: "sketchUnder", bgs: ["surface"] },
  { id: "l23", label: "Sketch state sample in the palette: fully constrained", kind: "line", fg: "sketchFull", bgs: ["surface"] },
  { id: "l24", label: "Sketch state sample in the palette: fully constrained, blue", kind: "line", fg: "sketchFullBlue", bgs: ["surface"] },
  { id: "l25", label: "Sketch state sample in the palette: over-constrained", kind: "line", fg: "sketchOver", bgs: ["surface"] },
];

export interface PairResult {
  pair: ContrastPair;
  ratio: number;
  worstBg: ColourTokenName | DerivedColourName;
  target: number;
  pass: boolean;
}

export function evaluatePairs(theme: Theme, mode: Mode): PairResult[] {
  const tokens = theme.tokens[mode];
  return contrastPairs.map((pair) => {
    const fg = typeof pair.fg === "string" ? resolveColour(tokens, pair.fg) : pair.fg.fixed[mode];
    const first = pair.bgs[0];
    if (!first) throw new Error(`Pair ${pair.id} has no background.`);
    let worst = { ratio: Infinity, bg: first };
    for (const bg of pair.bgs) {
      const ratio = contrastRatio(fg, resolveColour(tokens, bg));
      if (ratio < worst.ratio) worst = { ratio, bg };
    }
    const target = contrastTargets[pair.kind][theme.highContrast ? "high" : "normal"];
    return { pair, ratio: worst.ratio, worstBg: worst.bg, target, pass: worst.ratio >= target };
  });
}
