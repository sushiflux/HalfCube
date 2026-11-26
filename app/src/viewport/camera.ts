// Camera math of the 3D view: a turntable camera with Z up, described by a target point, an azimuth, an elevation and a
// distance. Everything here is pure (no three.js, no DOM) so it is tested in Node.
//
// Conventions (right-handed, Z up, millimetres):
//   azimuth 0, elevation 0  the eye sits on -Y and looks along +Y ("Vorne" / front); +X is on the right of the screen
//   azimuth increases       the eye moves towards +X (azimuth pi/2 = view from the right, pi = from the back)
//   elevation pi/2          the eye is above the target ("Oben" / top), elevation -pi/2 below it
// The view basis is built from azimuth and elevation directly, never with a look-at call, so the poles (top and bottom
// view) are well defined: the azimuth then says which way "up" points on the screen.
import { add, clamp, cross, dot, length, normalize, scale, sub, type Bounds, type Vec3, boundsCenter, boundsCorners, isEmptyBounds } from "./math.ts";

export interface ViewState {
  target: Vec3;
  /** Radians, see the conventions above. */
  azimuth: number;
  /** Radians, clamped to [-pi/2, pi/2]. */
  elevation: number;
  /** Distance from the eye to the target (mm). */
  distance: number;
}

/** What the camera needs to know about the screen: vertical field of view (radians) and the size in CSS pixels. */
export interface Lens {
  fovY: number;
  width: number;
  height: number;
}

export interface Ray {
  origin: Vec3;
  /** Unit length. */
  dir: Vec3;
}

export interface CameraBasis {
  eye: Vec3;
  right: Vec3;
  up: Vec3;
  /** Unit vector from the eye towards the target. */
  forward: Vec3;
}

export const DEFAULT_FOV_Y = (35 * Math.PI) / 180;
export const MIN_DISTANCE = 0.05;
export const MAX_DISTANCE = 1e7;
export const HALF_PI = Math.PI / 2;
/** Radians of orbit per pixel of mouse travel. */
export const ORBIT_RADIANS_PER_PIXEL = 0.0065;

/** The start view: from the front, the right and above (the isometric direction). */
export const HOME_AZIMUTH = Math.PI / 4;
export const HOME_ELEVATION = Math.atan(1 / Math.SQRT2);

export function defaultView(): ViewState {
  return { target: [0, 0, 0], azimuth: HOME_AZIMUTH, elevation: HOME_ELEVATION, distance: 300 };
}

/** Unit vector from the target to the eye. */
export function eyeDirection(azimuth: number, elevation: number): Vec3 {
  const ce = Math.cos(elevation);
  return [Math.sin(azimuth) * ce, -Math.cos(azimuth) * ce, Math.sin(elevation)];
}

export function cameraBasis(view: ViewState): CameraBasis {
  const toEye = eyeDirection(view.azimuth, view.elevation);
  const forward = scale(toEye, -1);
  const right: Vec3 = [Math.cos(view.azimuth), Math.sin(view.azimuth), 0];
  const up = cross(right, forward);
  const eye = add(view.target, scale(toEye, view.distance));
  return { eye, right, up, forward };
}

export const tanHalfFov = (lens: Lens): number => Math.tan(lens.fovY / 2);

/** Millimetres per CSS pixel on a plane at the given distance in front of the camera. */
export function worldPerPixel(lens: Lens, depth: number): number {
  return (2 * depth * tanHalfFov(lens)) / Math.max(1, lens.height);
}

/** Pixels per millimetre on a plane at the given depth: what dash patterns are scaled with. */
export function pixelsPerWorld(lens: Lens, depth: number): number {
  return Math.max(1, lens.height) / (2 * Math.max(1e-9, depth) * tanHalfFov(lens));
}

export interface ScreenPoint {
  /** CSS pixels from the left edge of the view. */
  x: number;
  /** CSS pixels from the top edge of the view. */
  y: number;
  /** Distance in front of the camera along the viewing direction (mm); positive = visible side. */
  depth: number;
}

