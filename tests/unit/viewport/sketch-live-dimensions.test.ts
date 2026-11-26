// The measuring graphics of the values of a shape being drawn: the same lines and arrowheads as a finished dimension,
// built from a plain description, sized in pixels so they look the same at every zoom.
import { describe, expect, it } from "vitest";
import { ARROW_LENGTH_PX, LIVE_LABEL_HALF_H_PX, LIVE_LABEL_HALF_W_PX, arrowTriangle, liveDimensionGraphic, liveLabelReach } from "../../../app/src/viewport/sketch/dimensions.ts";
import type { LiveDimension } from "../../../app/src/viewport/sketch/types.ts";

const mm = 0.1; // 10 px per mm
const px = (v: number) => v * mm;

describe("live length (linear)", () => {
  const dim = (b: [number, number], offsetPx = 32): LiveDimension => ({ shape: "linear", a: [0, 0], b, n: [0, -1], offsetPx });

  it("runs the dimension line the given pixels away from the edge, with extension lines and an arrowhead at each end", () => {
    const g = liveDimensionGraphic("width", dim([60, 0]), mm, false);
    const line = g.segments.at(-1)!;
    expect(line[0][1]).toBeCloseTo(-px(32), 9);
    expect(line[1][1]).toBeCloseTo(-px(32), 9);
    expect(line[0][0]).toBeCloseTo(0, 9);
    expect(line[1][0]).toBeCloseTo(60, 9);
    expect(g.segments).toHaveLength(3); // two extension lines and the dimension line
    expect(g.arrows).toHaveLength(2);
    expect(g.driving).toBe(true);
    // Arrowheads on the inside: the body of each points to the other end.
    expect(g.arrows[0]!.back[0]).toBeCloseTo(1, 9);
    expect(g.arrows[1]!.back[0]).toBeCloseTo(-1, 9);
  });

  it("the value sits in the middle of a line that has room, and beside its end when it is short", () => {
    const long = liveDimensionGraphic("w", dim([60, 0]), mm, false);
    expect(long.label[0]).toBeCloseTo(30, 9);
    expect(long.label[1]).toBeCloseTo(-px(32), 9);
    // 6 mm are 60 px on the screen: less than the text (half of its width on each side) and two arrowheads need.
    expect(60).toBeLessThan(2 * LIVE_LABEL_HALF_W_PX + 2 * ARROW_LENGTH_PX + 8);
    const short = liveDimensionGraphic("w", dim([6, 0]), mm, false);
    expect(short.label[0]).toBeGreaterThan(6);
    expect(short.label[0]).toBeCloseTo(6 + px(14 + LIVE_LABEL_HALF_W_PX), 9);
    // The arrowheads then stand outside, pointing at the extension lines.
    expect(short.arrows[0]!.back[0]).toBeCloseTo(-1, 9);
    expect(short.arrows[1]!.back[0]).toBeCloseTo(1, 9);
  });

  it("on a vertical line the text needs only half its height, so a short vertical line still carries its value", () => {
    expect(liveLabelReach([1, 0])).toBe(LIVE_LABEL_HALF_W_PX);
    expect(liveLabelReach([0, 1])).toBe(LIVE_LABEL_HALF_H_PX);
    const vertical: LiveDimension = { shape: "linear", a: [0, 0], b: [0, 8], n: [1, 0], offsetPx: 72 }; // 80 px long
    const g = liveDimensionGraphic("h", vertical, mm, false);
    expect(g.label[1]).toBeCloseTo(4, 9); // in the middle
    expect(g.label[0]).toBeCloseTo(px(72), 9);
    // 30 px is too short even for that: the value stands beside the end.
    const tiny = liveDimensionGraphic("h", { ...vertical, b: [0, 3] }, mm, false);
    expect(tiny.label[1]).toBeCloseTo(3 + px(14 + LIVE_LABEL_HALF_H_PX), 9);
  });

  it("the distance from the edge in pixels is the same at every zoom", () => {
    const near = liveDimensionGraphic("w", dim([60, 0]), 0.1, false);
    const far = liveDimensionGraphic("w", dim([60, 0]), 0.5, false);
    expect(Math.abs(near.label[1]) / 0.1).toBeCloseTo(32, 9);
    expect(Math.abs(far.label[1]) / 0.5).toBeCloseTo(32, 9);
  });

  it("a rectangle that has no size yet has a place for the value but nothing to draw", () => {
    const g = liveDimensionGraphic("w", dim([0, 0]), mm, false);
    expect(g.segments).toEqual([]);
    expect(g.arrows).toEqual([]);
    expect(Number.isFinite(g.label[0]) && Number.isFinite(g.label[1])).toBe(true);
  });

  it("arrowheads have the size of the arrowheads of a finished dimension", () => {
    const g = liveDimensionGraphic("w", dim([60, 0]), mm, false);
    const t = arrowTriangle(g.arrows[0]!, mm);
    const len = Math.hypot(((t[1][0] + t[2][0]) / 2) - t[0][0], ((t[1][1] + t[2][1]) / 2) - t[0][1]);
    expect(len).toBeCloseTo(px(ARROW_LENGTH_PX), 9);
  });
});

