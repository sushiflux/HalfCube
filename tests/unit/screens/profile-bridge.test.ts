import { describe, expect, it } from "vitest";
import type { ProfileView } from "../../../app/src/model/index.ts";
import {
  entityOf,
  expandTriangles,
  extrudeHandle,
  handleToDistance,
  offeredProfiles,
  outlineOf,
  profileCentre,
  profileData,
  profileRefOf,
  viewFrame,
} from "../../../app/src/screens/main/profile-bridge.ts";
import type { CatalogueEntry } from "../../../app/src/screens/main/profile-catalogue.ts";

// A 40 x 20 rectangle at (10, 5) in the sketch plane, as two triangles.
const rectangle: ProfileView = {
  key: "l1,l2,l3,l4",
  outer: ["l1", "l2", "l3", "l4"],
  holes: [],
  area: 800,
  determined: true,
  loopsDetermined: [true],
  fill: {
    positions: new Float32Array([10, 5, 50, 5, 50, 25, 10, 25]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  },
  loops: [new Float32Array([10, 5, 50, 5, 50, 25, 10, 25])],
};

// The front plane: u along +X, v along +Z, normal -Y (origin planes of the document).
const frontFrame = { origin: { x: 0, y: 0, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 }, normal: { x: 0, y: -1, z: 0 } };
const entry: CatalogueEntry = { sketchId: "f1", name: "Skizze1", frame: frontFrame, profiles: [rectangle] };

describe("what the 3D view gets", () => {
  it("takes the engine's frame as origin and two axes", () => {
    expect(viewFrame(frontFrame)).toEqual({ origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 0, 1] });
  });

  it("writes the triangles without an index buffer: u v for every vertex of every triangle", () => {
    expect(Array.from(expandTriangles(rectangle.fill))).toEqual([10, 5, 50, 5, 50, 25, 10, 5, 50, 25, 10, 25]);
  });

  it("gives the outline per loop as (u, v) points", () => {
    expect(outlineOf(rectangle.loops)).toEqual([
      [
        [10, 5],
        [50, 5],
        [50, 25],
        [10, 25],
      ],
    ]);
  });

  it("names an area by its sketch and the engine's key, and reads it back from a pick", () => {
    const data = profileData(entry, rectangle);
    expect(data).toMatchObject({ sketchId: "f1", regionId: "l1,l2,l3,l4" });
    expect(data.triangles).toHaveLength(12);
    const ref = { sketchId: "f1", regionId: "l1,l2,l3,l4" };
    expect(entityOf(ref)).toEqual({ kind: "profile", sketchId: "f1", regionId: "l1,l2,l3,l4" });
    expect(profileRefOf(entityOf(ref))).toEqual(ref);
    expect(profileRefOf({ kind: "plane", plane: "xy" })).toBeNull();
  });

  it("offers the areas of all sketches, or only those of the sketch of an existing step", () => {
    const other: CatalogueEntry = { ...entry, sketchId: "f5", name: "Skizze2" };
    expect(offeredProfiles([entry, other], null).map((p) => p.sketchId)).toEqual(["f1", "f5"]);
    expect(offeredProfiles([entry, other], "f5").map((p) => p.sketchId)).toEqual(["f5"]);
  });
});

describe("the drag arrow", () => {
  it("starts in the middle of the area on the plane and runs along its normal", () => {
    expect(profileCentre(rectangle)).toEqual([30, 15]);
    const h = extrudeHandle(entry, rectangle, 12, false);
    expect(h.origin).toEqual([30, 0, 15]);
    expect(h.direction).toEqual([0, -1, 0]);
    expect(h.distance).toBe(12);
  });

  it("shows a negative distance as a negative length (the other side)", () => {
    expect(extrudeHandle(entry, rectangle, -7, false).distance).toBe(-7);
  });

  it("symmetric: the arrow shows half of the total, and a drag of it is doubled back to the total", () => {
    expect(extrudeHandle(entry, rectangle, 20, true).distance).toBe(10);
    expect(handleToDistance(6, true)).toBe(12);
    expect(handleToDistance(-6, false)).toBe(-6);
  });
});
