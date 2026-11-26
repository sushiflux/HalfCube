import { describe, expect, it } from "vitest";
import { boxBody, cylinderBody } from "../../../app/src/dev/viewport-sample.ts";
import { DEFAULT_FOV_Y, screenRay, worldToScreen, type Lens, type ViewState } from "../../../app/src/viewport/camera.ts";
import { bodyEdgeSegments, buildFaceIndex, buildSegments } from "../../../app/src/viewport/geometry.ts";
import type { Vec3 } from "../../../app/src/viewport/math.ts";
import { choosePick, nearestSegment, pointSegmentDistance2D, rayHitsBounds, rayMesh, rayPlane, rayTriangle, type PickCandidate } from "../../../app/src/viewport/picking.ts";

const lens: Lens = { fovY: DEFAULT_FOV_Y, width: 1000, height: 600 };
const home: ViewState = { target: [0, 0, 10], azimuth: Math.PI / 4, elevation: 0.6, distance: 220 };
const ray = (origin: Vec3, dir: Vec3) => ({ origin, dir });

describe("ray against a plane", () => {
  it("hits the XY plane from above and gives the point", () => {
    const hit = rayPlane(ray([3, 4, 10], [0, 0, -1]), [0, 0, 0], [0, 0, 1])!;
    expect(hit.t).toBeCloseTo(10, 12);
    expect(hit.point).toEqual([3, 4, 0]);
  });

  it("misses a plane that is behind the ray or parallel to it", () => {
    expect(rayPlane(ray([0, 0, 10], [0, 0, 1]), [0, 0, 0], [0, 0, 1])).toBeNull();
    expect(rayPlane(ray([0, 0, 10], [1, 0, 0]), [0, 0, 0], [0, 0, 1])).toBeNull();
  });

  it("the pointer ray through a pixel meets the sketch plane where the projected point is", () => {
    const p: Vec3 = [12, -7, 0];
    const s = worldToScreen(home, lens, p)!;
    const hit = rayPlane(screenRay(home, lens, s.x, s.y), [0, 0, 0], [0, 0, 1])!;
    expect(hit.point[0]).toBeCloseTo(12, 5);
    expect(hit.point[1]).toBeCloseTo(-7, 5);
    expect(hit.point[2]).toBeCloseTo(0, 5);
  });
});

describe("ray against triangles", () => {
  it("hits inside, misses outside, either side", () => {
    const r = ray([0.2, 0.2, 5], [0, 0, -1]);
    expect(rayTriangle(r, 0, 0, 0, 1, 0, 0, 0, 1, 0)).toBeCloseTo(5, 12);
    expect(rayTriangle(ray([0.8, 0.8, 5], [0, 0, -1]), 0, 0, 0, 1, 0, 0, 0, 1, 0)).toBeNull();
    // seen from below (back face) it counts too
    expect(rayTriangle(ray([0.2, 0.2, -5], [0, 0, 1]), 0, 0, 0, 1, 0, 0, 0, 1, 0)).toBeCloseTo(5, 12);
  });

  it("does not hit a triangle behind the ray origin", () => {
    expect(rayTriangle(ray([0.2, 0.2, -5], [0, 0, -1]), 0, 0, 0, 1, 0, 0, 0, 1, 0)).toBeNull();
  });
});

