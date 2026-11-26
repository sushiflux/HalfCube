// Picking math: rays against planes and triangle meshes, closeness of lines on the screen, and the rule that chooses one
// thing out of everything under the pointer. Pure functions (no three.js, no DOM), tested in Node.
//
// Picking uses pixel tolerances for lines, which is fine; it never aligns a point to the grid.
import { cameraBasis, worldToScreen, type CameraBasis, type Lens, type Ray, type ViewState } from "./camera.ts";
import type { SegmentBuffers } from "./geometry.ts";
import { add, dot, scale, sub, type Bounds, type Vec3 } from "./math.ts";
import type { EntityRef } from "./types.ts";

// --- rays -------------------------------------------------------------------------------------------------------

export interface RayHit {
  /** Distance along the ray (the ray direction has unit length). */
  t: number;
  point: Vec3;
}

export function rayPlane(ray: Ray, planeOrigin: Vec3, planeNormal: Vec3): RayHit | null {
  const denom = dot(ray.dir, planeNormal);
  if (Math.abs(denom) < 1e-12) return null;
  const t = dot(sub(planeOrigin, ray.origin), planeNormal) / denom;
  if (t <= 0) return null;
  return { t, point: add(ray.origin, scale(ray.dir, t)) };
}

/** Slab test of a ray against a box (also true when the ray starts inside). */
export function rayHitsBounds(ray: Ray, b: Bounds): boolean {
  let tMin = 0;
  let tMax = Infinity;
  for (let k = 0; k < 3; k++) {
    const o = ray.origin[k]!, d = ray.dir[k]!;
    if (Math.abs(d) < 1e-15) {
      if (o < b.min[k]! || o > b.max[k]!) return false;
      continue;
    }
    let t0 = (b.min[k]! - o) / d;
    let t1 = (b.max[k]! - o) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tMin = Math.max(tMin, t0);
    tMax = Math.min(tMax, t1);
    if (tMin > tMax) return false;
  }
  return true;
}

/** Moeller-Trumbore, two-sided. Returns the distance along the ray or null. */
export function rayTriangle(ray: Ray, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number | null {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const [dx, dy, dz] = ray.dir;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return null;
  const inv = 1 / det;
  const tx = ray.origin[0] - ax, ty = ray.origin[1] - ay, tz = ray.origin[2] - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 0 ? t : null;
}

export interface MeshHit {
  triangle: number;
  t: number;
}

/** The nearest triangle of an indexed mesh the ray meets. Linear in the triangle count; callers test the box first. */
export function rayMesh(ray: Ray, positions: Float32Array, indices: Uint32Array): MeshHit | null {
  let best: MeshHit | null = null;
  const triangles = indices.length / 3;
  for (let t = 0; t < triangles; t++) {
    const i0 = indices[t * 3]! * 3, i1 = indices[t * 3 + 1]! * 3, i2 = indices[t * 3 + 2]! * 3;
    const hit = rayTriangle(ray, positions[i0]!, positions[i0 + 1]!, positions[i0 + 2]!, positions[i1]!, positions[i1 + 1]!, positions[i1 + 2]!, positions[i2]!, positions[i2 + 1]!, positions[i2 + 2]!);
    if (hit !== null && (best === null || hit < best.t)) best = { triangle: t, t: hit };
  }
  return best;
}

// --- lines on the screen ----------------------------------------------------------------------------------------

export interface SegmentHit {
  segment: number;
  owner: number;
  /** Pixels between the pointer and the line. */
  distancePx: number;
  /** The nearest point of the line to the pointer, in the world. */
  point: Vec3;
  /** Depth of that point in front of the camera, mm. */
  depth: number;
}

/** Distance from point (px, py) to the segment (x0, y0)-(x1, y1) and the position s (0..1) of the nearest point on it. */
export function pointSegmentDistance2D(px: number, py: number, x0: number, y0: number, x1: number, y1: number): { distance: number; s: number } {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const s = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - x0) * dx + (py - y0) * dy) / len2));
  return { distance: Math.hypot(px - (x0 + dx * s), py - (y0 + dy * s)), s };
}

