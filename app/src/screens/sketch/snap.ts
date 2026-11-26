// Where a clicked point goes: onto an existing point, onto the origin, onto a line or circle, or free. Snapping only ever
// targets sketch geometry that exists (point, origin, curve) plus the horizontal/vertical direction of the line being drawn;
// there is no snapping to the grid (the grid is only a display aid). Pure functions.
import type { PointInput, SketchView } from "../../model/index.ts";
import { SKETCH_ORIGIN } from "../../document/types.ts";
import { angleDeg, length, sub, type P } from "./geometry.ts";
import type { Pointer } from "./tool.ts";

export type AnchorKind = "free" | "point" | "origin" | "curve";

/** A resolved position for a new point. */
export interface Anchor {
  kind: AnchorKind;
  input: PointInput;
  at: P;
  /** The existing point ("p3" or "@origin") for kinds point and origin. */
  ref?: string;
  /** The curve a new point lies on, for kind curve. */
  curve?: string;
}

const FREE = (at: P): Anchor => ({ kind: "free", input: { x: at[0], y: at[1] }, at });

export function anchorOf(pointer: Pointer, view: SketchView): Anchor {
  const hit = pointer.hit;
  if (hit?.kind === "point") {
    const p = view.points.find((q) => q.id === hit.id);
    if (p) return { kind: "point", input: { snap: p.id }, at: [p.x, p.y], ref: p.id };
  }
  if (hit?.kind === "origin") return { kind: "origin", input: { snap: SKETCH_ORIGIN }, at: [0, 0], ref: SKETCH_ORIGIN };
  if (hit?.kind === "line" || hit?.kind === "circle") {
    return { kind: "curve", input: { x: hit.u, y: hit.v, onCurve: hit.id }, at: [hit.u, hit.v], curve: hit.id };
  }
  return FREE(pointer.at);
}

/** An anchor for a point already in the sketch (a chain continues from the end point it just made). */
export function anchorOfPoint(view: SketchView, id: string): Anchor | null {
  const p = view.points.find((q) => q.id === id);
  return p ? { kind: "point", input: { snap: p.id }, at: [p.x, p.y], ref: p.id } : null;
}

/** How near (in screen px) the rubber band must be to the horizontal or vertical to be taken as exactly that. */
export const DIRECTION_TOLERANCE_PX = 7;

export type Direction = "horizontal" | "vertical" | null;

/**
 * A free end point close to the horizontal or vertical through the start is that direction (hint "horizontal" or
 * "vertical"); the line then gets the constraint, not just a nearly horizontal position. Returns the direction and the
 * end point moved onto it.
 */
export function inferDirection(start: P, end: P, pxPerMm: number): { direction: Direction; end: P } {
  const d = sub(end, start);
  if (length(d) * pxPerMm < 2 * DIRECTION_TOLERANCE_PX) return { direction: null, end };
  const tol = DIRECTION_TOLERANCE_PX / pxPerMm;
  if (Math.abs(d[1]) <= tol) return { direction: "horizontal", end: [end[0], start[1]] };
  if (Math.abs(d[0]) <= tol) return { direction: "vertical", end: [start[0], end[1]] };
  return { direction: null, end };
}

/** The angle the editor gets for an inferred direction: it turns 0/180 into horizontal and 90/270 into vertical. */
export const directionAngle = (direction: Exclude<Direction, null>): number => (direction === "horizontal" ? 0 : 90);

export { angleDeg };
