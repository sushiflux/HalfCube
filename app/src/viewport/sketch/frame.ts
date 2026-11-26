// The sketch plane as the viewport sees it: a frame with origin, two axes and the normal (the side the eye looks from),
// the projection between screen pixels and sketch coordinates, and the camera view that looks straight onto it.
// Pure functions (no three.js, no DOM), tested in Node.
import type { SketchView } from "../../model/editors.ts";
import { cameraBasis, DEFAULT_FOV_Y, fitBounds, HALF_PI, pixelsPerWorld, screenRay, worldToScreen, type Lens, type ViewState } from "../camera.ts";
import { add, clamp, dot, normalize, scale, sub, type Bounds, type Vec3 } from "../math.ts";
import { rayPlane } from "../picking.ts";

/** A plane in 3D with its two unit axes and the unit normal (u x v), as plain triples. */
export interface Frame3 {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  normal: Vec3;
}

const vec3 = (p: { x: number; y: number; z: number }): Vec3 => [p.x, p.y, p.z];

/** The frame of a solved sketch (the engine sends vectors as {x, y, z}). */
export function frameOfView(view: Pick<SketchView, "frame">): Frame3 {
  const f = view.frame;
  return { origin: vec3(f.origin), u: vec3(f.u), v: vec3(f.v), normal: vec3(f.normal) };
}

export function framesEqual(a: Frame3 | null, b: Frame3 | null): boolean {
  if (a === null || b === null) return a === b;
  for (const k of ["origin", "u", "v", "normal"] as const) for (let i = 0; i < 3; i++) if (a[k][i] !== b[k][i]) return false;
  return true;
}

/** The point (u, v) of the sketch in the world. */
export function sketchToWorld(frame: Frame3, u: number, v: number): Vec3 {
  return [
    frame.origin[0] + frame.u[0] * u + frame.v[0] * v,
    frame.origin[1] + frame.u[1] * u + frame.v[1] * v,
    frame.origin[2] + frame.u[2] * u + frame.v[2] * v,
  ];
}

/** Sketch coordinates of a world point (its distance from the plane is ignored). */
export function worldToSketch(frame: Frame3, p: Vec3): [number, number] {
  const rel = sub(p, frame.origin);
  return [dot(rel, frame.u), dot(rel, frame.v)];
}

// --- looking onto the plane -------------------------------------------------------------------------------------------

/**
 * The turntable view whose eye sits on the plane's normal, with the sketch's u axis to the right and v up on the screen.
 * The turntable camera cannot roll, so a plane whose u axis is not horizontal (a tilted face) gets the nearest view: eye on
 * the normal, u as close to the right as the camera allows. Target and distance are kept unless given.
 */
export function viewLookingOnto(frame: Frame3, base: ViewState, target?: Vec3, distance?: number): ViewState {
  const n = normalize(frame.normal);
  const elevation = Math.asin(clamp(n[2], -1, 1));
  let azimuth: number;
  if (Math.abs(n[2]) > 1 - 1e-9) {
    // Looking straight down or up: the azimuth only says which way "up" points on the screen. The camera's right is
    // (cos az, sin az, 0), so it must be u itself; up then is v for both poles (see the conventions in camera.ts).
    azimuth = Math.atan2(frame.u[1], frame.u[0]);
  } else {
    azimuth = Math.atan2(n[0], -n[1]);
  }
  return { target: target ?? base.target, azimuth, elevation: clamp(elevation, -HALF_PI, HALF_PI), distance: distance ?? base.distance };
}

/** How far the screen's right and up directions are from the sketch's u and v for a view: both 1 when they agree. */
export function viewAgreement(frame: Frame3, view: ViewState): { u: number; v: number } {
  const b = cameraBasis(view);
  return { u: dot(b.right, frame.u), v: dot(b.up, frame.v) };
}