/** Projects a world point. Returns null for a point on or behind the camera plane. */
export function worldToScreen(view: ViewState, lens: Lens, p: Vec3, basis: CameraBasis = cameraBasis(view)): ScreenPoint | null {
  const rel = sub(p, basis.eye);
  const depth = dot(rel, basis.forward);
  if (depth <= 1e-9) return null;
  const tanY = tanHalfFov(lens);
  const aspect = lens.width / Math.max(1, lens.height);
  const ndcX = dot(rel, basis.right) / (depth * tanY * aspect);
  const ndcY = dot(rel, basis.up) / (depth * tanY);
  return { x: ((ndcX + 1) / 2) * lens.width, y: ((1 - ndcY) / 2) * lens.height, depth };
}

/** The ray through a pixel of the view. */
export function screenRay(view: ViewState, lens: Lens, x: number, y: number, basis: CameraBasis = cameraBasis(view)): Ray {
  const tanY = tanHalfFov(lens);
  const aspect = lens.width / Math.max(1, lens.height);
  const ndcX = (x / Math.max(1, lens.width)) * 2 - 1;
  const ndcY = 1 - (y / Math.max(1, lens.height)) * 2;
  const dir = normalize(add(add(basis.forward, scale(basis.right, ndcX * tanY * aspect)), scale(basis.up, ndcY * tanY)));
  return { origin: basis.eye, dir };
}

/** Where a ray meets the plane through the view target that is perpendicular to the viewing direction. */
export function focalPlanePoint(view: ViewState, ray: Ray, basis: CameraBasis = cameraBasis(view)): Vec3 {
  const cos = dot(ray.dir, basis.forward);
  const t = cos > 1e-9 ? view.distance / cos : view.distance;
  return add(ray.origin, scale(ray.dir, t));
}

const clampElevation = (e: number): number => clamp(e, -HALF_PI, HALF_PI);
const clampDistance = (d: number): number => clamp(d, MIN_DISTANCE, MAX_DISTANCE);

/**
 * Orbits by a mouse travel in pixels (dragging right turns the model to the right, dragging down tips its top towards
 * the viewer). With a pivot point other than the target, that point stays where it is on the screen; otherwise the
 * view turns around its target.
 */
export function orbitByPixels(view: ViewState, dxPx: number, dyPx: number, pivot?: Vec3, radiansPerPixel = ORBIT_RADIANS_PER_PIXEL): ViewState {
  return orbitByAngles(view, -dxPx * radiansPerPixel, dyPx * radiansPerPixel, pivot);
}

export function orbitByAngles(view: ViewState, dAzimuth: number, dElevation: number, pivot?: Vec3): ViewState {
  const next: ViewState = { ...view, azimuth: view.azimuth + dAzimuth, elevation: clampElevation(view.elevation + dElevation) };
  if (!pivot) return next;
  // Keep the pivot at the same place in camera space: rotate the whole camera rigidly around it.
  const before = cameraBasis(view);
  const rel = sub(pivot, before.eye);
  const xc = dot(rel, before.right), yc = dot(rel, before.up), zc = dot(rel, before.forward);
  const after = cameraBasis(next);
  const eye = sub(pivot, add(add(scale(after.right, xc), scale(after.up, yc)), scale(after.forward, zc)));
  return { ...next, target: add(eye, scale(after.forward, view.distance)) };
}

/** Pans by a mouse travel in pixels: the point under the pointer at the target's depth follows the pointer. */
export function panByPixels(view: ViewState, lens: Lens, dxPx: number, dyPx: number): ViewState {
  const b = cameraBasis(view);
  const k = worldPerPixel(lens, view.distance);
  return { ...view, target: add(view.target, add(scale(b.right, -dxPx * k), scale(b.up, dyPx * k))) };
}

/**
 * Dolly towards (factor < 1) or away from (factor > 1) an anchor point: the camera moves along the line to the anchor,
 * so the anchor stays under the pointer. Deliberately without an indicator at the anchor and without a depth slider.
 */
export function zoomAbout(view: ViewState, anchor: Vec3, factor: number): ViewState {
  const distance = clampDistance(view.distance * factor);
  const f = distance / view.distance;
  return { ...view, distance, target: add(anchor, scale(sub(view.target, anchor), f)) };
}

