// Small vector and bounds helpers for the viewport. Plain tuples, no dependency on three.js, so every camera and picking
// calculation can be tested in Node. Right-handed coordinate system, Z up, millimetres.

export type Vec3 = readonly [number, number, number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l === 0 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
}

/** Axis-aligned bounding box. An empty box has min > max. */
export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export const emptyBounds = (): Bounds => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
export const isEmptyBounds = (b: Bounds): boolean => b.min[0] > b.max[0] || b.min[1] > b.max[1] || b.min[2] > b.max[2];

export function expandBounds(b: Bounds, p: Vec3): Bounds {
  return {
    min: [Math.min(b.min[0], p[0]), Math.min(b.min[1], p[1]), Math.min(b.min[2], p[2])],
    max: [Math.max(b.max[0], p[0]), Math.max(b.max[1], p[1]), Math.max(b.max[2], p[2])],
  };
}

export function unionBounds(a: Bounds, b: Bounds): Bounds {
  if (isEmptyBounds(a)) return b;
  if (isEmptyBounds(b)) return a;
  return expandBounds(expandBounds(a, b.min), b.max);
}

/** Bounds of a flat xyz array (positions of a mesh or a polyline). */
export function boundsOfPositions(positions: ArrayLike<number>, from = 0, to = positions.length): Bounds {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = from; i + 2 < to; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

export const boundsCenter = (b: Bounds): Vec3 => scale(add(b.min, b.max), 0.5);
export const boundsSize = (b: Bounds): Vec3 => sub(b.max, b.min);
/** Radius of the sphere around the box centre that contains the box. */
export const boundsRadius = (b: Bounds): number => (isEmptyBounds(b) ? 0 : length(boundsSize(b)) / 2);

export function boundsCorners(b: Bounds): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
