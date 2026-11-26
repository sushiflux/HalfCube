// Geometry preparation for the viewport: sketch entities to polylines, polylines to line segments with dash distances,
// the face-to-triangle index, the grid lattice. Pure functions on plain numbers and typed arrays (no three.js).
import { boundsOfPositions, emptyBounds, unionBounds, type Bounds, type Vec3 } from "./math.ts";
import type { LineKind } from "./style.ts";
import type { BodyData, BodyEdges, PlaneFrame, PlaneId, SketchData, SketchGeometry, Vec2 } from "./types.ts";

// --- planes -----------------------------------------------------------------------------------------------------

/** The origin planes as frames. Normals: XY +Z, XZ -Y (towards the viewer of the front view), YZ +X. */
export function originPlaneFrame(id: PlaneId): PlaneFrame {
  switch (id) {
    case "xy": return { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] };
    case "xz": return { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 0, 1] };
    case "yz": return { origin: [0, 0, 0], xAxis: [0, 1, 0], yAxis: [0, 0, 1] };
  }
}

export function planeNormal(frame: PlaneFrame): Vec3 {
  const a = frame.xAxis, b = frame.yAxis;
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function planeToWorld(frame: PlaneFrame, p: Vec2): Vec3 {
  const { origin, xAxis, yAxis } = frame;
  return [origin[0] + xAxis[0] * p[0] + yAxis[0] * p[1], origin[1] + xAxis[1] * p[0] + yAxis[1] * p[1], origin[2] + xAxis[2] * p[0] + yAxis[2] * p[1]];
}

// --- sketch entities to polylines -------------------------------------------------------------------------------

/** Largest angle between two neighbouring points of an arc, radians (about 2.8 degrees, so a circle has 128 segments). */
const MAX_ARC_STEP = (2 * Math.PI) / 128;

/** Points along a counter-clockwise arc from `start` to `end`, both ends included. */
export function tessellateArc(center: Vec2, radius: number, start: number, end: number): Vec2[] {
  let sweep = end - start;
  // A counter-clockwise arc always has a positive sweep up to a full turn.
  if (sweep <= 0) sweep += Math.PI * 2 * Math.ceil((-sweep + 1e-12) / (Math.PI * 2));
  if (sweep > Math.PI * 2) sweep = Math.PI * 2;
  const steps = Math.max(2, Math.ceil(sweep / MAX_ARC_STEP));
  const out: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = start + (sweep * i) / steps;
    out.push([center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)]);
  }
  return out;
}

/** One entity as a 2D polyline (a closed shape repeats its first point at the end). */
export function entityPolyline(g: SketchGeometry): Vec2[] {
  switch (g.type) {
    case "line": return [g.a, g.b];
    case "circle": return tessellateArc(g.center, g.radius, 0, Math.PI * 2);
    case "arc": return tessellateArc(g.center, g.radius, g.start, g.end);
    case "polyline": return g.closed && g.points.length > 2 ? [...g.points, g.points[0]!] : [...g.points];
  }
}

// --- polylines to line segments ---------------------------------------------------------------------------------

/** Line segments for the line renderer. Six floats per segment; dash distances restart at every polyline. */
export interface SegmentBuffers {
  /** x0 y0 z0 x1 y1 z1 per segment. */
  positions: Float32Array;
  /** Length along its polyline at the start and at the end of each segment, mm: the dash phase. */
  distanceStart: Float32Array;
  distanceEnd: Float32Array;
  /** The owner (an entity id or an edge id) of each segment. */
  owners: Uint32Array;
  segmentCount: number;
}

export interface Polyline {
  owner: number;
  /** xyz triples. */
  points: readonly Vec3[];
}

export function buildSegments(polylines: readonly Polyline[]): SegmentBuffers {
  let count = 0;
  for (const p of polylines) count += Math.max(0, p.points.length - 1);
  const positions = new Float32Array(count * 6);
  const distanceStart = new Float32Array(count);
  const distanceEnd = new Float32Array(count);
  const owners = new Uint32Array(count);
  let s = 0;
  for (const poly of polylines) {
    let dist = 0;
    for (let i = 0; i + 1 < poly.points.length; i++) {
      const a = poly.points[i]!, b = poly.points[i + 1]!;
      positions.set(a, s * 6);
      positions.set(b, s * 6 + 3);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      distanceStart[s] = dist;
      distanceEnd[s] = dist + len;
      owners[s] = poly.owner;
      dist += len;
      s++;
    }
  }
  return { positions, distanceStart, distanceEnd, owners, segmentCount: count };
}

/** The segments of a sketch, one group per line kind (every kind is drawn with its own colour, weight and dashes). */
export function sketchSegments(sketch: SketchData): Map<LineKind, SegmentBuffers> {
  const byKind = new Map<LineKind, Polyline[]>();
  for (const e of sketch.entities) {
    const points = entityPolyline(e.geometry).map((p) => planeToWorld(sketch.plane, p));
    const list = byKind.get(e.kind) ?? [];
    list.push({ owner: e.id, points });
    byKind.set(e.kind, list);
  }
  const out = new Map<LineKind, SegmentBuffers>();
  for (const [kind, polylines] of byKind) out.set(kind, buildSegments(polylines));
  return out;
}

