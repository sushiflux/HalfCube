// Where the floating value fields of a drawing tool go: beside their geometry, inside the view, never on top of each other.
import { describe, expect, it } from "vitest";
import {
  LIVE_OFFSET_HORIZONTAL_PX,
  LIVE_OFFSET_SLANTED_PX,
  LIVE_OFFSET_VERTICAL_PX,
  clampSpot,
  liveCircle,
  liveLine,
  liveRectangle,
  messageSpot,
  outward,
  placeFields,
  upperNormal,
} from "../../../app/src/screens/sketch/field-layout.ts";
import { formatLive } from "../../../app/src/screens/sketch/geometry.ts";

const field = { w: 96, h: 30 };
const view = { w: 800, h: 500 };
const apart = (p: { x: number; y: number }, q: { x: number; y: number }): boolean => Math.abs(p.x - q.x) >= field.w || Math.abs(p.y - q.y) >= field.h;

describe("outward direction", () => {
  it("normalises, and a zero direction means up", () => {
    expect(outward(3, 4, false)).toEqual({ dx: 0.6, dy: 0.8 });
    expect(outward(0, 0, false)).toEqual({ dx: 0, dy: -1 });
  });

  it("`either` takes the upper side, or the right one for a horizontal direction", () => {
    expect(outward(0, 5, true).dy).toBe(-1);
    expect(outward(0, -5, true).dy).toBe(-1);
    expect(outward(-5, 0, true).dx).toBe(1);
    expect(outward(5, 0, true).dx).toBe(1);
  });
});

describe("placing fields", () => {
  it("a field beside a point keeps its whole width (or height) clear of it", () => {
    const [right] = placeFields([{ x: 300, y: 250, dx: 1, dy: 0, either: false }], view, field);
    expect(right).toEqual({ x: 300 + 48 + 10, y: 250 });
    const [above] = placeFields([{ x: 300, y: 250, dx: 0, dy: -1, either: false }], view, field);
    expect(above).toEqual({ x: 300, y: 250 - 15 - 10 });
  });

  it("stays inside the view, also in a corner and in a view smaller than the field", () => {
    const [a] = placeFields([{ x: 790, y: 5, dx: 1, dy: -1, either: false }], view, field);
    expect(a!.x).toBeLessThanOrEqual(view.w - field.w / 2);
    expect(a!.y).toBeGreaterThanOrEqual(field.h / 2);
    expect(clampSpot({ x: 5, y: 5 }, { w: 50, h: 20 }, field, 6)).toEqual({ x: 25, y: 10 });
  });

  it("two fields never cover each other", () => {
    const [p, q] = placeFields(
      [
        { x: 300, y: 250, dx: 0, dy: -1, either: false },
        { x: 300, y: 250, dx: 0, dy: -1, either: false },
      ],
      view,
      field,
    ) as [{ x: number; y: number }, { x: number; y: number }];
    expect(apart(p, q)).toBe(true);
  });

  it("two fields pushed against the top edge of the view still do not overlap", () => {
    const [p, q] = placeFields(
      [
        { x: 300, y: 10, dx: 0, dy: -1, either: false },
        { x: 300, y: 10, dx: 0, dy: -1, either: false },
      ],
      view,
      field,
    ) as [{ x: number; y: number }, { x: number; y: number }];
    expect(apart(p, q)).toBe(true);
  });
});

describe("live number format", () => {
  it("has at most 2 decimals, drops trailing zeros and never shows -0", () => {
    expect(formatLive(26.822, false)).toBe("26.82");
    expect(formatLive(26.8, false)).toBe("26.8");
    expect(formatLive(30, false)).toBe("30");
    expect(formatLive(26.822, true)).toBe("26,82");
    expect(formatLive(-0.004, true)).toBe("0");
    expect(formatLive(-12.5, true)).toBe("-12,5");
  });
});

