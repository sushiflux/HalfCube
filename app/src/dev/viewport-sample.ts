// Sample scene of the viewport demo (?demo=viewport) and of its tests: a box and a cylinder with face and edge ids,
// a sketch with one line of every line kind, a sketch with a circle, an arc and a closed profile, and a preview line.
// Built the way the engine will deliver bodies: typed arrays, per-triangle face ids, edge polylines with edge ids.
import type { LineKind } from "../viewport/style.ts";
import type { BodyData, PlaneFrame, PreviewData, ProfileData, SketchData, SketchEntity } from "../viewport/types.ts";

type V3 = readonly [number, number, number];

/** A box with six faces (ids 0 bottom, 1 top, 2 front, 3 back, 4 left, 5 right) and twelve edges (ids 0..11). */
export function boxBody(id: string, min: V3, max: V3): BodyData {
  const c: V3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const h: V3 = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2];
  // Per face: outward normal n and two axes u, v with u x v = n, so the corners run counter-clockwise seen from outside.
  const faces: { n: V3; u: V3; v: V3 }[] = [
    { n: [0, 0, -1], u: [1, 0, 0], v: [0, -1, 0] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1] },
    { n: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1] },
    { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  ];
  const positions = new Float32Array(faces.length * 12);
  const normals = new Float32Array(faces.length * 12);
  const indices = new Uint32Array(faces.length * 6);
  const faceIds = new Uint32Array(faces.length * 2);
  faces.forEach((f, i) => {
    const half = (a: V3, k: number) => Math.abs(a[0]) * h[0] * k + Math.abs(a[1]) * h[1] * k + Math.abs(a[2]) * h[2] * k;
    const corners = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([su, sv]) => {
      const out: number[] = [];
      for (let k = 0; k < 3; k++) out.push(c[k]! + f.n[k]! * h[k]! + f.u[k]! * half(f.u, su) + f.v[k]! * half(f.v, sv));
      return out;
    });
    corners.forEach((p, j) => {
      positions.set(p, i * 12 + j * 3);
      normals.set(f.n, i * 12 + j * 3);
    });
    indices.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    faceIds.set([i, i], i * 2);
  });
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const edgeList: [V3, V3][] = [
    [[x0, y0, z0], [x1, y0, z0]], [[x1, y0, z0], [x1, y1, z0]], [[x1, y1, z0], [x0, y1, z0]], [[x0, y1, z0], [x0, y0, z0]],
    [[x0, y0, z1], [x1, y0, z1]], [[x1, y0, z1], [x1, y1, z1]], [[x1, y1, z1], [x0, y1, z1]], [[x0, y1, z1], [x0, y0, z1]],
    [[x0, y0, z0], [x0, y0, z1]], [[x1, y0, z0], [x1, y0, z1]], [[x1, y1, z0], [x1, y1, z1]], [[x0, y1, z0], [x0, y1, z1]],
  ];
  const edgePositions = new Float32Array(edgeList.length * 6);
  const offsets = new Uint32Array(edgeList.length + 1);
  const ids = new Uint32Array(edgeList.length);
  edgeList.forEach(([a, b], i) => {
    edgePositions.set([...a, ...b], i * 6);
    offsets[i + 1] = (i + 1) * 2;
    ids[i] = i;
  });
  return { id, positions, normals, indices, faceIds, edges: { positions: edgePositions, offsets, ids } };
}