/** The view that shows the whole box with the current orientation and a relative margin around it. */
export function fitBounds(view: ViewState, lens: Lens, bounds: Bounds, margin = 1.12, emptyDistance = 300): ViewState {
  if (isEmptyBounds(bounds)) return { ...view, target: [0, 0, 0], distance: emptyDistance };
  const center = boundsCenter(bounds);
  const b = cameraBasis({ ...view, target: center });
  const tanY = tanHalfFov(lens);
  const tanX = tanY * (lens.width / Math.max(1, lens.height));
  let need = 0;
  let behind = 0;
  for (const corner of boundsCorners(bounds)) {
    const rel = sub(corner, center);
    const x = Math.abs(dot(rel, b.right)) * margin;
    const y = Math.abs(dot(rel, b.up)) * margin;
    const f = dot(rel, b.forward);
    // The corner has the depth distance + f; it fits when |x| <= depth * tanX and |y| <= depth * tanY.
    need = Math.max(need, x / tanX - f, y / tanY - f);
    behind = Math.max(behind, -f);
  }
  const radius = length(sub(bounds.max, bounds.min)) / 2;
  // A point-like box still gets a sensible distance; nothing may end up behind the camera.
  const distance = clampDistance(Math.max(need, behind + radius * 0.05, radius > 1e-6 ? 0 : emptyDistance / 10));
  return { ...view, target: center, distance };
}

// --- standard views ---------------------------------------------------------------------------------------------

export type AxisKey = "+x" | "-x" | "+y" | "-y" | "+z" | "-z";
export const axisKeys: readonly AxisKey[] = ["+x", "-x", "+y", "-y", "+z", "-z"];
export type StandardViewName = "right" | "left" | "back" | "front" | "top" | "bottom";

/** The standard view whose eye sits on this axis end: +X right, -X left, +Y back, -Y front, +Z top, -Z bottom. */
export const viewNameOfAxis: Record<AxisKey, StandardViewName> = { "+x": "right", "-x": "left", "+y": "back", "-y": "front", "+z": "top", "-z": "bottom" };
export const axisOfViewName: Record<StandardViewName, AxisKey> = { right: "+x", left: "-x", back: "+y", front: "-y", top: "+z", bottom: "-z" };
export const oppositeAxis: Record<AxisKey, AxisKey> = { "+x": "-x", "-x": "+x", "+y": "-y", "-y": "+y", "+z": "-z", "-z": "+z" };

const axisVector: Record<AxisKey, Vec3> = { "+x": [1, 0, 0], "-x": [-1, 0, 0], "+y": [0, 1, 0], "-y": [0, -1, 0], "+z": [0, 0, 1], "-z": [0, 0, -1] };
export const axisDirection = (key: AxisKey): Vec3 => axisVector[key];

/** The axis end the eye looks from, if the view is a standard view (within a tolerance in radians), otherwise null. */
export function alignedAxis(view: ViewState, toleranceRad = 1e-3): AxisKey | null {
  const eye = eyeDirection(view.azimuth, view.elevation);
  const minDot = Math.cos(toleranceRad);
  for (const key of axisKeys) if (dot(eye, axisVector[key]) >= minDot) return key;
  return null;
}

const snapQuarter = (azimuth: number): number => Math.round(azimuth / HALF_PI) * HALF_PI;

/** The view looking from an axis end, with the same target and distance. Top and bottom keep the nearest quarter turn. */
export function viewFromAxis(view: ViewState, key: AxisKey): ViewState {
  switch (key) {
    case "-y": return { ...view, azimuth: 0, elevation: 0 };
    case "+y": return { ...view, azimuth: Math.PI, elevation: 0 };
    case "+x": return { ...view, azimuth: HALF_PI, elevation: 0 };
    case "-x": return { ...view, azimuth: -HALF_PI, elevation: 0 };
    case "+z": return { ...view, azimuth: snapQuarter(view.azimuth), elevation: HALF_PI };
    case "-z": return { ...view, azimuth: snapQuarter(view.azimuth), elevation: -HALF_PI };
  }
}