describe("ray against a body", () => {
  const box = boxBody("box", [-40, -25, 0], [40, 25, 20]);
  const faces = buildFaceIndex(box.faceIds);

  it("from above hits the top face (id 1) first", () => {
    const hit = rayMesh(ray([10, 5, 100], [0, 0, -1]), box.positions, box.indices)!;
    expect(hit.t).toBeCloseTo(80, 6);
    expect(box.faceIds[hit.triangle]).toBe(1);
    expect(faces.get(1)).toContain(hit.triangle);
  });

  it("from the front hits the front face (id 2), from the right the right face (id 5)", () => {
    expect(box.faceIds[rayMesh(ray([0, -100, 10], [0, 1, 0]), box.positions, box.indices)!.triangle]).toBe(2);
    expect(box.faceIds[rayMesh(ray([100, 0, 10], [-1, 0, 0]), box.positions, box.indices)!.triangle]).toBe(5);
  });

  it("misses beside the box", () => {
    expect(rayMesh(ray([100, 100, 100], [0, 0, -1]), box.positions, box.indices)).toBeNull();
  });

  it("the bounds test accepts rays that hit the box and rejects the others", () => {
    const bounds = { min: [-40, -25, 0] as Vec3, max: [40, 25, 20] as Vec3 };
    expect(rayHitsBounds(ray([0, 0, 100], [0, 0, -1]), bounds)).toBe(true);
    expect(rayHitsBounds(ray([100, 0, 100], [0, 0, -1]), bounds)).toBe(false);
    expect(rayHitsBounds(ray([0, 0, 10], [1, 0, 0]), bounds)).toBe(true);
  });

  it("the cylinder side, top and bottom report their own faces", () => {
    const cyl = cylinderBody("c", [0, 0], 10, 0, 30);
    expect(cyl.faceIds[rayMesh(ray([50, 0.3, 15], [-1, 0, 0]), cyl.positions, cyl.indices)!.triangle]).toBe(0);
    expect(cyl.faceIds[rayMesh(ray([1, 1, 80], [0, 0, -1]), cyl.positions, cyl.indices)!.triangle]).toBe(1);
    expect(cyl.faceIds[rayMesh(ray([1, 1, -80], [0, 0, 1]), cyl.positions, cyl.indices)!.triangle]).toBe(2);
  });
});

describe("lines on the screen", () => {
  it("distance from a point to a segment, with the position along it", () => {
    expect(pointSegmentDistance2D(5, 3, 0, 0, 10, 0)).toEqual({ distance: 3, s: 0.5 });
    expect(pointSegmentDistance2D(-4, 3, 0, 0, 10, 0)).toEqual({ distance: 5, s: 0 });
    expect(pointSegmentDistance2D(1, 1, 2, 2, 2, 2).distance).toBeCloseTo(Math.SQRT2, 12);
  });

  const box = boxBody("box", [-40, -25, 0], [40, 25, 20]);
  const edges = bodyEdgeSegments(box.edges!);

  it("finds the box edge nearest to the pointer and reports its id", () => {
    // Middle of edge 9 (the vertical edge at x = 40, y = -25).
    const mid: Vec3 = [40, -25, 10];
    const s = worldToScreen(home, lens, mid)!;
    const hit = nearestSegment(home, lens, edges, s.x + 2, s.y + 1, 5)!;
    expect(hit.owner).toBe(9);
    expect(hit.distancePx).toBeLessThan(3);
    expect(hit.point[0]).toBeCloseTo(40, 3);
    expect(hit.point[1]).toBeCloseTo(-25, 3);
    expect(hit.depth).toBeGreaterThan(0);
  });

  it("finds nothing beyond the tolerance", () => {
    const s = worldToScreen(home, lens, [40, -25, 10])!;
    expect(nearestSegment(home, lens, edges, s.x + 40, s.y, 5)).toBeNull();
  });

  it("the point on a slanted segment is perspective-correct", () => {
    // A segment going away from the camera: the screen midpoint is not the 3D midpoint.
    const view: ViewState = { target: [0, 0, 0], azimuth: 0, elevation: 0, distance: 100 };
    const buffers = buildSegments([{ owner: 1, points: [[0, -50, 0], [0, 300, 0]] }]);
    const a = worldToScreen(view, lens, [0, -50, 0])!;
    const b = worldToScreen(view, lens, [0, 300, 0])!;
    // Looking along the segment: both ends project to the same pixel, the whole segment is within a pixel.
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-6);
    expect(nearestSegment(view, lens, buffers, a.x, a.y, 3)?.owner).toBe(1);
    const side: ViewState = { target: [0, 0, 0], azimuth: Math.PI / 2 - 0.5, elevation: 0, distance: 400 };
    const slanted = buildSegments([{ owner: 7, points: [[-100, -100, 0], [100, 100, 0]] }]);
    const sa = worldToScreen(side, lens, [-100, -100, 0])!, sb = worldToScreen(side, lens, [100, 100, 0])!;
    const hit = nearestSegment(side, lens, slanted, (sa.x + sb.x) / 2, (sa.y + sb.y) / 2, 3)!;
    // The nearer half looks longer, so the 3D point under the screen midpoint is nearer to the camera end than the middle.
    const nearEnd = sa.depth < sb.depth ? [-100, -100] : [100, 100];
    const toNear = Math.hypot(hit.point[0] - nearEnd[0]!, hit.point[1] - nearEnd[1]!);
    expect(toNear).toBeLessThan(Math.hypot(200, 200) / 2);
    const back = worldToScreen(side, lens, hit.point)!;
    expect(back.x).toBeCloseTo((sa.x + sb.x) / 2, 3);
    expect(back.y).toBeCloseTo((sa.y + sb.y) / 2, 3);
  });

  it("cuts a segment that reaches behind the camera instead of dropping it", () => {
    const view: ViewState = { target: [0, 0, 0], azimuth: 0, elevation: 0, distance: 100 };
    // The eye is at y = -100; this line runs from behind the eye to far in front.
    const buffers = buildSegments([{ owner: 3, points: [[20, -300, 0], [20, 200, 0]] }]);
    const s = worldToScreen(view, lens, [20, 0, 0])!;
    expect(nearestSegment(view, lens, buffers, s.x, s.y, 4)?.owner).toBe(3);
  });
});

