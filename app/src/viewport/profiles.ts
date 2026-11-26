// Profiles in the 3D view (extrude command): the closed regions of finished sketches as flat triangle fills on their planes.
// Pure functions (no three.js, no DOM), tested in Node: the world positions of the fill, the outline that hover and selection
// draw, and the pick of the region under a ray. The region data comes from the engine as it is; nothing here finds or changes
// regions (no topology work), a profile is only drawn and hit-tested.
import type { Ray } from "./camera.ts";
import { boundsOfPositions, dot, sub, type Bounds, type Vec3 } from "./math.ts";
import { planeNormal, planeToWorld } from "./geometry.ts";
import { rayPlane } from "./picking.ts";
import type { PlaneFrame, ProfileData, Vec2 } from "./types.ts";

/** Checks the sizes of a profile; returns a message for the first problem or null. */
export function validateProfile(p: ProfileData): string | null {
  const where = `Profile ${p.sketchId}/${p.regionId}`;
  if (p.triangles.length % 6 !== 0) return `${where}: triangles has ${p.triangles.length} values, not a multiple of 6 (u v for three vertices).`;
  for (let i = 0; i < p.triangles.length; i++) if (!Number.isFinite(p.triangles[i]!)) return `${where}: triangles[${i}] is not a finite number.`;
  return null;
}

/** The fill triangles in the world: xyz for every vertex, three vertices per triangle. */
export function profileWorldPositions(plane: PlaneFrame, triangles: Float32Array): Float32Array {
  const n = triangles.length / 2;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = planeToWorld(plane, [triangles[i * 2]!, triangles[i * 2 + 1]!]);
    out[i * 3] = p[0];
    out[i * 3 + 1] = p[1];
    out[i * 3 + 2] = p[2];
  }
  return out;
}

/** The world bounds of a profile. */
export function profileBounds(plane: PlaneFrame, triangles: Float32Array): Bounds {
  return boundsOfPositions(profileWorldPositions(plane, triangles));
}

/** Area of the fill in mm2 (the sum of the triangles): used to prefer the smaller of two overlapping profiles. */
export function profileArea(triangles: Float32Array): number {
  let area = 0;
  for (let t = 0; t + 5 < triangles.length; t += 6) {
    area += Math.abs((triangles[t + 2]! - triangles[t]!) * (triangles[t + 5]! - triangles[t + 1]!) - (triangles[t + 4]! - triangles[t]!) * (triangles[t + 3]! - triangles[t + 1]!)) / 2;
  }
  return area;
}

/**
 * The triangles of an indexed mesh (u v per vertex, three indices per triangle) as the non-indexed list a ProfileData carries.
 * The engine delivers regions indexed; the view takes them flat.
 */
export function flattenTriangles(uv: ArrayLike<number>, indices: ArrayLike<number>): Float32Array {
  const out = new Float32Array(indices.length * 2);
  for (let i = 0; i < indices.length; i++) {
    out[i * 2] = uv[indices[i]! * 2]!;
    out[i * 2 + 1] = uv[indices[i]! * 2 + 1]!;
  }
  return out;
}

const quantise = (v: number): number => Math.round(v * 1e4);

/**
 * The boundary of a triangle fill as segments (xyz xyz per segment): the edges that belong to exactly one triangle, so the hole
 * edges are in and the inner diagonals are out. Vertices are matched on a 0.1 micrometre grid. With `outline` loops given they
 * are used as they are (each loop is closed).
 */
export function outlineSegments(plane: PlaneFrame, triangles: Float32Array, outline?: readonly Vec2[][]): Float32Array {
  const flat: number[] = [];
  const push = (a: Vec2, b: Vec2) => {
    const p = planeToWorld(plane, a), q = planeToWorld(plane, b);
    flat.push(p[0], p[1], p[2], q[0], q[1], q[2]);
  };
  if (outline && outline.length > 0) {
    for (const loop of outline) for (let i = 0; i < loop.length; i++) push(loop[i]!, loop[(i + 1) % loop.length]!);
    return Float32Array.from(flat);
  }
  const edges = new Map<string, { a: Vec2; b: Vec2; count: number }>();
  const vertex = (t: number, k: number): Vec2 => [triangles[t * 6 + k * 2]!, triangles[t * 6 + k * 2 + 1]!];
  for (let t = 0; t < triangles.length / 6; t++) {
    for (let k = 0; k < 3; k++) {
      const a = vertex(t, k), b = vertex(t, (k + 1) % 3);
      const ka = `${quantise(a[0])},${quantise(a[1])}`, kb = `${quantise(b[0])},${quantise(b[1])}`;
      if (ka === kb) continue;
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const found = edges.get(key);
      if (found) found.count++;
      else edges.set(key, { a, b, count: 1 });
    }
  }
  for (const e of edges.values()) if (e.count === 1) push(e.a, e.b);
  return Float32Array.from(flat);
}

export interface ProfileHit {
  /** Distance along the ray (the ray direction has unit length). */
  t: number;
  point: Vec3;
}

/** Whether the point (u, v) lies in a triangle of the fill (edges count as inside, with a tolerance of `eps` mm). */
export function pointInTriangles(triangles: Float32Array, u: number, v: number, eps = 1e-6): boolean {
  for (let t = 0; t + 5 < triangles.length; t += 6) {
    const ax = triangles[t]!, ay = triangles[t + 1]!, bx = triangles[t + 2]!, by = triangles[t + 3]!, cx = triangles[t + 4]!, cy = triangles[t + 5]!;
    // A triangle without area (sliver from the mesher) has no inside: without this check every point would count as inside.
    if (Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) < 1e-12) continue;
    const d1 = (u - bx) * (ay - by) - (ax - bx) * (v - by);
    const d2 = (u - cx) * (by - cy) - (bx - cx) * (v - cy);
    const d3 = (u - ax) * (cy - ay) - (cx - ax) * (v - ay);
    // The tolerance is in units of cross product (mm2): eps mm times the longest edge is a fair bound for it.
    const e = eps * Math.max(Math.hypot(bx - ax, by - ay), Math.hypot(cx - bx, cy - by), Math.hypot(ax - cx, ay - cy));
    const hasNeg = d1 < -e || d2 < -e || d3 < -e;
    const hasPos = d1 > e || d2 > e || d3 > e;
    if (!(hasNeg && hasPos)) return true;
  }
  return false;
}

/** The profile's UV bounds, for a cheap test before the triangles. */
export function uvBounds(triangles: Float32Array): { minU: number; maxU: number; minV: number; maxV: number } {
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i + 1 < triangles.length; i += 2) {
    const u = triangles[i]!, v = triangles[i + 1]!;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  return { minU, maxU, minV, maxV };
}

/** Where a ray meets the fill of a profile (from either side), or null. */
export function rayProfile(ray: Ray, plane: PlaneFrame, triangles: Float32Array, bounds = uvBounds(triangles)): ProfileHit | null {
  const hit = rayPlane(ray, plane.origin, planeNormal(plane));
  if (!hit) return null;
  const rel = sub(hit.point, plane.origin);
  const u = dot(rel, plane.xAxis), v = dot(rel, plane.yAxis);
  if (u < bounds.minU - 1e-6 || u > bounds.maxU + 1e-6 || v < bounds.minV - 1e-6 || v > bounds.maxV + 1e-6) return null;
  return pointInTriangles(triangles, u, v) ? { t: hit.t, point: hit.point } : null;
}