/** A cylinder along Z with three faces (0 side, 1 top, 2 bottom) and two edges (0 top circle, 1 bottom circle). */
export function cylinderBody(id: string, center: readonly [number, number], radius: number, z0: number, z1: number, segments = 64): BodyData {
  const ring = segments + 1; // the seam vertex is doubled so the side has a clean parameter range
  const vertexCount = ring * 2 + 2 * (segments + 2);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices: number[] = [];
  const faceIds: number[] = [];
  const angle = (i: number) => (i / segments) * Math.PI * 2;
  // Side: vertices 0..ring-1 at z0, ring..2*ring-1 at z1, smooth normals.
  for (let i = 0; i < ring; i++) {
    const nx = Math.cos(angle(i)), ny = Math.sin(angle(i));
    positions.set([center[0] + radius * nx, center[1] + radius * ny, z0], i * 3);
    positions.set([center[0] + radius * nx, center[1] + radius * ny, z1], (ring + i) * 3);
    normals.set([nx, ny, 0], i * 3);
    normals.set([nx, ny, 0], (ring + i) * 3);
  }
  for (let i = 0; i < segments; i++) {
    indices.push(i, i + 1, ring + i + 1, i, ring + i + 1, ring + i);
    faceIds.push(0, 0);
  }
  // Top and bottom: a fan around a centre vertex.
  const cap = (base: number, z: number, nz: number, face: number) => {
    positions.set([center[0], center[1], z], base * 3);
    normals.set([0, 0, nz], base * 3);
    for (let i = 0; i <= segments; i++) {
      positions.set([center[0] + radius * Math.cos(angle(i)), center[1] + radius * Math.sin(angle(i)), z], (base + 1 + i) * 3);
      normals.set([0, 0, nz], (base + 1 + i) * 3);
    }
    for (let i = 0; i < segments; i++) {
      if (nz > 0) indices.push(base, base + 1 + i, base + 2 + i);
      else indices.push(base, base + 2 + i, base + 1 + i);
      faceIds.push(face);
    }
  };
  cap(2 * ring, z1, 1, 1);
  cap(2 * ring + segments + 2, z0, -1, 2);
  // Edges: the two circles as closed polylines.
  const circle = (z: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i <= segments; i++) out.push(center[0] + radius * Math.cos(angle(i)), center[1] + radius * Math.sin(angle(i)), z);
    return out;
  };
  const edgePositions = new Float32Array([...circle(z1), ...circle(z0)]);
  return {
    id,
    positions,
    normals,
    indices: new Uint32Array(indices),
    faceIds: new Uint32Array(faceIds),
    edges: { positions: edgePositions, offsets: new Uint32Array([0, segments + 1, 2 * (segments + 1)]), ids: new Uint32Array([0, 1]) },
  };
}

/** The line kinds shown in the demo sketch, one row each. */
export const demoLineKinds: readonly LineKind[] = [
  "sketchUnder", "sketchFull", "sketchOver", "construction", "centre", "dimLine", "constraint", "projected", "bodyEdge", "silhouette", "hiddenEdge", "error",
];

export interface DemoScene {
  bodies: BodyData[];
  sketches: SketchData[];
  preview: PreviewData;
}

export function demoScene(): DemoScene {
  const rows: SketchEntity[] = demoLineKinds.map((kind, i) => ({ id: i, kind, geometry: { type: "line", a: [-30, i * 5], b: [30, i * 5] } }));
  const lines: SketchData = { id: "kinds", plane: { origin: [0, -100, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] }, entities: rows };
  const profile: SketchData = {
    id: "profile",
    plane: { origin: [0, 0, 40], xAxis: [1, 0, 0], yAxis: [0, 1, 0] },
    entities: [
      { id: 0, kind: "sketchFull", geometry: { type: "circle", center: [-25, 0], radius: 15 } },
      { id: 1, kind: "construction", geometry: { type: "arc", center: [-25, 0], radius: 22, start: 0.3, end: 2.6 } },
      { id: 2, kind: "sketchUnder", geometry: { type: "polyline", closed: true, points: [[10, -10], [40, -10], [40, 10], [10, 10]] } },
      { id: 3, kind: "centre", geometry: { type: "line", a: [-50, 0], b: [50, 0] } },
    ],
  };
  const preview: PreviewData = {
    sketches: [{ id: "rubber", plane: { origin: [0, 0, 20], xAxis: [1, 0, 0], yAxis: [0, 1, 0] }, entities: [{ id: 0, kind: "sketchOver", geometry: { type: "line", a: [-40, -25], b: [40, 25] } }] }],
  };
  return {
    bodies: [boxBody("box", [-40, -25, 0], [40, 25, 20]), cylinderBody("cylinder", [75, 0], 18, 0, 30)],
    sketches: [lines, profile],
    preview,
  };
}