/** Where the eye goes for the plane's bounds: the view that looks onto the plane and fits the given world bounds. */
export function fittedViewOnto(frame: Frame3, base: ViewState, lens: Lens, bounds: Bounds | null, minDistance = 40): ViewState {
  const looking = viewLookingOnto(frame, base, bounds ? undefined : frame.origin);
  if (!bounds) return looking;
  const fitted = fitBounds(looking, lens, bounds, 1.6);
  return { ...fitted, distance: Math.max(fitted.distance, minDistance) };
}

/**
 * The view that brings the elements into sight without turning the sketch: the target moves to the middle of their box (a pan), the
 * distance changes only when it must - zoomed out when they would not fit (more than 85 % of the view), zoomed in when they would be
 * tiny (under 5 % of the view, so they come to about a third of it) - and the orientation stays as it is.
 */
export function focusedView(view: ViewState, lens: Lens, bounds: Bounds): ViewState {
  const exact = fitBounds(view, lens, bounds, 1);
  const share = exact.distance / Math.max(view.distance, 1e-9);
  const distance = share > 0.85 ? fitBounds(view, lens, bounds, 1.25).distance : share < 0.05 ? fitBounds(view, lens, bounds, 3).distance : view.distance;
  return { ...view, target: exact.target, distance };
}

// --- projection -------------------------------------------------------------------------------------------------------

export interface ScreenPoint2 {
  x: number;
  y: number;
}

/** Everything that maps between CSS pixels of the view and the sketch plane for one camera. */
export interface SketchProjector {
  frame: Frame3;
  /** Pixel of the sketch point; null when it is behind the camera. */
  toScreen(u: number, v: number): ScreenPoint2 | null;
  /** The sketch point under a pixel; null when the ray misses the plane (looking along it, or away from it). */
  toSketch(x: number, y: number): { u: number; v: number } | null;
  /** Pixels per mm of the plane near the middle of the view (the larger of the two axis scales). */
  pxPerMm: number;
  /** Mm of the sketch per pixel at the middle of the view. */
  mmPerPx: number;
}

export function makeProjector(view: ViewState, lens: Lens, frame: Frame3): SketchProjector {
  const basis = cameraBasis(view);
  const toScreen = (u: number, v: number): ScreenPoint2 | null => {
    const s = worldToScreen(view, lens, sketchToWorld(frame, u, v), basis);
    return s ? { x: s.x, y: s.y } : null;
  };
  const toSketch = (x: number, y: number): { u: number; v: number } | null => {
    const ray = screenRay(view, lens, x, y, basis);
    const hit = rayPlane(ray, frame.origin, frame.normal);
    if (!hit) return null;
    const [u, v] = worldToSketch(frame, hit.point);
    return { u, v };
  };
  // The scale at the middle of the view, from a one-millimetre step along each axis.
  const mid = toSketch(lens.width / 2, lens.height / 2) ?? { u: 0, v: 0 };
  const a = toScreen(mid.u, mid.v), bu = toScreen(mid.u + 1, mid.v), bv = toScreen(mid.u, mid.v + 1);
  let pxPerMm = 0;
  if (a && bu && bv) pxPerMm = Math.max(Math.hypot(bu.x - a.x, bu.y - a.y), Math.hypot(bv.x - a.x, bv.y - a.y));
  // The plane is edge-on or behind the camera: fall back to the scale at the view target's distance.
  if (!(pxPerMm > 1e-9)) pxPerMm = pixelsPerWorld(lens, Math.max(view.distance, 1e-6));
  return { frame, toScreen, toSketch, pxPerMm, mmPerPx: 1 / pxPerMm };
}

export const defaultLens = (width: number, height: number): Lens => ({ fovY: DEFAULT_FOV_Y, width, height });

/** World point at a depth of the sketch plane's middle, used for the size of pixel-sized markers: mm per pixel at a point. */
export function mmPerPixelAt(view: ViewState, lens: Lens, p: Vec3, basis = cameraBasis(view)): number {
  const depth = Math.max(1e-6, dot(sub(p, basis.eye), basis.forward));
  return 1 / pixelsPerWorld(lens, depth);
}

export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => add(a, scale(b, s));
