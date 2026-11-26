import { describe, expect, it } from "vitest";
import { DEFAULT_FOV_Y, screenRay, worldToScreen, type Lens, type ViewState } from "../../../app/src/viewport/camera.ts";
import type { Vec3 } from "../../../app/src/viewport/math.ts";
import { choosePick, type PickCandidate } from "../../../app/src/viewport/picking.ts";
import { flattenTriangles, outlineSegments, pointInTriangles, profileArea, profileBounds, profileWorldPositions, rayProfile, validateProfile } from "../../../app/src/viewport/profiles.ts";
import { allPickKinds, refKey, refsEqual, type PlaneFrame, type ProfileData } from "../../../app/src/viewport/types.ts";

const lens: Lens = { fovY: DEFAULT_FOV_Y, width: 1000, height: 600 };
const view: ViewState = { target: [0, 0, 0], azimuth: Math.PI / 4, elevation: 0.6, distance: 220 };
const xy: PlaneFrame = { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] };
const raised: PlaneFrame = { origin: [0, 0, 40], xAxis: [1, 0, 0], yAxis: [0, 1, 0] };

/** A square frame 40 x 40 with a square hole 20 x 20 in the middle, as eight triangles (the engine cuts the hole out). */
function frame(): Float32Array {
  const o = [[-20, -20], [20, -20], [20, 20], [-20, 20]] as const;
  const i = [[-10, -10], [10, -10], [10, 10], [-10, 10]] as const;
  const t: number[] = [];
  for (let k = 0; k < 4; k++) {
    const a = o[k]!, b = o[(k + 1) % 4]!, c = i[(k + 1) % 4]!, d = i[k]!;
    t.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return Float32Array.from(t);
}

const profile = (regionId: string, plane: PlaneFrame, triangles: Float32Array): ProfileData => ({ sketchId: "s1", regionId, plane, triangles });

describe("the profile as a pick target", () => {
  it("the references of two regions differ, equal ones are equal, and the key names sketch and region", () => {
    const a = { kind: "profile", sketchId: "s1", regionId: "l1,l2,l3,l4" } as const;
    const b = { kind: "profile", sketchId: "s1", regionId: "l1,l2,l3,l4|c9" } as const;
    expect(refKey(a)).toBe("profile:s1:l1,l2,l3,l4");
    expect(refsEqual(a, { ...a })).toBe(true);
    expect(refsEqual(a, b)).toBe(false);
    expect(refsEqual(a, { kind: "face", bodyId: "s1", faceId: 1 })).toBe(false);
  });

  it("is one of the pick kinds, ahead of faces and planes", () => {
    expect(allPickKinds).toContain("profile");
    expect(allPickKinds.indexOf("profile")).toBeGreaterThan(allPickKinds.indexOf("edge"));
    expect(allPickKinds.indexOf("profile")).toBeLessThan(allPickKinds.indexOf("face"));
    expect(allPickKinds.indexOf("profile")).toBeLessThan(allPickKinds.indexOf("plane"));
  });
});

describe("the fill on its plane", () => {
  it("maps sketch coordinates to the world through the plane's axes and origin", () => {
    const tri = Float32Array.from([0, 0, 10, 0, 0, 5]);
    const world = profileWorldPositions({ origin: [100, 0, 0], xAxis: [0, 1, 0], yAxis: [0, 0, 1] }, tri);
    expect([...world]).toEqual([100, 0, 0, 100, 10, 0, 100, 0, 5]);
    expect(profileBounds(raised, tri).max).toEqual([10, 5, 40]);
  });

  it("adds up the area of the triangles", () => {
    expect(profileArea(frame())).toBeCloseTo(40 * 40 - 20 * 20, 4);
  });

  it("flattens an indexed mesh into the list of triangles a profile carries", () => {
    const flat = flattenTriangles([0, 0, 4, 0, 4, 3], [0, 1, 2, 0, 2, 1]);
    expect([...flat]).toEqual([0, 0, 4, 0, 4, 3, 0, 0, 4, 3, 4, 0]);
  });

  it("refuses sizes that are not whole triangles and numbers that are not finite", () => {
    expect(validateProfile(profile("r", xy, new Float32Array(7)))).toMatch(/multiple of 6/);
    expect(validateProfile(profile("r", xy, Float32Array.from([0, 0, 1, 0, 0, Number.NaN])))).toMatch(/not a finite number/);
    expect(validateProfile(profile("r", xy, frame()))).toBeNull();
  });
});

describe("the outline", () => {
  it("is the boundary of the fill: the outer edges and the hole's edges, not the inner diagonals", () => {
    const segments = outlineSegments(xy, frame());
    // 4 outer edges + 4 hole edges, each outer/hole edge is one triangle edge here.
    expect(segments.length / 6).toBe(8);
    let length = 0;
    for (let s = 0; s < 8; s++) length += Math.hypot(segments[s * 6 + 3]! - segments[s * 6]!, segments[s * 6 + 4]! - segments[s * 6 + 1]!);
    expect(length).toBeCloseTo(4 * 40 + 4 * 20, 3);
  });

  it("uses the loops the host gives, each closed, in the plane", () => {
    const segments = outlineSegments(raised, frame(), [[[0, 0], [10, 0], [10, 10]]]);
    expect(segments.length / 6).toBe(3);
    expect(segments[2]).toBe(40);
    // the third segment closes the loop back to the first point
    expect([segments[12], segments[13], segments[15], segments[16]]).toEqual([10, 10, 0, 0]);
  });
});

describe("the ray against a profile", () => {
  it("hits the frame, misses the hole and the outside, from either side", () => {
    const tri = frame();
    const hit = rayProfile({ origin: [15, 0, 50], dir: [0, 0, -1] }, xy, tri)!;
    expect(hit.t).toBeCloseTo(50, 9);
    expect(hit.point).toEqual([15, 0, 0]);
    expect(rayProfile({ origin: [0, 0, 50], dir: [0, 0, -1] }, xy, tri)).toBeNull(); // the hole
    expect(rayProfile({ origin: [30, 0, 50], dir: [0, 0, -1] }, xy, tri)).toBeNull(); // outside
    expect(rayProfile({ origin: [15, 0, -50], dir: [0, 0, 1] }, xy, tri)).not.toBeNull(); // from below
  });

  it("a sliver without area is no target", () => {
    const sliver = Float32Array.from([0, 0, 10, 0, 20, 0]);
    expect(pointInTriangles(sliver, 5, 5)).toBe(false);
    expect(pointInTriangles(sliver, 25, 0)).toBe(false);
  });

  it("the pointer over the drawn fill finds the region, at an oblique angle too", () => {
    const tri = frame();
    const p: Vec3 = [-15, 12, 40];
    const s = worldToScreen(view, lens, p)!;
    const hit = rayProfile(screenRay(view, lens, s.x, s.y), raised, tri)!;
    expect(hit.point[0]).toBeCloseTo(-15, 4);
    expect(hit.point[1]).toBeCloseTo(12, 4);
    const holeScreen = worldToScreen(view, lens, [0, 0, 40])!;
    expect(rayProfile(screenRay(view, lens, holeScreen.x, holeScreen.y), raised, tri)).toBeNull();
  });
});

describe("the pick order with profiles", () => {
  const candidate = (kind: "face" | "plane" | "profile" | "edge", depth: number): PickCandidate => ({
    ref: kind === "face" ? { kind, bodyId: "b", faceId: 1 } : kind === "plane" ? { kind, plane: "xy" } : kind === "edge" ? { kind, bodyId: "b", edgeId: 2 } : { kind, sketchId: "s1", regionId: "r" },
    point: [0, 0, 0],
    depth,
    distancePx: kind === "edge" ? 2 : 0,
  });

  it("a profile on a face wins over the face (same depth)", () => {
    const chosen = choosePick({ sketch: null, edge: null, profile: candidate("profile", 100), face: candidate("face", 100), plane: null }, 0.2);
    expect(chosen?.ref.kind).toBe("profile");
  });

  it("a profile wins over a face and an origin plane that lie further back", () => {
    const chosen = choosePick({ sketch: null, edge: null, profile: candidate("profile", 90), face: candidate("face", 120), plane: candidate("plane", 130) }, 0.2);
    expect(chosen?.ref.kind).toBe("profile");
  });

  it("a profile behind a solid is hidden by it: the face in front is picked", () => {
    const chosen = choosePick({ sketch: null, edge: null, profile: candidate("profile", 150), face: candidate("face", 100), plane: null }, 0.2, 100);
    expect(chosen?.ref.kind).toBe("face");
  });

  it("a profile is picked over a face when faces are in front only by float noise", () => {
    const chosen = choosePick({ sketch: null, edge: null, profile: candidate("profile", 100.05), face: candidate("face", 100), plane: null }, 0.2, 100);
    expect(chosen?.ref.kind).toBe("profile");
  });

  it("a line still wins over a profile", () => {
    const chosen = choosePick({ sketch: null, edge: candidate("edge", 100), profile: candidate("profile", 100), face: candidate("face", 100), plane: null }, 0.2);
    expect(chosen?.ref.kind).toBe("edge");
  });

  it("without a profile candidate the order stands: a face before a plane, even where the plane lies in front (planes are small markers)", () => {
    expect(choosePick({ sketch: null, edge: null, face: candidate("face", 100), plane: null }, 0.2)?.ref.kind).toBe("face");
    expect(choosePick({ sketch: null, edge: null, face: candidate("face", 100), plane: candidate("plane", 50) }, 0.2)?.ref.kind).toBe("face");
  });
});