/** A click on an axis end: look from it, or from the opposite end when the view already looks from there. */
export function viewAfterAxisClick(view: ViewState, key: AxisKey): ViewState {
  return viewFromAxis(view, alignedAxis(view) === key ? oppositeAxis[key] : key);
}

// --- 90-degree steps (the arrows at the axis navigator) -----------------------------------------------------------

export type TurnDirection = "left" | "right";
export type TipDirection = "up" | "down" | "left" | "right";

/**
 * The standard view the camera looks from, but only when the view is also turned by a whole quarter. The 90-degree steps are
 * defined from such a view; a free view (orbited by hand) has none, so the arrows are hidden there.
 */
export function standardViewOf(view: ViewState, toleranceRad = 1e-3): AxisKey | null {
  const key = alignedAxis(view, toleranceRad);
  if (key === null) return null;
  return Math.abs(view.azimuth - snapQuarter(view.azimuth)) <= toleranceRad ? key : null;
}

/**
 * A quarter turn about the vertical axis (Z). The camera is a turntable without a roll angle, so this is the one turn that needs
 * no new degree of freedom: in the top and bottom view it is a roll on the screen (the view stays "Top"), in a side view the
 * neighbouring side comes to the front. "left" turns the part counter-clockwise on the screen in the top view; seen from below
 * the sense flips so an arrow still shows the motion on the screen. Null when the view is not a standard view.
 */
export function viewAfterTurn(view: ViewState, direction: TurnDirection): ViewState | null {
  if (standardViewOf(view) === null) return null;
  const fromBelow = view.elevation < -0.1 ? -1 : 1;
  const step = (direction === "left" ? -1 : 1) * fromBelow * HALF_PI;
  return { ...view, azimuth: shortestAngle(0, view.azimuth + step) };
}

/**
 * Tips the view by 90 degrees to the neighbouring standard view in the screen direction of the arrow: the eye moves that way,
 * so its new direction is the screen direction itself. From the top view: down is Front, right is Right, up is Back, left is Left.
 * These are the same targets as a click on the axis end that lies in that direction. Null when the view is not a standard view.
 */
export function viewAfterTip(view: ViewState, direction: TipDirection): ViewState | null {
  if (standardViewOf(view) === null) return null;
  const basis = cameraBasis(view);
  const wanted: Vec3 = direction === "up" ? basis.up : direction === "down" ? scale(basis.up, -1) : direction === "right" ? basis.right : scale(basis.right, -1);
  let best: AxisKey = axisKeys[0]!;
  for (const key of axisKeys) if (dot(wanted, axisVector[key]) > dot(wanted, axisVector[best])) best = key;
  return viewFromAxis(view, best);
}

export function homeView(view: ViewState): ViewState {
  return { ...view, azimuth: HOME_AZIMUTH, elevation: HOME_ELEVATION };
}

// --- transitions ------------------------------------------------------------------------------------------------

export const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Angle difference b - a folded into (-pi, pi]: the short way round. */
export function shortestAngle(a: number, b: number): number {
  const twoPi = Math.PI * 2;
  let d = (b - a) % twoPi;
  if (d > Math.PI) d -= twoPi;
  if (d <= -Math.PI) d += twoPi;
  return d;
}

/** Between two views (t in 0..1). The azimuth takes the short way, the distance changes in a geometric way. */
export function interpolateView(a: ViewState, b: ViewState, t: number): ViewState {
  return {
    target: [a.target[0] + (b.target[0] - a.target[0]) * t, a.target[1] + (b.target[1] - a.target[1]) * t, a.target[2] + (b.target[2] - a.target[2]) * t],
    azimuth: a.azimuth + shortestAngle(a.azimuth, b.azimuth) * t,
    elevation: a.elevation + (b.elevation - a.elevation) * t,
    distance: a.distance * Math.pow(b.distance / a.distance, t),
  };
}

export function viewsAreEqual(a: ViewState, b: ViewState, eps = 1e-9): boolean {
  return (
    Math.abs(a.azimuth - b.azimuth) < eps &&
    Math.abs(a.elevation - b.elevation) < eps &&
    Math.abs(a.distance - b.distance) < eps * Math.max(1, a.distance) &&
    length(sub(a.target, b.target)) < eps * Math.max(1, a.distance)
  );
}
