// Public types of the sketch rendering layer (step U2a). The tools and overlays of the main window import only this file.
// Members may be added; existing ones are never renamed or removed.
import type { DimensionKind } from "../../document/types.ts";
import type { SketchView } from "../../model/editors.ts";

/** How determined regions are highlighted: a narrow band on the inner side of the contour, or a 25 % fill. */
export type SketchHighlight = "band" | "fill";
/** The colour of fully constrained geometry: token sketchFull (green) or sketchFullBlue. */
export type SketchFullColour = "green" | "blue";
export interface SketchLayerOptions {
  highlight: SketchHighlight;
  colour: SketchFullColour;
  showConstraints: boolean;
  showDimensions: boolean;
  /** Draw the measuring graphics of the values of a shape being drawn (the look "Maßlinie"). Default true; the look "Etikett" leaves them out. */
  liveDimensions?: boolean;
}
export type SketchHit =
  | { kind: "point"; id: string }
  | { kind: "line"; id: string; u: number; v: number }
  | { kind: "circle"; id: string; u: number; v: number }
  | { kind: "dimension"; id: string }
  | { kind: "region"; key: string }
  | { kind: "origin" }
  | { kind: "axis"; axis: "u" | "v" };
/** How a live value of a shape being drawn is shown: the active field (the one that is typed into), the others, or a wrong value. */
export type LiveTone = "active" | "quiet" | "invalid";
/**
 * The measuring graphics of one value of the shape being drawn: the same extension lines, dimension line and arrowheads,
 * or arc, that the finished dimension gets. Distances in pixels are turned into mm with the current scale, so the offset
 * from the edge is the same at every zoom and never depends on other dimensions.
 */
export type LiveDimension =
  /** A length between a and b, the dimension line `offsetPx` away from them towards the unit direction n. */
  | { shape: "linear"; a: [number, number]; b: [number, number]; n: [number, number]; offsetPx: number }
  /** An angle at `vertex` from direction `start` (radians) through `sweep`; `reach` is how far the two rays run (mm). */
  | { shape: "angle"; vertex: [number, number]; start: number; sweep: number; radiusPx: number; reach: [number, number] }
  /** The diameter of a circle, measured along the unit direction `dir` (towards the pointer). */
  | { shape: "diameter"; c: [number, number]; r: number; dir: [number, number] };
export interface LiveDimensionItem { id: string; tone: LiveTone; dim: LiveDimension }
export interface SketchPreview {            // tool rubber band, sketch coordinates in mm
  lines?: { a: [number, number]; b: [number, number]; construction?: boolean }[];
  circles?: { c: [number, number]; r: number; construction?: boolean }[];
  points?: [number, number][];
  hints?: { kind: "horizontal" | "vertical" | "coincident" | "onCurve" | "tangent" | "perpendicular" | "parallel"; at: [number, number] }[];
  guides?: { a: [number, number]; b: [number, number] }[];   // dashed alignment guides
  /** The dimension being placed: drawn with the graphics of a real dimension (extension lines, dimension line, arrowheads, angle arc). */
  dimension?: { kind: DimensionKind; refs: string[]; reverse?: boolean[]; label: [number, number] };
  /** The values of the shape being drawn, each with its measuring graphics; the layer reports where their texts go (liveAnchors). */
  live?: LiveDimensionItem[];
}
export interface ScreenAnchor { id: string; x: number; y: number; angle?: number }   // CSS px inside the viewport element
export interface SketchLayer {
  setSketch(view: SketchView | null, options: SketchLayerOptions): void;
  setPreview(preview: SketchPreview | null): void;
  setHover(hit: SketchHit | null): void;
  setSelection(ids: string[]): void;
  pick(x: number, y: number, tolerancePx?: number): SketchHit | null;   // priority: point > dimension > line/circle > region > origin/axis
  toSketch(x: number, y: number): { u: number; v: number } | null;
  toScreen(u: number, v: number): { x: number; y: number };
  pxPerMm(): number;
  dimensionAnchors(): ScreenAnchor[];    // where the UI puts the HTML value labels and input boxes
  liveAnchors(): ScreenAnchor[];         // where the UI puts the value of each live dimension (id of the item) while a shape is drawn
  constraintAnchors(): ScreenAnchor[];   // where the UI puts the HTML constraint glyphs (beside their entity, no overlaps)
  subscribe(listener: () => void): () => void;   // after camera or sketch changes, so HTML overlays can follow
  alignToSketch(animate?: boolean): void;        // eye on the plane normal, sketch u to the right, v up
  /**
   * Brings the elements (point, line and circle ids) into sight: the view pans to their middle, zooms out only when they do not
   * fit and in only when they would be tiny, and keeps its orientation; animated, no animation with reduced motion. False when
   * none of the ids is in the sketch.
   */
  focusOn(ids: readonly string[], animate?: boolean): boolean;
}
