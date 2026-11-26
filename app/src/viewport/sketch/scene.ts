// The sketch as plain 2D data for drawing and picking: points, curves with their solver state, and the line kind each is
// drawn with. Pure functions on the model's SketchView (no three.js, no DOM).
import type { EntityState, SketchView } from "../../model/editors.ts";
import { tessellateArc, buildSegments, type Polyline, type SegmentBuffers } from "../geometry.ts";
import type { LineKind } from "../style.ts";
import { sketchToWorld, type Frame3 } from "./frame.ts";
import type { SketchFullColour } from "./types.ts";

export type UV = readonly [number, number];

export interface ScenePoint {
  id: string;
  u: number;
  v: number;
  state: EntityState;
}

export type SceneCurve =
  | { id: string; type: "line"; construction: boolean; state: EntityState; a: UV; b: UV }
  | { id: string; type: "circle"; construction: boolean; state: EntityState; c: UV; r: number };

export interface SketchScene {
  points: ScenePoint[];
  pointById: Map<string, ScenePoint>;
  curves: SceneCurve[];
  curveById: Map<string, SceneCurve>;
}

export function emptyScene(): SketchScene {
  return { points: [], pointById: new Map(), curves: [], curveById: new Map() };
}

export function buildScene(view: SketchView): SketchScene {
  const points: ScenePoint[] = view.points.map((p) => ({ id: p.id, u: p.x, v: p.y, state: p.state }));
  const pointById = new Map(points.map((p) => [p.id, p]));
  const curves: SceneCurve[] = [];
  for (const l of view.lines) {
    const a = pointById.get(l.p1), b = pointById.get(l.p2);
    if (a && b) curves.push({ id: l.id, type: "line", construction: l.construction, state: l.state, a: [a.u, a.v], b: [b.u, b.v] });
  }
  for (const c of view.circles) {
    const m = pointById.get(c.center);
    if (m) curves.push({ id: c.id, type: "circle", construction: c.construction, state: c.state, c: [m.u, m.v], r: c.radius });
  }
  return { points, pointById, curves, curveById: new Map(curves.map((c) => [c.id, c])) };
}

/** The line kind a curve is drawn with: construction geometry has its own kind, everything else follows the solver state. */
export function curveLineKind(construction: boolean, state: EntityState): LineKind {
  if (construction) return "construction";
  return state === "full" ? "sketchFull" : state === "over" ? "sketchOver" : "sketchUnder";
}

/** The curve kinds that get a layer of their own, in drawing order. */
export const curveKinds: readonly LineKind[] = ["construction", "sketchUnder", "sketchFull", "sketchOver"];

/** Points of a curve as a polyline in the sketch (a circle repeats its first point). */
export function curvePolyline(c: SceneCurve): UV[] {
  return c.type === "line" ? [c.a, c.b] : tessellateArc(c.c, c.r, 0, Math.PI * 2);
}

/** The world polyline of a curve, owned by `owner`. */
export function curveWorldPolyline(frame: Frame3, c: SceneCurve, owner: number): Polyline {
  return { owner, points: curvePolyline(c).map((p) => sketchToWorld(frame, p[0], p[1])) };
}

export interface CurveSegments {
  kind: LineKind;
  buffers: SegmentBuffers;
  /** Index into SketchScene.curves of the owner of each segment (buffers.owners). */
  curveIndexes: number[];
}

/** The segments of all curves, one buffer per line kind. The owner of a segment is the curve's index in scene.curves. */
export function curveSegments(frame: Frame3, scene: SketchScene): CurveSegments[] {
  const byKind = new Map<LineKind, { polylines: Polyline[]; indexes: number[] }>();
  scene.curves.forEach((c, i) => {
    const kind = curveLineKind(c.construction, c.state);
    const entry = byKind.get(kind) ?? { polylines: [], indexes: [] };
    entry.polylines.push(curveWorldPolyline(frame, c, i));
    entry.indexes.push(i);
    byKind.set(kind, entry);
  });
  const out: CurveSegments[] = [];
  for (const kind of curveKinds) {
    const entry = byKind.get(kind);
    if (entry) out.push({ kind, buffers: buildSegments(entry.polylines), curveIndexes: entry.indexes });
  }
  return out;
}

/** Positions of the segments of one curve in a buffer (for its highlight). */
export function segmentsOfCurve(buffers: SegmentBuffers, curveIndex: number): Float32Array {
  const picked: number[] = [];
  for (let s = 0; s < buffers.segmentCount; s++) {
    if (buffers.owners[s] !== curveIndex) continue;
    for (let k = 0; k < 6; k++) picked.push(buffers.positions[s * 6 + k]!);
  }
  return Float32Array.from(picked);
}

/** Bounds of the sketch's own content (points and circles) in sketch coordinates; null for an empty sketch. */
export function sketchExtent(scene: SketchScene): { min: UV; max: UV } | null {
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  for (const p of scene.points) {
    minU = Math.min(minU, p.u); maxU = Math.max(maxU, p.u);
    minV = Math.min(minV, p.v); maxV = Math.max(maxV, p.v);
  }
  for (const c of scene.curves) {
    if (c.type !== "circle") continue;
    minU = Math.min(minU, c.c[0] - c.r); maxU = Math.max(maxU, c.c[0] + c.r);
    minV = Math.min(minV, c.c[1] - c.r); maxV = Math.max(maxV, c.c[1] + c.r);
  }
  return minU > maxU ? null : { min: [minU, minV], max: [maxU, maxV] };
}

// --- colours -----------------------------------------------------------------------------------------------------------

/** The colour of a fully constrained line, band or fill: the token sketchFull (green) or its blue alternative. */
export function fullColour(lineColour: string, blue: string, choice: SketchFullColour): string {
  return choice === "blue" ? blue : lineColour;
}
