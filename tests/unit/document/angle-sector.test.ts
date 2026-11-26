// Which of the four angles between two lines is measured, and the segment a distance dimension measures.
import { describe, expect, it } from "vitest";
import { angleSectorAt, linesParallel } from "../../../app/src/document/angle-sector.ts";
import { angleRays, geometryOf, labelPlacement, labelPosition, measuredSegment } from "../../../app/src/document/dimension-label.ts";
import type { SketchData } from "../../../app/src/document/types.ts";

/** The corner at p1 of a rectangle drawn p1 -> p2 -> p3 -> p4: l1 runs east, l4 (p4 -> p1) runs south. */
const rect: Pick<SketchData, "points" | "lines" | "circles"> = {
  points: [
    { id: "p1", x: 0, y: 0 },
    { id: "p2", x: 40, y: 0 },
    { id: "p3", x: 40, y: 30 },
    { id: "p4", x: 0, y: 30 },
    { id: "pa", x: 0, y: 60 },
    { id: "pb", x: 40, y: 60 },
    { id: "o1", x: 20, y: 15 },
    { id: "o2", x: 60, y: 15 },
    { id: "o3", x: 22, y: 15 },
  ],
  lines: [
    { id: "l1", p1: "p1", p2: "p2", construction: false },
    { id: "l2", p1: "p2", p2: "p3", construction: false },
    { id: "l3", p1: "p3", p2: "p4", construction: false },
    { id: "l4", p1: "p4", p2: "p1", construction: false },
    { id: "l5", p1: "pa", p2: "pb", construction: false },
  ],
  circles: [
    { id: "c1", center: "o1", radius: 4, construction: false },
    { id: "c2", center: "o2", radius: 3, construction: false },
    { id: "c3", center: "o3", radius: 8, construction: false },
  ],
};
const g = geometryOf(rect);

describe("the sector of an angle between two lines", () => {
  it("a rectangle corner is 90 degrees whichever of the four sectors the label is in, in every pair of lines", () => {
    for (const [a, b] of [["l1", "l4"], ["l4", "l1"], ["l1", "l2"], ["l2", "l3"], ["l3", "l4"]] as const) {
      for (const at of [[6, 6], [-6, 6], [-6, -6], [6, -6], [46, 36], [34, 24]] as const) {
        const sector = angleSectorAt([a, b], at, g)!;
        expect(Math.round(sector.degrees * 1e6) / 1e6, `${a}/${b} at ${at.join(", ")}`).toBe(90);
      }
    }
  });

  it("names the rays so the angle runs counter-clockwise from the first to the second", () => {
    // l1 east, l4 south: the label inside the rectangle (north-east of the corner) wants east and the ray of l4 turned round (north).
    expect(angleSectorAt(["l1", "l4"], [5, 5], g)).toEqual({ refs: ["l1", "l4"], reverse: [false, true], degrees: 90 });
    // The opposite sector: west and south.
    expect(angleSectorAt(["l1", "l4"], [-5, -5], g)).toEqual({ refs: ["l1", "l4"], reverse: [true, false], degrees: 90 });
    // The sector between north and west (label up-left): counter-clockwise from north to west, so the lines swap places.
    const nw = angleSectorAt(["l1", "l4"], [-5, 5], g)!;
    expect(nw.refs).toEqual(["l4", "l1"]);
    expect(nw.reverse).toEqual([true, true]);
    // Down-right: south to east is counter-clockwise from l4 (south, as it runs) to l1 (east).
    const se = angleSectorAt(["l1", "l4"], [5, -5], g)!;
    expect(se.refs).toEqual(["l4", "l1"]);
    expect(se.reverse).toEqual([false, false]);
  });

  it("an acute and an obtuse sector of two lines that are not square: the label decides", () => {
    // l1 east and a line from (0,0) at 53.13 degrees: a diagonal.
    const diagonal = geometryOf({
      points: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 10, y: 0 }, { id: "c", x: 3, y: 4 }],
      lines: [{ id: "m1", p1: "a", p2: "b", construction: false }, { id: "m2", p1: "a", p2: "c", construction: false }],
      circles: [],
    });
    const acute = Math.atan2(4, 3) * (180 / Math.PI);
    expect(angleSectorAt(["m1", "m2"], [8, 1], diagonal)!.degrees).toBeCloseTo(acute, 9); // between the lines, near the x axis
    expect(angleSectorAt(["m1", "m2"], [-8, 1], diagonal)!.degrees).toBeCloseTo(180 - acute, 9);
    expect(angleSectorAt(["m1", "m2"], [8, -1], diagonal)!.degrees).toBeCloseTo(180 - acute, 9);
    expect(angleSectorAt(["m1", "m2"], [-8, -1], diagonal)!.degrees).toBeCloseTo(acute, 9);
  });

  it("the sector is a property of the lines: it holds after both lines are moved or turned, and the rays name the same corner", () => {
    const at = [5, 5] as const;
    const sector = angleSectorAt(["l1", "l4"], at, g)!;
    // The same corner turned by 30 degrees about the origin: the rays of the stored flags are still east-ish and north-ish.
    const t = (30 * Math.PI) / 180;
    const turn = (x: number, y: number) => ({ x: x * Math.cos(t) - y * Math.sin(t), y: x * Math.sin(t) + y * Math.cos(t) });
    const turned = geometryOf({
      points: rect.points.map((p) => ({ id: p.id, ...turn(p.x, p.y) })),
      lines: rect.lines,
      circles: [],
    });
    const rays = angleRays(sector.refs, sector.reverse, turned)!;
    expect(rays.sweep).toBeCloseTo(Math.PI / 2, 9);
    expect(rays.start).toBeCloseTo(t, 9); // the first ray still points along the turned l1
    // A label stored with the rays follows the corner.
    const stored = labelPlacement("angle", sector.refs, { x: at[0], y: at[1] }, g, sector.reverse);
    const moved = labelPosition("angle", sector.refs, stored, turned, sector.reverse)!;
    const expected = turn(at[0], at[1]);
    expect(moved.x).toBeCloseTo(expected.x, 9);
    expect(moved.y).toBeCloseTo(expected.y, 9);
  });

  it("parallel lines have no sector: they are measured by their distance", () => {
    expect(linesParallel(["l1", "l5"], g)).toBe(true);
    expect(linesParallel(["l1", "l3"], g)).toBe(true);
    expect(linesParallel(["l1", "l4"], g)).toBe(false);
    expect(angleSectorAt(["l1", "l5"], [20, 30], g)).toBeNull();
    expect(angleSectorAt(["l1", "gone"], [20, 30], g)).toBeNull();
  });

  it("a label at the crossing itself and one on a line still belong to a sector", () => {
    expect(angleSectorAt(["l1", "l4"], [0, 0], g)!.degrees).toBe(90);
    expect(angleSectorAt(["l1", "l4"], [10, 0], g)!.degrees).toBe(90);
  });
});

