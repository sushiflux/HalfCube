import { describe, expect, it } from "vitest";
import { boxBody, cylinderBody, demoLineKinds, demoScene } from "../../../app/src/dev/viewport-sample.ts";
import {
  bodyBounds, bodyEdgeSegments, buildFaceIndex, buildSegments, copyTriangles, entityPolyline, originPlaneFrame,
  planeNormal, planeToWorld, segmentsOfOwner, sketchSegments, tessellateArc, trianglesBounds, validateBody,
} from "../../../app/src/viewport/geometry.ts";
import type { BodyData } from "../../../app/src/viewport/types.ts";

/** Signed volume of a closed triangle mesh: positive when the triangles are counter-clockwise seen from outside. */
function signedVolume(b: BodyData): number {
  let v = 0;
  for (let t = 0; t < b.indices.length / 3; t++) {
    const p = [0, 1, 2].map((k) => [0, 1, 2].map((c) => b.positions[b.indices[t * 3 + k]! * 3 + c]!));
    const [a, bb, c] = p as [number[], number[], number[]];
    v += (a[0]! * (bb[1]! * c[2]! - bb[2]! * c[1]!) - a[1]! * (bb[0]! * c[2]! - bb[2]! * c[0]!) + a[2]! * (bb[0]! * c[1]! - bb[1]! * c[0]!)) / 6;
  }
  return v;
}

describe("origin planes", () => {
  it("have the normals +Z (XY), -Y (XZ) and +X (YZ)", () => {
    expect(planeNormal(originPlaneFrame("xy"))).toEqual([0, 0, 1]);
    expect(planeNormal(originPlaneFrame("xz"))).toEqual([0, -1, 0]);
    expect(planeNormal(originPlaneFrame("yz"))).toEqual([1, 0, 0]);
  });

  it("map plane coordinates to the world", () => {
    expect(planeToWorld({ origin: [1, 2, 3], xAxis: [1, 0, 0], yAxis: [0, 0, 1] }, [10, 20])).toEqual([11, 2, 23]);
  });
});

describe("sketch entities to polylines", () => {
  it("an arc runs counter-clockwise from start to end, both ends included", () => {
    const pts = tessellateArc([0, 0], 10, 0, Math.PI / 2);
    expect(pts[0]![0]).toBeCloseTo(10, 9);
    expect(pts[0]![1]).toBeCloseTo(0, 9);
    const last = pts[pts.length - 1]!;
    expect(last[0]).toBeCloseTo(0, 9);
    expect(last[1]).toBeCloseTo(10, 9);
    expect(pts.length).toBeGreaterThanOrEqual(3);
  });

  it("an arc whose end angle is below its start goes the long way round counter-clockwise", () => {
    const pts = tessellateArc([0, 0], 1, Math.PI / 2, 0);
    // from 90 degrees counter-clockwise to 0 degrees = 270 degrees; the middle point is at 225 degrees
    const mid = pts[Math.floor(pts.length / 2)]!;
    expect(mid[0]).toBeLessThan(0);
    expect(mid[1]).toBeLessThan(0);
  });

  it("every point of an arc lies on its circle, and neighbours are never more than ~2.8 degrees apart", () => {
    const pts = tessellateArc([5, -3], 40, 0.3, 4);
    const steps: number[] = [];
    let prev = 0.3;
    pts.forEach((p, i) => {
      expect(Math.hypot(p[0] - 5, p[1] + 3)).toBeCloseTo(40, 9);
      const a = Math.atan2(p[1] + 3, p[0] - 5);
      if (i > 0) {
        let d = a - prev;
        if (d < -Math.PI) d += 2 * Math.PI;
        steps.push(d);
      }
      prev = a;
    });
    expect(Math.max(...steps)).toBeLessThanOrEqual((2 * Math.PI) / 128 + 1e-9);
    expect(Math.min(...steps)).toBeGreaterThan(0);
  });

  it("a circle is closed: the last point equals the first", () => {
    const pts = entityPolyline({ type: "circle", center: [1, 1], radius: 3 });
    expect(pts.length).toBe(129);
    expect(pts[0]![0]).toBeCloseTo(pts[pts.length - 1]![0], 9);
    expect(pts[0]![1]).toBeCloseTo(pts[pts.length - 1]![1], 9);
  });

  it("a closed polyline repeats its first point, an open one does not", () => {
    const square = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;
    expect(entityPolyline({ type: "polyline", points: square, closed: true }).length).toBe(5);
    expect(entityPolyline({ type: "polyline", points: square }).length).toBe(4);
  });
});

