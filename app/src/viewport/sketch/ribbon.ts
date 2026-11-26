// A ribbon of constant width along a polyline, as triangles in sketch coordinates: the translucent halo of a hovered or
// selected curve or dimension line. Consecutive pieces share their corner vertices (miter joins), so a translucent ribbon
// is never blended twice at a joint. Pure functions, tested in Node.
import type { UV } from "./scene.ts";

export interface RibbonMesh {
  /** u v per vertex. */
  positions: Float32Array;
  indices: Uint32Array;
}

const MITER_LIMIT = 2.5;

/** The ribbon along a polyline. Open ends are extended by half the width; `closed` joins the last point to the first. */
export function ribbonOfPolyline(points: readonly UV[], closed: boolean, halfWidth: number): RibbonMesh | null {
  const pts: UV[] = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) pts.push(p);
  }
  if (closed && pts.length > 1) {
    const f = pts[0]!, l = pts[pts.length - 1]!;
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) <= 1e-9) pts.pop();
  }
  const n = pts.length;
  if (n < 2) return null;
  if (closed && n < 3) return null;

  // Direction of every edge; open polylines get their end points pushed out by the cap.
  const edges = closed ? n : n - 1;
  const dirs: UV[] = [];
  for (let i = 0; i < edges; i++) {
    const a = pts[i]!, b = pts[(i + 1) % n]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    dirs.push([(b[0] - a[0]) / l, (b[1] - a[1]) / l]);
  }
  const verts: UV[] = pts.map((p) => p);
  if (!closed) {
    verts[0] = [pts[0]![0] - dirs[0]![0] * halfWidth, pts[0]![1] - dirs[0]![1] * halfWidth];
    verts[n - 1] = [pts[n - 1]![0] + dirs[edges - 1]![0] * halfWidth, pts[n - 1]![1] + dirs[edges - 1]![1] * halfWidth];
  }
  const positions = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const dPrev = closed ? dirs[(i + n - 1) % n]! : dirs[Math.max(0, i - 1)]!;
    const dNext = closed ? dirs[i]! : dirs[Math.min(edges - 1, i)]!;
    const n0: UV = [-dPrev[1], dPrev[0]], n1: UV = [-dNext[1], dNext[0]];
    let mx = n0[0] + n1[0], my = n0[1] + n1[1];
    const ml = Math.hypot(mx, my);
    let scale = halfWidth;
    if (ml < 1e-9) {
      mx = n1[0]; my = n1[1];
    } else {
      mx /= ml; my /= ml;
      scale = Math.min(halfWidth / Math.max(mx * n1[0] + my * n1[1], 1e-6), halfWidth * MITER_LIMIT);
    }
    const p = verts[i]!;
    positions[i * 4] = p[0] + mx * scale;
    positions[i * 4 + 1] = p[1] + my * scale;
    positions[i * 4 + 2] = p[0] - mx * scale;
    positions[i * 4 + 3] = p[1] - my * scale;
  }
  const indices = new Uint32Array(edges * 6);
  for (let i = 0; i < edges; i++) {
    const j = (i + 1) % n;
    const o = i * 2, no = j * 2;
    indices.set([o, no, o + 1, no, no + 1, o + 1], i * 6);
  }
  return { positions, indices };
}

/** Several ribbons as one mesh. */
export function mergeMeshes(parts: readonly RibbonMesh[]): RibbonMesh {
  let vertices = 0, count = 0;
  for (const p of parts) { vertices += p.positions.length / 2; count += p.indices.length; }
  const positions = new Float32Array(vertices * 2);
  const indices = new Uint32Array(count);
  let vo = 0, io = 0;
  for (const p of parts) {
    positions.set(p.positions, vo * 2);
    for (let i = 0; i < p.indices.length; i++) indices[io + i] = p.indices[i]! + vo;
    vo += p.positions.length / 2;
    io += p.indices.length;
  }
  return { positions, indices };
}
