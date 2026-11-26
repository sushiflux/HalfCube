// Dimension labels are stored relative to the measured geometry (document/dimension-label.ts): the absolute point comes
// back exactly, and it travels with the geometry when that moves, turns or changes its size.
import { describe, expect, it } from "vitest";
import { absoluteLabelsToRelative } from "../../../app/src/document/migrate.ts";
import { geometryOf, labelPlacement, labelPosition } from "../../../app/src/document/dimension-label.ts";
import type { Dimension, SketchData, Vec2 } from "../../../app/src/document/types.ts";
import { documentProblems } from "../../../app/src/document/validate.ts";
import { document } from "../../fixtures/engine/cases.ts";

const mm = (value: number) => ({ value, unit: "mm" as const });
/** A label rounded to a number of decimals (no -0), so toEqual compares positions within a tolerance. */
const rounded = (v: Vec2 | null, digits = 9) => (v ? { x: Number(v.x.toFixed(digits)) + 0, y: Number(v.y.toFixed(digits)) + 0 } : null);

/** A sketch of one line p1 to p2, one more line from p1 (for angles) and a circle. */
function sketch(p1: [number, number], p2: [number, number], p3: [number, number] = [p1[0], p1[1] + 10], circle = { c: [100, 50] as [number, number], r: 8 }): SketchData {
  return {
    points: [
      { id: "p1", x: p1[0], y: p1[1] },
      { id: "p2", x: p2[0], y: p2[1] },
      { id: "p3", x: p3[0], y: p3[1] },
      { id: "pc", x: circle.c[0], y: circle.c[1] },
    ],
    lines: [
      { id: "l1", p1: "p1", p2: "p2", construction: false },
      { id: "l2", p1: "p1", p2: "p3", construction: false },
    ],
    circles: [{ id: "c1", center: "pc", radius: circle.r, construction: false }],
    constraints: [],
  };
}

const kinds: { name: string; kind: Dimension["kind"]; refs: string[]; at: Vec2 }[] = [
  { name: "distance of a line", kind: "distance", refs: ["l1"], at: { x: 22, y: 31 } },
  { name: "distance of two points", kind: "distance", refs: ["p1", "p2"], at: { x: 5, y: -4 } },
  { name: "horizontal distance", kind: "distanceX", refs: ["p1", "p2"], at: { x: 33, y: 7 } },
  { name: "vertical distance", kind: "distanceY", refs: ["p1", "p2"], at: { x: -6, y: 17 } },
  { name: "angle between two lines", kind: "angle", refs: ["l1", "l2"], at: { x: 15, y: 8 } },
  { name: "angle against an axis", kind: "angle", refs: ["@axisU", "l1"], at: { x: 15, y: 8 } },
  { name: "diameter", kind: "diameter", refs: ["c1"], at: { x: 120, y: 70 } },
  { name: "radius", kind: "radius", refs: ["c1"], at: { x: 96, y: 52 } },
];