describe("the segment a distance dimension measures", () => {
  const length = (refs: string[]) => {
    const s = measuredSegment(refs, g)!;
    return Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
  };

  it("one line is its length, two points the distance", () => {
    expect(length(["l2"])).toBe(30);
    expect(length(["p1", "p3"])).toBe(50);
  });

  it("a point and a line: the perpendicular, to the foot on the infinite line, whichever way they are named", () => {
    expect(length(["p3", "l1"])).toBe(30);
    expect(length(["l1", "p3"])).toBe(30);
    const s = measuredSegment(["p3", "l1"], g)!;
    expect(s.b).toEqual([40, 0]);
    // Beyond the end of the line: the infinite line is measured.
    expect(measuredSegment(["pb", "l1"], g)!.b).toEqual([40, 0]);
  });

  it("two parallel lines: from the middle of the first to its foot on the second", () => {
    const s = measuredSegment(["l1", "l5"], g)!;
    expect(s.a).toEqual([20, 0]);
    expect(s.b).toEqual([20, 60]);
  });

  it("a point and a circle: to the nearest point of the rim, which is the distance to the centre minus the radius", () => {
    expect(length(["p3", "c1"])).toBeCloseTo(Math.hypot(20, 15) - 4, 9);
    expect(length(["c1", "p3"])).toBeCloseTo(Math.hypot(20, 15) - 4, 9);
    const s = measuredSegment(["p3", "c1"], g)!;
    expect(Math.hypot(s.b[0] - 20, s.b[1] - 15)).toBeCloseTo(4, 9);
  });

  it("a circle and a line: the point of the rim that faces the line, to the foot of the centre", () => {
    expect(length(["c1", "l1"])).toBe(15 - 4);
    const s = measuredSegment(["l1", "c1"], g)!;
    expect(s.a).toEqual([20, 11]);
    expect(s.b).toEqual([20, 0]);
  });

  it("two circles: the rims that face each other, outside each other or one inside the other", () => {
    expect(length(["c1", "c2"])).toBe(40 - 4 - 3);
    expect(measuredSegment(["c1", "c2"], g)!.crossing).toBeUndefined();
    // c3 (radius 8, centre 22/15) holds c1 (radius 4, centre 20/15, 2 mm off): the room is 8 - 4 - 2 = 2 at the side c1 leans to.
    const inner = measuredSegment(["c1", "c3"], g)!;
    expect(Math.hypot(inner.b[0] - inner.a[0], inner.b[1] - inner.a[1])).toBeCloseTo(2, 9);
    expect(inner.crossing).toBeUndefined();
  });

  it("circles that cross have no gap; things without a direction give nothing", () => {
    const crossing = geometryOf({
      points: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 5, y: 0 }],
      lines: [],
      circles: [{ id: "x", center: "a", radius: 4, construction: false }, { id: "y", center: "b", radius: 4, construction: false }],
    });
    expect(measuredSegment(["x", "y"], crossing)!.crossing).toBe(true);
    // A point on the infinite line has a zero perpendicular, but it still has a (zero length) segment: the foot is the point itself.
    expect(measuredSegment(["p1", "l1"], g)).toEqual({ a: [0, 0], b: [0, 0] });
    // A point at the centre of a circle has no nearest rim point.
    expect(measuredSegment(["o1", "c1"], g)).toBeNull();
    expect(measuredSegment(["nope", "c1"], g)).toBeNull();
    expect(measuredSegment(["p1", "p2", "p3"], g)).toBeNull();
  });

  it("the label of every form keeps its place relative to the measured segment", () => {
    const refs = ["c1", "l1"];
    const stored = labelPlacement("distance", refs, { x: 30, y: 6 }, g);
    const moved = geometryOf({ points: rect.points.map((p) => ({ ...p, x: p.x + 100, y: p.y - 20 })), lines: rect.lines, circles: rect.circles });
    const at = labelPosition("distance", refs, stored, moved)!;
    expect(at.x).toBeCloseTo(130, 9);
    expect(at.y).toBeCloseTo(-14, 9);
  });
});