describe("line segments", () => {
  it("dash distances restart at every polyline and add up along it", () => {
    const s = buildSegments([
      { owner: 1, points: [[0, 0, 0], [3, 4, 0], [3, 4, 12]] },
      { owner: 2, points: [[0, 0, 0], [0, 0, 7]] },
    ]);
    expect(s.segmentCount).toBe(3);
    expect(Array.from(s.distanceStart)).toEqual([0, 5, 0]);
    expect(Array.from(s.distanceEnd)).toEqual([5, 17, 7]);
    expect(Array.from(s.owners)).toEqual([1, 1, 2]);
  });

  it("groups a sketch's entities by line kind", () => {
    const scene = demoScene();
    const kinds = sketchSegments(scene.sketches[0]!);
    expect([...kinds.keys()].sort()).toEqual([...demoLineKinds].sort());
    for (const buffers of kinds.values()) expect(buffers.segmentCount).toBe(1);
  });

  it("the body edges keep their engine ids and can be cut out by id", () => {
    const box = boxBody("b", [0, 0, 0], [10, 10, 10]);
    const edges = bodyEdgeSegments(box.edges!);
    expect(edges.segmentCount).toBe(12);
    expect(Array.from(new Set(edges.owners)).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(segmentsOfOwner(edges, 4).length).toBe(6);
    expect(segmentsOfOwner(edges, 99).length).toBe(0);
  });

  it("a curved edge gives one segment per piece, and its owner owns all of them", () => {
    const cyl = cylinderBody("c", [0, 0], 5, 0, 10, 16);
    const edges = bodyEdgeSegments(cyl.edges!);
    expect(edges.segmentCount).toBe(32);
    expect(segmentsOfOwner(edges, 1).length).toBe(16 * 6);
  });
});

describe("bodies", () => {
  it("the sample box is valid, closed and its triangles face outwards (volume 80 x 50 x 20)", () => {
    const box = boxBody("box", [-40, -25, 0], [40, 25, 20]);
    expect(validateBody(box)).toBeNull();
    expect(signedVolume(box)).toBeCloseTo(80 * 50 * 20, 3);
  });

  it("the sample cylinder is valid and its triangles face outwards (volume close to pi r^2 h)", () => {
    const cyl = cylinderBody("c", [75, 0], 18, 0, 30, 64);
    expect(validateBody(cyl)).toBeNull();
    const exact = Math.PI * 18 * 18 * 30;
    expect(signedVolume(cyl)).toBeGreaterThan(exact * 0.99);
    expect(signedVolume(cyl)).toBeLessThan(exact);
  });

  it("normals are unit length", () => {
    const box = boxBody("b", [0, 0, 0], [1, 2, 3]);
    for (let i = 0; i < box.normals.length; i += 3) expect(Math.hypot(box.normals[i]!, box.normals[i + 1]!, box.normals[i + 2]!)).toBeCloseTo(1, 6);
  });

  it("validation names the first problem", () => {
    const box = boxBody("b", [0, 0, 0], [1, 1, 1]);
    expect(validateBody({ ...box, faceIds: new Uint32Array(3) })).toMatch(/faceIds has 3 entries for 12 triangles/);
    expect(validateBody({ ...box, normals: new Float32Array(3) })).toMatch(/normals has 3 values/);
    expect(validateBody({ ...box, indices: new Uint32Array([0, 1, 999]), faceIds: new Uint32Array(1) })).toMatch(/index 2 points at vertex 999/);
    expect(validateBody({ ...box, edges: { ...box.edges!, offsets: new Uint32Array(2) } })).toMatch(/offsets has 2 entries/);
  });

  it("the face index lists every triangle of a face exactly once", () => {
    const box = boxBody("b", [0, 0, 0], [1, 1, 1]);
    const index = buildFaceIndex(box.faceIds);
    expect(index.size).toBe(6);
    let total = 0;
    for (const [face, triangles] of index) {
      expect(triangles.length).toBe(2);
      for (const t of triangles) expect(box.faceIds[t]).toBe(face);
      total += triangles.length;
    }
    expect(total).toBe(12);
  });

  it("copies the triangles of a face and finds their bounds", () => {
    const box = boxBody("b", [0, 0, 0], [10, 20, 30]);
    const top = buildFaceIndex(box.faceIds).get(1)!;
    const copy = copyTriangles(box, top);
    expect(copy.positions.length).toBe(2 * 9);
    for (let i = 2; i < copy.positions.length; i += 3) expect(copy.positions[i]).toBe(30);
    expect(trianglesBounds(box, top)).toEqual({ min: [0, 0, 30], max: [10, 20, 30] });
    expect(bodyBounds(box)).toEqual({ min: [0, 0, 0], max: [10, 20, 30] });
  });
});