describe("dimension label placement", () => {
  const s = sketch([10, 20], [70, 45]);
  const g = geometryOf(s);

  for (const k of kinds) {
    it(`${k.name}: the point that was set comes back from the stored value`, () => {
      const stored = labelPlacement(k.kind, k.refs, k.at, g);
      expect(rounded(labelPosition(k.kind, k.refs, stored, g), 9)).toEqual(rounded(k.at, 9));
    });
  }

  it("distance: x is a share of the length from the middle, y the mm to the side of the line", () => {
    // A 60 mm line along u: the label 15 mm right of the middle and 8 mm above the line.
    const flat = geometryOf(sketch([0, 0], [60, 0]));
    expect(rounded(labelPlacement("distance", ["p1", "p2"], { x: 45, y: 8 }, flat), 9)).toEqual(rounded({ x: 0.25, y: 8 }, 9));
    expect(rounded(labelPlacement("distance", ["p1", "p2"], { x: 30, y: -6 }, flat), 9)).toEqual(rounded({ x: 0, y: -6 }, 9));
  });

  it("the label follows a translation and a rotation of the geometry (every kind)", () => {
    const moved = sketch([110, -35], [170, -10], [110, -25], { c: [200, -5], r: 8 }); // everything +100 / -55
    const shifted = geometryOf(moved);
    const around = (a: Vec2): Vec2 => ({ x: a.x + 100, y: a.y - 55 });
    // (An angle against an axis is tied to the origin, which does not move with the geometry.)
    for (const k of kinds.filter((x) => !x.refs.includes("@axisU"))) {
      const stored = labelPlacement(k.kind, k.refs, k.at, g);
      expect(rounded(labelPosition(k.kind, k.refs, stored, shifted), 8)).toEqual(rounded(around(k.at), 8));
    }
    // A quarter turn about the origin, (x, y) -> (-y, x): a label measured along the geometry turns with it. (The axis-aligned
    // kinds and the circles are tied to the sketch axes and are not tested for turns.)
    const turn = (p: [number, number]): [number, number] => [-p[1], p[0]];
    const turned = geometryOf(sketch(turn([10, 20]), turn([70, 45]), turn([10, 30]), { c: turn([100, 50]), r: 8 }));
    for (const k of kinds.filter((x) => (x.kind === "distance" || x.kind === "angle") && !x.refs.includes("@axisU"))) {
      const stored = labelPlacement(k.kind, k.refs, k.at, g);
      const [tx, ty] = turn([k.at.x, k.at.y]);
      expect(rounded(labelPosition(k.kind, k.refs, stored, turned), 8)).toEqual(rounded({ x: tx, y: ty }, 8));
    }
  });

  it("a longer line keeps the label at the same share of its length and the same gap", () => {
    const short = geometryOf(sketch([0, 0], [60, 0]));
    const long = geometryOf(sketch([0, 0], [100, 0]));
    const stored = labelPlacement("distance", ["p1", "p2"], { x: 45, y: 8 }, short);
    expect(rounded(labelPosition("distance", ["p1", "p2"], stored, long), 9)).toEqual(rounded({ x: 75, y: 8 }, 9));
    // The same for the horizontal distance and the dimension line's height.
    const storedX = labelPlacement("distanceX", ["p1", "p2"], { x: 45, y: 8 }, short);
    expect(rounded(labelPosition("distanceX", ["p1", "p2"], storedX, long), 9)).toEqual(rounded({ x: 75, y: 8 }, 9));
  });

  it("a bigger circle takes its label along in proportion; the angle label stays on its side of the arc", () => {
    const small = geometryOf(sketch([0, 0], [10, 0], [0, 10], { c: [0, 0], r: 5 }));
    const big = geometryOf(sketch([0, 0], [10, 0], [0, 10], { c: [0, 0], r: 20 }));
    const stored = labelPlacement("diameter", ["c1"], { x: 5, y: 5 }, small);
    expect(rounded(labelPosition("diameter", ["c1"], stored, big), 9)).toEqual(rounded({ x: 20, y: 20 }, 9));
    // 45 degrees between the lines along u and v: the label on the bisector stays between them when the second line turns.
    const right = geometryOf(sketch([0, 0], [10, 0], [0, 10]));
    const wider = geometryOf(sketch([0, 0], [10, 0], [-10, 10]));
    const angle = labelPlacement("angle", ["l1", "l2"], { x: 5, y: 5 }, right);
    expect(rounded(angle, 9)).toEqual(rounded({ x: 0.5, y: Math.hypot(5, 5) }, 9));
    const p = labelPosition("angle", ["l1", "l2"], angle, wider)!;
    expect(Math.atan2(p.y, p.x)).toBeCloseTo((3 * Math.PI) / 8, 9); // half of the 135 degrees swept
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(Math.hypot(5, 5), 9);
  });

  it("a measured length of 0 stores a 0 share instead of dividing by it", () => {
    const point = geometryOf(sketch([5, 5], [5, 5]));
    for (const kind of ["distance", "distanceX", "distanceY"] as const) {
      const stored = labelPlacement(kind, ["p1", "p2"], { x: 9, y: 11 }, point);
      expect(Number.isFinite(stored.x) && Number.isFinite(stored.y)).toBe(true);
      expect(stored.x).toBe(0);
      const back = labelPosition(kind, ["p1", "p2"], stored, point)!;
      expect(Number.isFinite(back.x) && Number.isFinite(back.y)).toBe(true);
    }
  });

  it("references that do not resolve give no position and a harmless stored value", () => {
    expect(labelPosition("distance", ["nope"], { x: 1, y: 1 }, g)).toBeNull();
    expect(labelPosition("angle", ["l1", "gone"], { x: 1, y: 1 }, g)).toBeNull();
    expect(labelPosition("radius", ["p1"], { x: 1, y: 1 }, g)).toBeNull();
    expect(labelPlacement("distance", ["nope"], { x: 50, y: 60 }, g)).toEqual({ x: 0, y: 0 });
    expect(labelPlacement("radius", ["nope"], { x: 50, y: 60 }, g)).toEqual({ x: 0, y: 0 });
  });
});

describe("conversion of a document with absolute labels", () => {
  it("rewrites every dimension label of every sketch and leaves the rest alone", () => {
    const base = sketch([0, 0], [60, 0]);
    const old: SketchData = {
      ...base,
      constraints: [
        { id: "k1", kind: "horizontal", refs: ["l1"] },
        { id: "d1", kind: "distance", refs: ["l1"], value: mm(60), driving: true, label: { x: 45, y: 8 } },
        { id: "d2", kind: "radius", refs: ["c1"], value: mm(8), driving: true, label: { x: 104, y: 54 } },
      ],
    };
    const doc = document(old);
    const converted = absoluteLabelsToRelative(doc);
    const out = converted.timeline.find((f) => f.type === "sketch");
    expect(out && out.type === "sketch" && out.sketch.constraints[0]).toEqual({ id: "k1", kind: "horizontal", refs: ["l1"] });
    const labels = out && out.type === "sketch" ? out.sketch.constraints.filter((c): c is Dimension => "driving" in c).map((c) => c.label) : [];
    expect(rounded(labels[0] ?? null, 9)).toEqual(rounded({ x: 0.25, y: 8 }, 9));
    expect(rounded(labels[1] ?? null, 9)).toEqual(rounded({ x: 0.5, y: 0.5 }, 9));
    expect(documentProblems(converted)).toEqual([]);
    expect(doc).not.toBe(converted); // the input document is not changed
    const first = doc.timeline[0];
    expect(rounded(first?.type === "sketch" ? (first.sketch.constraints[1] as Dimension).label : null)).toEqual({ x: 45, y: 8 });
  });
});