// --- the extrude demo (?demo=viewport&extrude=1) ---------------------------------------------------------------------

/** A rectangle with a square hole in the middle as triangles (u v pairs, three vertices per triangle), the way the engine cuts holes out. */
export function frameTriangles(u0: number, v0: number, u1: number, v1: number, hole: number): Float32Array {
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  const o: [number, number][] = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
  const i: [number, number][] = [[cu - hole, cv - hole], [cu + hole, cv - hole], [cu + hole, cv + hole], [cu - hole, cv + hole]];
  const t: number[] = [];
  for (let k = 0; k < 4; k++) {
    const a = o[k]!, b = o[(k + 1) % 4]!, c = i[(k + 1) % 4]!, d = i[k]!;
    t.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return Float32Array.from(t);
}

/** A disc as a fan of triangles. */
export function discTriangles(cu: number, cv: number, radius: number, segments = 48): Float32Array {
  const t: number[] = [];
  for (let k = 0; k < segments; k++) {
    const a = (k / segments) * Math.PI * 2, b = ((k + 1) / segments) * Math.PI * 2;
    t.push(cu, cv, cu + radius * Math.cos(a), cv + radius * Math.sin(a), cu + radius * Math.cos(b), cv + radius * Math.sin(b));
  }
  return Float32Array.from(t);
}

export interface ExtrudeSample {
  profiles: ProfileData[];
  /** The plane of the sketch: the top face of the demo box. */
  plane: PlaneFrame;
  /** Where the arrow starts for the first profile (its centre on the plane) and the box the preview is built from. */
  origin: readonly [number, number, number];
  rect: { u0: number; v0: number; u1: number; v1: number };
}

/** Two regions on the top face (z = 20) of the demo box: a frame with a hole, and a disc beside it. */
export function extrudeSample(): ExtrudeSample {
  const plane: PlaneFrame = { origin: [0, 0, 20], xAxis: [1, 0, 0], yAxis: [0, 1, 0] };
  const rect = { u0: -34, v0: -18, u1: -4, v1: 18 };
  return {
    plane,
    rect,
    origin: [-8.5, 0, 20],
    profiles: [
      { sketchId: "s-top", regionId: "l1,l2,l3,l4|l5,l6,l7,l8", plane, triangles: frameTriangles(rect.u0, rect.v0, rect.u1, rect.v1, 6) },
      { sketchId: "s-top", regionId: "c9", plane, triangles: discTriangles(20, 0, 14) },
    ],
  };
}

/**
 * A prism over a triangle fill, from the plane's offset `from` to `to` along its normal (a stand-in for what the engine's
 * extrusion preview delivers): caps from the triangles, walls from the boundary edges, edge polylines for the outline of both caps
 * and the sharp corners. Face ids: 0 bottom cap, 1 top cap, 2.. one per wall segment.
 */
export function prismBody(id: string, plane: PlaneFrame, triangles: Float32Array, from: number, to: number): BodyData {
  const n: V3 = [plane.xAxis[1] * plane.yAxis[2] - plane.xAxis[2] * plane.yAxis[1], plane.xAxis[2] * plane.yAxis[0] - plane.xAxis[0] * plane.yAxis[2], plane.xAxis[0] * plane.yAxis[1] - plane.xAxis[1] * plane.yAxis[0]];
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const at = (u: number, v: number, h: number): V3 => [
    plane.origin[0] + plane.xAxis[0] * u + plane.yAxis[0] * v + n[0] * h,
    plane.origin[1] + plane.xAxis[1] * u + plane.yAxis[1] * v + n[1] * h,
    plane.origin[2] + plane.xAxis[2] * u + plane.yAxis[2] * v + n[2] * h,
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faceIds: number[] = [];
  const quad = (p: V3[], normal: V3, face: number) => {
    const base = positions.length / 3;
    for (const q of p) { positions.push(...q); normals.push(...normal); }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    faceIds.push(face, face);
  };
  const tri = (a: V3, b: V3, c: V3, normal: V3, face: number) => {
    const base = positions.length / 3;
    for (const q of [a, b, c]) { positions.push(...q); normals.push(...normal); }
    indices.push(base, base + 1, base + 2);
    faceIds.push(face);
  };
  // Every triangle counter-clockwise in (u, v); the boundary edges keep that direction (interior on the left).
  const edges = new Map<string, { a: [number, number]; b: [number, number]; count: number }>();
  const key = (p: [number, number]) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`;
  for (let t = 0; t + 5 < triangles.length; t += 6) {
    let a: [number, number] = [triangles[t]!, triangles[t + 1]!], b: [number, number] = [triangles[t + 2]!, triangles[t + 3]!];
    const c: [number, number] = [triangles[t + 4]!, triangles[t + 5]!];
    if ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]) < 0) [a, b] = [b, a];
    tri(at(a[0], a[1], hi), at(b[0], b[1], hi), at(c[0], c[1], hi), n, 1);
    tri(at(a[0], a[1], lo), at(c[0], c[1], lo), at(b[0], b[1], lo), [-n[0], -n[1], -n[2]], 0);
    for (const [p, q] of [[a, b], [b, c], [c, a]] as [number, number][][]) {
      const k1 = `${key(p as [number, number])}|${key(q as [number, number])}`, k2 = `${key(q as [number, number])}|${key(p as [number, number])}`;
      const found = edges.get(k2);
      if (found) found.count++;
      else edges.set(k1, { a: p as [number, number], b: q as [number, number], count: 1 });
    }
  }
  const boundary = [...edges.values()].filter((e) => e.count === 1);
  let face = 2;
  for (const e of boundary) {
    const du = e.b[0] - e.a[0], dv = e.b[1] - e.a[1], len = Math.hypot(du, dv) || 1;
    const out: V3 = [(plane.xAxis[0] * dv - plane.yAxis[0] * du) / len, (plane.xAxis[1] * dv - plane.yAxis[1] * du) / len, (plane.xAxis[2] * dv - plane.yAxis[2] * du) / len];
    quad([at(e.a[0], e.a[1], lo), at(e.b[0], e.b[1], lo), at(e.b[0], e.b[1], hi), at(e.a[0], e.a[1], hi)], out, face++);
  }
  // Edge lines: both cap outlines, and a vertical line wherever the outline turns by more than 20 degrees.
  const edgePositions: number[] = [];
  const ids: number[] = [];
  const offsets: number[] = [0];
  const line = (p: V3, q: V3) => { edgePositions.push(...p, ...q); ids.push(ids.length); offsets.push(offsets[offsets.length - 1]! + 2); };
  for (const e of boundary) {
    line(at(e.a[0], e.a[1], lo), at(e.b[0], e.b[1], lo));
    line(at(e.a[0], e.a[1], hi), at(e.b[0], e.b[1], hi));
  }
  for (const e of boundary) {
    const next = boundary.find((x) => key(x.a) === key(e.b));
    if (!next) continue;
    const a1 = Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]), a2 = Math.atan2(next.b[1] - next.a[1], next.b[0] - next.a[0]);
    const turn = Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)));
    if (turn > (20 * Math.PI) / 180) line(at(e.b[0], e.b[1], lo), at(e.b[0], e.b[1], hi));
  }
  return {
    id,
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
    faceIds: Uint32Array.from(faceIds),
    edges: { positions: Float32Array.from(edgePositions), offsets: Uint32Array.from(offsets), ids: Uint32Array.from(ids) },
  };
}