describe("the live dimensions of the look Maßlinie", () => {
  it("a rectangle gets the width outside the edge through the start and the height outside the far edge, at fixed pixel offsets", () => {
    const up = liveRectangle([10, 10], [70, 40]);
    expect(up.width).toEqual({ shape: "linear", a: [10, 10], b: [70, 10], n: [0, -1], offsetPx: LIVE_OFFSET_HORIZONTAL_PX });
    expect(up.height).toEqual({ shape: "linear", a: [70, 10], b: [70, 40], n: [1, 0], offsetPx: LIVE_OFFSET_VERTICAL_PX });
    // Pointer to the lower left: the width goes above the start edge, the height to the left of the far edge.
    const down = liveRectangle([10, 10], [-10, -20]);
    expect(down.width).toMatchObject({ n: [0, 1] });
    expect(down.height).toMatchObject({ n: [-1, 0] });
  });

  it("the offset never depends on the size of the shape or on other dimensions", () => {
    for (const to of [[11, 11], [500, 300], [-40, -40]] as const) {
      const r = liveRectangle([0, 0], to);
      expect([r.width, r.height].map((d) => (d.shape === "linear" ? d.offsetPx : -1))).toEqual([LIVE_OFFSET_HORIZONTAL_PX, LIVE_OFFSET_VERTICAL_PX]);
    }
    for (const to of [[3, 4], [300, -200], [-80, 50]] as const) {
      expect(liveLine([0, 0], to, 4).length).toMatchObject({ offsetPx: LIVE_OFFSET_SLANTED_PX });
    }
  });

  it("the length of a line is shown on its upper (or right) side", () => {
    expect(upperNormal([10, 0])).toEqual([0, 1]);
    expect(upperNormal([-10, 0])).toEqual([0, 1]);
    expect(upperNormal([0, 10])[0]).toBe(1); // a vertical line: its right side
    expect(upperNormal([0, -10])[0]).toBe(1);
    const n = upperNormal([3, -4]);
    expect(n[1]).toBeGreaterThan(0);
    expect(Math.hypot(n[0], n[1])).toBeCloseTo(1, 12);
    expect(upperNormal([0, 0])).toEqual([0, 1]);
  });

  it("the angle of a line is an arc from the horizontal through the angle of the line; its radius follows the length within limits", () => {
    const a = liveLine([5, 5], [5, 35], 10).angle;
    expect(a).toMatchObject({ shape: "angle", vertex: [5, 5], start: 0, reach: [0, 30] });
    expect(a.shape === "angle" && a.sweep).toBeCloseTo(Math.PI / 2, 12);
    expect(a.shape === "angle" && a.radiusPx).toBe(90); // 30 mm at 10 px/mm is 300 px long: the arc is capped
    expect(liveLine([0, 0], [1, 0], 10).angle).toMatchObject({ radiusPx: 30 }); // a short line keeps a readable arc
    expect(liveLine([0, 0], [0, 0], 10).angle).toMatchObject({ sweep: 0 });
  });

  it("a circle is measured along the pointer direction, to the right while the pointer is on the centre", () => {
    expect(liveCircle([10, 10], 30, [0, 5])).toEqual({ shape: "diameter", c: [10, 10], r: 15, dir: [0, 1] });
    expect(liveCircle([10, 10], 0, [0, 0])).toMatchObject({ dir: [1, 0], r: 0 });
  });
});

describe("the message under a field", () => {
  const msg = { w: 260, h: 96 };
  const fieldSize = { w: 96, h: 26 };
  it("sits below the field, left-aligned with it, pulled into the view", () => {
    expect(messageSpot({ x: 300, y: 200 }, fieldSize, view, msg)).toEqual({ left: 252, top: 200 + 13 + 4 });
    expect(messageSpot({ x: 790, y: 200 }, fieldSize, view, msg).left).toBe(view.w - msg.w - 6);
    expect(messageSpot({ x: 20, y: 200 }, fieldSize, view, msg).left).toBe(6);
  });

  it("flips above the field near the bottom edge, but stays below when it fits neither way", () => {
    const flipped = messageSpot({ x: 300, y: 480 }, fieldSize, view, msg);
    expect(flipped.top).toBeUndefined();
    expect(flipped.bottom).toBe(view.h - (480 - 13 - 4));
    expect(messageSpot({ x: 300, y: 30 }, fieldSize, { w: 800, h: 100 }, msg).top).toBeDefined();
  });
});
