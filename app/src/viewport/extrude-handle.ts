// The drag arrow of the extrude command: where it is drawn, what the pointer hits, and which length a pointer position means.
// Pure functions (no three.js, no DOM), tested in Node.
//
// The arrow runs along an axis (origin, unit direction). Dragging maps the pointer to a point of that axis the way a user sees
// it: the axis is a straight line on the screen, and the pointer is projected onto that screen line (the foot of the
// perpendicular, in pixels); the perspective is undone along the line, so the point under the pointer is the point on the axis
// the user sees there. It works at every camera angle except when the axis points at the eye (its image shrinks to a dot), where
// there is no way to tell a length and the function says so by returning null.
import { cameraBasis, worldToScreen, worldPerPixel, type CameraBasis, type Lens, type ViewState } from "./camera.ts";
import { add, dot, normalize, scale, sub, type Vec3 } from "./math.ts";
import { pointSegmentDistance2D } from "./picking.ts";
import type { ExtrudeHandle } from "./types.ts";

/** The axis image on the screen must be at least this long (pixels, over a baseline of half the view distance) to give a length. */
const MIN_AXIS_PX = 0.5;
/** Pixels around the shaft and around the head in which the pointer counts as on the arrow. */
export const SHAFT_PICK_PX = 7;
export const HEAD_PICK_MARGIN_PX = 4;

export interface HandleGeometry {
  /** The tip of the arrow, world. */
  tip: Vec3;
  /** The centre of the base of the head, world: the tip pulled back by the head length (in pixels at the tip's depth). */
  base: Vec3;
  /** The unit direction the head points to: the axis, flipped for a negative distance. */
  dir: Vec3;
  /** Radius of the head's base, world. */
  radius: number;
  /** Length of the head, world. */
  length: number;
}

export const unitDirection = (h: ExtrudeHandle): Vec3 => normalize(h.direction);

/** True when the handle can be drawn: finite numbers and a direction with length. */
export function handleIsValid(h: ExtrudeHandle): boolean {
  return h.origin.every(Number.isFinite) && h.direction.every(Number.isFinite) && Number.isFinite(h.distance) && Math.hypot(...h.direction) > 1e-12;
}

export const handleTip = (h: ExtrudeHandle): Vec3 => add(h.origin, scale(unitDirection(h), h.distance));

/**
 * Size and place of the head so that it has a constant size on the screen: `lengthPx` and `radiusPx` are converted to world
 * units at the depth of the tip. `grow` enlarges it (hover).
 */
export function handleGeometry(view: ViewState, lens: Lens, h: ExtrudeHandle, lengthPx: number, radiusPx: number, grow = 1, basis: CameraBasis = cameraBasis(view)): HandleGeometry {
  const tip = handleTip(h);
  const depth = Math.max(1e-6, dot(sub(tip, basis.eye), basis.forward));
  const wpp = worldPerPixel(lens, depth);
  const dir = scale(unitDirection(h), h.distance < 0 ? -1 : 1);
  const length = lengthPx * grow * wpp;
  return { tip, base: sub(tip, scale(dir, length)), dir, radius: radiusPx * grow * wpp, length };
}

/**
 * The signed position along the axis (mm from the origin, in units of the unit direction) that the pointer at (x, y) points at,
 * or null when the axis points at the eye or lies behind it. See the file comment for what "points at" means.
 */
export function axisParameterAtPointer(view: ViewState, lens: Lens, origin: Vec3, direction: Vec3, x: number, y: number, basis: CameraBasis = cameraBasis(view)): number | null {
  const d = normalize(direction);
  // A baseline on the axis near the view target: the foot of the target on the axis and a point half a view distance further on.
  const s0 = dot(sub(view.target, origin), d);
  const length = Math.max(1e-6, view.distance * 0.5);
  const a = worldToScreen(view, lens, add(origin, scale(d, s0)), basis);
  const b = worldToScreen(view, lens, add(origin, scale(d, s0 + length)), basis);
  if (!a || !b) return null;
  const sx = b.x - a.x, sy = b.y - a.y;
  const len2 = sx * sx + sy * sy;
  if (len2 < MIN_AXIS_PX * MIN_AXIS_PX) return null;
  // Foot of the pointer on the screen line, as a fraction sigma of the screen segment (unbounded: the line goes on).
  const sigma = ((x - a.x) * sx + (y - a.y) * sy) / len2;
  // Undo the perspective: the point at fraction tau of the 3D baseline appears at fraction sigma = tau*zb / (za + tau*(zb - za)).
  const denominator = b.depth * (1 - sigma) + sigma * a.depth;
  if (Math.abs(denominator) < 1e-12) return null; // the vanishing point of the axis
  const tau = (sigma * a.depth) / denominator;
  // The point must be in front of the camera.
  if (a.depth + tau * (b.depth - a.depth) <= 1e-9) return null;
  return s0 + tau * length;
}

/**
 * The new distance while dragging: the distance the arrow had when the drag started plus the way the pointer has travelled along
 * the axis since the grab (so the arrow does not jump to the pointer when it is grabbed). null while the axis cannot be read.
 */
export function distanceAfterDrag(view: ViewState, lens: Lens, handle: ExtrudeHandle, startDistance: number, grabParameter: number, x: number, y: number): number | null {
  const now = axisParameterAtPointer(view, lens, handle.origin, handle.direction, x, y);
  return now === null ? null : startDistance + (now - grabParameter);
}

export type HandlePart = "head" | "shaft";

export interface HandleHit {
  part: HandlePart;
  /** Pixels between the pointer and the part (0 inside the head). */
  distancePx: number;
}

/**
 * What the pointer is on: the head (a capsule on the screen from the tip to the middle of its base, as wide as the head) or the
 * shaft (the segment from the origin to the base of the head), within a few pixels. The head wins where both apply.
 */
export function hitHandle(view: ViewState, lens: Lens, h: ExtrudeHandle, lengthPx: number, radiusPx: number, x: number, y: number, basis: CameraBasis = cameraBasis(view)): HandleHit | null {
  const g = handleGeometry(view, lens, h, lengthPx, radiusPx, 1, basis);
  const tip = worldToScreen(view, lens, g.tip, basis);
  const base = worldToScreen(view, lens, g.base, basis);
  const origin = worldToScreen(view, lens, h.origin, basis);
  if (tip) {
    const to = base ?? tip;
    const { distance } = pointSegmentDistance2D(x, y, tip.x, tip.y, to.x, to.y);
    if (distance <= radiusPx + HEAD_PICK_MARGIN_PX) return { part: "head", distancePx: Math.max(0, distance - radiusPx) };
  }
  if (tip && origin && Math.abs(h.distance) > 1e-9) {
    const { distance } = pointSegmentDistance2D(x, y, origin.x, origin.y, (base ?? tip).x, (base ?? tip).y);
    if (distance <= SHAFT_PICK_PX) return { part: "shaft", distancePx: distance };
  }
  return null;
}