/** The edge polylines of a body as segments; the owner of a segment is its edge id. */
export function bodyEdgeSegments(edges: BodyEdges): SegmentBuffers {
  const polylines: Polyline[] = [];
  for (let i = 0; i < edges.ids.length; i++) {
    const from = edges.offsets[i]!, to = edges.offsets[i + 1]!;
    const points: Vec3[] = [];
    for (let v = from; v < to; v++) points.push([edges.positions[v * 3]!, edges.positions[v * 3 + 1]!, edges.positions[v * 3 + 2]!]);
    polylines.push({ owner: edges.ids[i]!, points });
  }
  return buildSegments(polylines);
}

/** Positions of the segments of one owner only (an edge or a sketch entity), for its highlight. */
export function segmentsOfOwner(buffers: SegmentBuffers, owner: number): Float32Array {
  const picked: number[] = [];
  for (let s = 0; s < buffers.segmentCount; s++) {
    if (buffers.owners[s] !== owner) continue;
    for (let k = 0; k < 6; k++) picked.push(buffers.positions[s * 6 + k]!);
  }
  return Float32Array.from(picked);
}

export function segmentBounds(buffers: SegmentBuffers): Bounds {
  return buffers.segmentCount === 0 ? emptyBounds() : boundsOfPositions(buffers.positions);
}

// --- bodies -----------------------------------------------------------------------------------------------------

/** Triangle numbers of every face, built once per body from the per-triangle face ids (counting sort). */
export function buildFaceIndex(faceIds: Uint32Array): Map<number, Uint32Array> {
  const counts = new Map<number, number>();
  for (let t = 0; t < faceIds.length; t++) counts.set(faceIds[t]!, (counts.get(faceIds[t]!) ?? 0) + 1);
  const lists = new Map<number, Uint32Array>();
  const fill = new Map<number, number>();
  for (const [id, n] of counts) {
    lists.set(id, new Uint32Array(n));
    fill.set(id, 0);
  }
  for (let t = 0; t < faceIds.length; t++) {
    const id = faceIds[t]!;
    const at = fill.get(id)!;
    lists.get(id)![at] = t;
    fill.set(id, at + 1);
  }
  return lists;
}

/** A non-indexed copy of the given triangles (positions and normals), for drawing a highlight over a face. */
export function copyTriangles(body: Pick<BodyData, "positions" | "normals" | "indices">, triangles: Uint32Array): { positions: Float32Array; normals: Float32Array } {
  const positions = new Float32Array(triangles.length * 9);
  const normals = new Float32Array(triangles.length * 9);
  for (let i = 0; i < triangles.length; i++) {
    for (let k = 0; k < 3; k++) {
      const v = body.indices[triangles[i]! * 3 + k]!;
      for (let c = 0; c < 3; c++) {
        positions[i * 9 + k * 3 + c] = body.positions[v * 3 + c]!;
        normals[i * 9 + k * 3 + c] = body.normals[v * 3 + c]!;
      }
    }
  }
  return { positions, normals };
}

/** Bounds of the listed triangles. */
export function trianglesBounds(body: Pick<BodyData, "positions" | "indices">, triangles: Uint32Array): Bounds {
  let b = emptyBounds();
  for (let i = 0; i < triangles.length; i++) {
    for (let k = 0; k < 3; k++) {
      const v = body.indices[triangles[i]! * 3 + k]!;
      b = unionBounds(b, { min: [body.positions[v * 3]!, body.positions[v * 3 + 1]!, body.positions[v * 3 + 2]!], max: [body.positions[v * 3]!, body.positions[v * 3 + 1]!, body.positions[v * 3 + 2]!] });
    }
  }
  return b;
}

export function bodyBounds(body: Pick<BodyData, "positions">): Bounds {
  return body.positions.length === 0 ? emptyBounds() : boundsOfPositions(body.positions);
}

/** Checks the sizes of a body's arrays; returns a message for the first problem or null. */
export function validateBody(b: BodyData): string | null {
  if (b.positions.length % 3 !== 0) return `Body ${b.id}: positions has ${b.positions.length} values, not a multiple of 3.`;
  if (b.normals.length !== b.positions.length) return `Body ${b.id}: normals has ${b.normals.length} values, positions ${b.positions.length}.`;
  if (b.indices.length % 3 !== 0) return `Body ${b.id}: indices has ${b.indices.length} values, not a multiple of 3.`;
  if (b.faceIds.length !== b.indices.length / 3) return `Body ${b.id}: faceIds has ${b.faceIds.length} entries for ${b.indices.length / 3} triangles.`;
  const vertexCount = b.positions.length / 3;
  for (let i = 0; i < b.indices.length; i++) if (b.indices[i]! >= vertexCount) return `Body ${b.id}: index ${i} points at vertex ${b.indices[i]}, but there are only ${vertexCount}.`;
  if (b.edges) {
    const e = b.edges;
    if (e.offsets.length !== e.ids.length + 1) return `Body ${b.id}: edges.offsets has ${e.offsets.length} entries for ${e.ids.length} edges (needs one more than ids).`;
    if (e.positions.length % 3 !== 0) return `Body ${b.id}: edges.positions has ${e.positions.length} values, not a multiple of 3.`;
    if ((e.offsets[e.offsets.length - 1] ?? 0) * 3 > e.positions.length) return `Body ${b.id}: edges.offsets reaches past the end of edges.positions.`;
  }
  return null;
}