describe("live angle", () => {
  const angle: LiveDimension = { shape: "angle", vertex: [10, 10], start: 0, sweep: Math.PI / 2, radiusPx: 80, reach: [0, 30] };

  it("an arc around the vertex from the horizontal to the line, with an arrowhead at each end and the value beyond it", () => {
    const g = liveDimensionGraphic("angle", angle, mm, false);
    const arcPoints = g.segments.filter((s) => Math.abs(Math.hypot(s[0][0] - 10, s[0][1] - 10) - px(80)) < 1e-9);
    expect(arcPoints.length).toBeGreaterThan(8);
    expect(g.arrows).toHaveLength(2);
    // The value lies on the bisector, outside the arc.
    const r = Math.hypot(g.label[0] - 10, g.label[1] - 10);
    expect(r).toBeGreaterThan(px(80));
    expect(Math.atan2(g.label[1] - 10, g.label[0] - 10)).toBeCloseTo(Math.PI / 4, 9);
  });

  it("the horizontal reference ray reaches the arc (nothing is drawn there yet); the line itself is longer and needs no extension", () => {
    const g = liveDimensionGraphic("angle", angle, mm, false);
    const rays = g.segments.filter((s) => Math.abs(s[0][1] - 10) < 1e-9 && Math.abs(s[1][1] - 10) < 1e-9);
    expect(rays).toHaveLength(1);
    expect(rays[0]![1][0]).toBeGreaterThan(10 + px(80));
    const vertical = g.segments.filter((s) => Math.abs(s[0][0] - 10) < 1e-9 && Math.abs(s[1][0] - 10) < 1e-9);
    expect(vertical).toHaveLength(0);
  });

  it("a line that ends inside the arc is extended up to it", () => {
    const g = liveDimensionGraphic("angle", { ...angle, reach: [0, 2] }, mm, false);
    const vertical = g.segments.filter((s) => Math.abs(s[0][0] - 10) < 1e-9 && Math.abs(s[1][0] - 10) < 1e-9);
    expect(vertical).toHaveLength(1);
  });

  it("no angle yet (the pointer on the horizontal) draws no arc and no arrowheads", () => {
    const g = liveDimensionGraphic("angle", { ...angle, sweep: 0 }, mm, false);
    expect(g.arrows).toEqual([]);
    expect(g.segments.every((s) => Math.abs(s[0][1] - 10) < 1e-9 && Math.abs(s[1][1] - 10) < 1e-9)).toBe(true);
  });
});

describe("live diameter", () => {
  it("is the dimension line through the centre towards the pointer, arrowheads on the rim, the value beyond the rim", () => {
    const g = liveDimensionGraphic("diameter", { shape: "diameter", c: [0, 0], r: 15, dir: [1, 0] }, mm, false);
    expect(g.segments).toHaveLength(1);
    expect(g.segments[0]![0][0]).toBeCloseTo(-15, 9);
    expect(g.arrows.map((a) => a.tip[0]).sort((x, y) => x - y)).toEqual([-15, 15]);
    expect(g.label[0]).toBeGreaterThan(15);
    expect(g.label[1]).toBeCloseTo(0, 9);
  });

  it("a circle that is still a point has a place for the value, nothing to draw", () => {
    const g = liveDimensionGraphic("diameter", { shape: "diameter", c: [5, 5], r: 0, dir: [0, 1] }, mm, false);
    expect(g.segments).toEqual([]);
    expect(g.arrows).toEqual([]);
    expect(g.label[0]).toBeCloseTo(5, 9);
    expect(g.label[1]).toBeGreaterThan(5);
  });
});

describe("the problem flag", () => {
  it("is set for an invalid value", () => {
    expect(liveDimensionGraphic("x", { shape: "diameter", c: [0, 0], r: 15, dir: [1, 0] }, mm, true).problem).toBe(true);
  });
});