const NEAR_DEPTH = 1e-3;

/** The segment of a buffer closest to the pointer, if one is within `tolerancePx`. Segments behind the camera are cut at its plane. */
export function nearestSegment(view: ViewState, lens: Lens, buffers: SegmentBuffers, px: number, py: number, tolerancePx: number, basis: CameraBasis = cameraBasis(view)): SegmentHit | null {
  let best: SegmentHit | null = null;
  const p = buffers.positions;
  for (let s = 0; s < buffers.segmentCount; s++) {
    let a: Vec3 = [p[s * 6]!, p[s * 6 + 1]!, p[s * 6 + 2]!];
    let b: Vec3 = [p[s * 6 + 3]!, p[s * 6 + 4]!, p[s * 6 + 5]!];
    const za = dot(sub(a, basis.eye), basis.forward), zb = dot(sub(b, basis.eye), basis.forward);
    if (za < NEAR_DEPTH && zb < NEAR_DEPTH) continue;
    // Cut the part behind the camera away.
    if (za < NEAR_DEPTH) a = add(a, scale(sub(b, a), (NEAR_DEPTH - za) / (zb - za)));
    else if (zb < NEAR_DEPTH) b = add(b, scale(sub(a, b), (NEAR_DEPTH - zb) / (za - zb)));
    const sa = worldToScreen(view, lens, a, basis), sb = worldToScreen(view, lens, b, basis);
    if (!sa || !sb) continue;
    const { distance, s: along } = pointSegmentDistance2D(px, py, sa.x, sa.y, sb.x, sb.y);
    if (distance > tolerancePx) continue;
    if (best !== null && distance >= best.distancePx - 1e-9) continue;
    // Position on the screen segment -> position on the 3D segment (perspective-correct).
    const t = along * sa.depth / (sb.depth * (1 - along) + along * sa.depth);
    const point = add(a, scale(sub(b, a), t));
    best = { segment: s, owner: buffers.owners[s]!, distancePx: distance, point, depth: sa.depth + (sb.depth - sa.depth) * t };
  }
  return best;
}

// --- choosing one thing -----------------------------------------------------------------------------------------

export interface PickCandidate {
  ref: EntityRef;
  point: Vec3;
  depth: number;
  distancePx: number;
}

export interface PickCandidates {
  sketch: PickCandidate | null;
  edge: PickCandidate | null;
  /** A pickable profile (a flat fill of the extrude command), if any is under the pointer. */
  profile?: PickCandidate | null;
  face: PickCandidate | null;
  plane: PickCandidate | null;
}

/**
 * Which one of everything under the pointer is picked. Lines (sketch entities first, then body edges) win over surfaces,
 * as long as nothing solid is in front of them; then a profile (a flat fill: it wins over the face it may lie on and over the
 * origin planes, but not over a solid in front of it); then a face, then the plane (a plane is picked only where nothing else is under the pointer).
 * `epsilon` is the depth tolerance in mm: an edge lies on its face and must not count as hidden by it. `solidDepth` is the
 * depth of the nearest solid under the pointer (also when faces themselves may not be picked, they still hide lines).
 */
export function choosePick(c: PickCandidates, epsilon: number, solidDepth: number = c.face ? c.face.depth : Infinity): PickCandidate | null {
  const visible = (x: PickCandidate | null): x is PickCandidate => x !== null && x.depth <= solidDepth + epsilon;
  if (visible(c.sketch)) return c.sketch;
  if (visible(c.edge)) return c.edge;
  if (visible(c.profile ?? null)) return c.profile!;
  // An origin plane is a small marker: a face under the pointer wins even where the plane lies in front of it.
  return c.face ?? c.plane;
}
