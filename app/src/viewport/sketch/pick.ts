// Picking in the sketch: what is under a pixel, in the order points, dimensions, curves, regions, origin and axes. All tests
// run on the screen with pixel tolerances (never on a grid; nothing here snaps to anything). Pure functions on the sketch
// scene and a projector, tested in Node.
import type { SketchView } from "../../model/editors.ts";
import { pointSegmentDistance2D } from "../picking.ts";
import { insideLoops, loopArea } from "./band.ts";
import type { DimensionGraphic } from "./dimensions.ts";
import type { SketchProjector } from "./frame.ts";
import type { SketchScene, SceneCurve } from "./scene.ts";
import type { SketchHit } from "./types.ts";

export const DEFAULT_TOLERANCE_PX = 6;
/** Points are drawn 9 px across; a click a little beside them still takes them. */
const POINT_EXTRA_PX = 3;
/** The text box of a dimension (half width and half height), CSS pixels. */
export const LABEL_HALF_WIDTH_PX = 30;
export const LABEL_HALF_HEIGHT_PX = 12;
const ORIGIN_PX = 8;
const CIRCLE_STEPS = 64;

export interface PickContext {
  scene: SketchScene;
  dimensions: readonly DimensionGraphic[];
  profiles: SketchView["profiles"];
  projector: SketchProjector;
}

interface Nearest {
  distance: number;
  u: number;
  v: number;
}

function nearestOnLine(c: Extract<SceneCurve, { type: "line" }>, proj: SketchProjector, x: number, y: number): Nearest | null {
  const a = proj.toScreen(c.a[0], c.a[1]), b = proj.toScreen(c.b[0], c.b[1]);
  if (!a || !b) return null;
  const { distance, s } = pointSegmentDistance2D(x, y, a.x, a.y, b.x, b.y);
  return { distance, u: c.a[0] + (c.b[0] - c.a[0]) * s, v: c.a[1] + (c.b[1] - c.a[1]) * s };
}

function nearestOnCircle(c: Extract<SceneCurve, { type: "circle" }>, proj: SketchProjector, x: number, y: number, tolerance: number): Nearest | null {
  // The pointer in sketch coordinates gives a cheap rejection: a point further than the tolerance from the circle in the
  // plane (measured with the largest scale) cannot be within it on the screen.
  const at = proj.toSketch(x, y);
  if (at) {
    const gapMm = Math.abs(Math.hypot(at.u - c.c[0], at.v - c.c[1]) - c.r);
    if (gapMm * proj.pxPerMm > tolerance * 8 + 50) return null;
  }
  let best: Nearest | null = null;
  let prev = proj.toScreen(c.c[0] + c.r, c.c[1]);
  for (let i = 1; i <= CIRCLE_STEPS; i++) {
    const a = (i / CIRCLE_STEPS) * Math.PI * 2;
    const cu = c.c[0] + c.r * Math.cos(a), cv = c.c[1] + c.r * Math.sin(a);
    const cur = proj.toScreen(cu, cv);
    if (prev && cur) {
      const { distance, s } = pointSegmentDistance2D(x, y, prev.x, prev.y, cur.x, cur.y);
      if (!best || distance < best.distance) {
        const a0 = ((i - 1) / CIRCLE_STEPS) * Math.PI * 2;
        const am = a0 + (a - a0) * s;
        best = { distance, u: c.c[0] + c.r * Math.cos(am), v: c.c[1] + c.r * Math.sin(am) };
      }
    }
    prev = cur;
  }
  return best;
}

/** Distance in pixels from a pixel to the infinite line through two sketch points, or null when they cannot be projected. */
function distanceToAxis(proj: SketchProjector, x: number, y: number, axis: "u" | "v"): number | null {
  const reach = 200 / proj.pxPerMm;
  const a = proj.toScreen(0, 0), b = proj.toScreen(axis === "u" ? reach : 0, axis === "v" ? reach : 0);
  if (!a || !b) return null;
  const dx = b.x - a.x, dy = b.y - a.y;
  const l = Math.hypot(dx, dy);
  if (l < 1e-6) return null;
  return Math.abs((x - a.x) * dy - (y - a.y) * dx) / l;
}

function hitDimension(d: DimensionGraphic, proj: SketchProjector, x: number, y: number, tolerance: number): boolean {
  const label = proj.toScreen(d.label[0], d.label[1]);
  if (label && Math.abs(x - label.x) <= LABEL_HALF_WIDTH_PX && Math.abs(y - label.y) <= LABEL_HALF_HEIGHT_PX) return true;
  for (const [p, q] of d.segments) {
    const a = proj.toScreen(p[0], p[1]), b = proj.toScreen(q[0], q[1]);
    if (!a || !b) continue;
    if (pointSegmentDistance2D(x, y, a.x, a.y, b.x, b.y).distance <= tolerance) return true;
  }
  return false;
}

/** What is under the pixel (x, y), CSS pixels inside the view. Priority: point, dimension, line or circle, region, origin, axis. */
export function pickSketch(ctx: PickContext, x: number, y: number, tolerance = DEFAULT_TOLERANCE_PX): SketchHit | null {
  const { scene, projector: proj } = ctx;

  let bestPoint: { id: string; distance: number } | null = null;
  for (const p of scene.points) {
    const s = proj.toScreen(p.u, p.v);
    if (!s) continue;
    const distance = Math.hypot(s.x - x, s.y - y);
    if (distance <= tolerance + POINT_EXTRA_PX && (!bestPoint || distance < bestPoint.distance)) bestPoint = { id: p.id, distance };
  }
  if (bestPoint) return { kind: "point", id: bestPoint.id };

  for (const d of ctx.dimensions) if (hitDimension(d, proj, x, y, tolerance)) return { kind: "dimension", id: d.id };

  let bestCurve: { curve: SceneCurve; near: Nearest } | null = null;
  for (const c of scene.curves) {
    const near = c.type === "line" ? nearestOnLine(c, proj, x, y) : nearestOnCircle(c, proj, x, y, tolerance);
    if (near && near.distance <= tolerance && (!bestCurve || near.distance < bestCurve.near.distance)) bestCurve = { curve: c, near };
  }
  if (bestCurve) return { kind: bestCurve.curve.type, id: bestCurve.curve.id, u: bestCurve.near.u, v: bestCurve.near.v };

  const at = proj.toSketch(x, y);
  if (at) {
    // The smallest region that contains the point (a region inside a hole of another one wins over it).
    let best: { key: string; area: number } | null = null;
    for (const p of ctx.profiles) {
      if (!insideLoops(p.loops, at.u, at.v)) continue;
      const area = Math.abs(p.loops[0] ? loopArea(p.loops[0]) : p.area);
      if (!best || area < best.area) best = { key: p.key, area };
    }
    if (best) return { kind: "region", key: best.key };
  }

  const o = proj.toScreen(0, 0);
  if (o && Math.hypot(o.x - x, o.y - y) <= ORIGIN_PX) return { kind: "origin" };
  const du = distanceToAxis(proj, x, y, "u"), dv = distanceToAxis(proj, x, y, "v");
  if (du !== null && du <= tolerance && (dv === null || du <= dv)) return { kind: "axis", axis: "u" };
  if (dv !== null && dv <= tolerance) return { kind: "axis", axis: "v" };
  return null;
}
