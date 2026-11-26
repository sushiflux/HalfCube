import { describe, expect, it } from "vitest";
import type { SketchFeature } from "../../../app/src/document/types.ts";
import type { BodyView } from "../../../app/src/model/index.ts";
import { bodyData, entityNumber, featureSketchData } from "../../../app/src/screens/main/view-bridge.ts";

describe("entityNumber", () => {
  it("is the number in the engine id", () => {
    expect(entityNumber("l6")).toBe(6);
    expect(entityNumber("c112")).toBe(112);
    expect(entityNumber("@origin")).toBe(-1);
  });
});

describe("featureSketchData", () => {
  it("draws a finished sketch neutral on the origin plane's own frame, never as under- or fully constrained", () => {
    const feature: SketchFeature = {
      id: "f3",
      type: "sketch",
      name: "Skizze2",
      component: "root",
      visible: true,
      plane: { kind: "originPlane", plane: "yz" },
      sketch: {
        points: [
          { id: "p2", x: 0, y: 0 },
          { id: "p3", x: 10, y: 0 },
        ],
        lines: [
          { id: "l4", p1: "p2", p2: "p3", construction: false },
          { id: "l5", p1: "p2", p2: "p3", construction: true },
        ],
        circles: [{ id: "c6", center: "p2", radius: 4, construction: false }],
        constraints: [],
      },
    };
    const data = featureSketchData(feature);
    expect(data.plane).toEqual({ origin: [0, 0, 0], xAxis: [0, 1, 0], yAxis: [0, 0, 1] });
    expect(data.entities.map((e) => e.kind)).toEqual(["bodyEdge", "construction", "bodyEdge"]);
  });
});

describe("bodyData", () => {
  it("hands the typed arrays over without copying and turns the edge list into offsets", () => {
    const body = {
      id: "b1",
      edges: [
        { name: "e1", pointStart: 0, pointCount: 3 },
        { name: "e2", pointStart: 3, pointCount: 2 },
      ],
      mesh: {
        positions: new Float32Array(9),
        normals: new Float32Array(9),
        indices: new Uint32Array([0, 1, 2]),
        triangleFace: new Uint32Array([0]),
        edgePoints: new Float32Array(15),
      },
    } as unknown as BodyView;
    const data = bodyData(body);
    expect(data.positions).toBe(body.mesh.positions);
    expect(data.faceIds).toBe(body.mesh.triangleFace);
    expect(Array.from(data.edges?.offsets ?? [])).toEqual([0, 3, 5]);
    expect(Array.from(data.edges?.ids ?? [])).toEqual([0, 1]);
  });

  it("has no edges entry for a body without edges", () => {
    const empty = { positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0), triangleFace: new Uint32Array(0), edgePoints: new Float32Array(0) };
    const body = { id: "b2", edges: [], mesh: empty } as unknown as BodyView;
    expect(bodyData(body).edges).toBeUndefined();
  });
});