describe("choosing one thing", () => {
  const cand = (kind: PickCandidate["ref"]["kind"], depth: number): PickCandidate => {
    const ref = kind === "face" ? { kind, bodyId: "b", faceId: 1 } as const
      : kind === "edge" ? { kind, bodyId: "b", edgeId: 2 } as const
      : kind === "sketch" ? { kind, sketchId: "s", entityId: 3 } as const
      : kind === "profile" ? { kind, sketchId: "s", regionId: "r" } as const
      : { kind, plane: "xy" } as const;
    return { ref, point: [0, 0, 0], depth, distancePx: 0 };
  };

  it("a sketch entity beats an edge, an edge beats a face, a face beats a plane behind it", () => {
    const face = cand("face", 100), edge = cand("edge", 100), sketch = cand("sketch", 100), plane = cand("plane", 150);
    expect(choosePick({ sketch, edge, face, plane }, 1)?.ref.kind).toBe("sketch");
    expect(choosePick({ sketch: null, edge, face, plane }, 1)?.ref.kind).toBe("edge");
    expect(choosePick({ sketch: null, edge: null, face, plane }, 1)?.ref.kind).toBe("face");
    expect(choosePick({ sketch: null, edge: null, face: null, plane }, 1)?.ref.kind).toBe("plane");
  });

  // The planes are a small marker and content wins: before, a plane in front of a face won.
  it("a face wins over an origin plane, also where the plane lies in front of it; the plane is picked where nothing else is", () => {
    expect(choosePick({ sketch: null, edge: null, face: cand("face", 100), plane: cand("plane", 60) }, 1)?.ref.kind).toBe("face");
    expect(choosePick({ sketch: null, edge: null, profile: cand("profile", 100), face: cand("face", 100), plane: cand("plane", 60) }, 1)?.ref.kind).toBe("profile");
    expect(choosePick({ sketch: null, edge: null, face: null, plane: cand("plane", 60) }, 1)?.ref.kind).toBe("plane");
  });

  it("lines behind a solid are not picked, lines on its surface are", () => {
    const face = cand("face", 100);
    expect(choosePick({ sketch: null, edge: cand("edge", 140), face, plane: null }, 1)?.ref.kind).toBe("face");
    expect(choosePick({ sketch: null, edge: cand("edge", 100.5), face, plane: null }, 1)?.ref.kind).toBe("edge");
  });

  it("faces that may not be picked still hide the lines behind them", () => {
    expect(choosePick({ sketch: null, edge: cand("edge", 140), face: null, plane: null }, 1, 100)).toBeNull();
  });

  it("nothing under the pointer gives nothing", () => {
    expect(choosePick({ sketch: null, edge: null, face: null, plane: null }, 1)).toBeNull();
  });
});
