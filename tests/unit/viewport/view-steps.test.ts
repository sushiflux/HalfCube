import { describe, expect, it } from "vitest";
import {
  alignedAxis, axisKeys, HALF_PI, standardViewOf, viewAfterTip, viewAfterTurn, viewFromAxis, viewsAreEqual,
  type AxisKey, type TipDirection, type ViewState,
} from "../../../app/src/viewport/camera.ts";
import { navigatorEnds, navigatorMetrics } from "../../../app/src/viewport/navigator-model.ts";

const base: ViewState = { target: [3, 4, 5], azimuth: 0, elevation: 0, distance: 120 };
const standard = (key: AxisKey): ViewState => viewFromAxis(base, key);
const size = 128;
const reach = navigatorMetrics(size).reach;

/** Where the world X axis points on the screen (degrees, counter-clockwise, 0 = right), from the camera's own right and up vectors. */
function screenAngleOfX(view: ViewState): number {
  const right = [Math.cos(view.azimuth), Math.sin(view.azimuth), 0] as const;
  const eye = [Math.sin(view.azimuth) * Math.cos(view.elevation), -Math.cos(view.azimuth) * Math.cos(view.elevation), Math.sin(view.elevation)] as const;
  const forward = [-eye[0], -eye[1], -eye[2]] as const;
  const up = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]] as const;
  return (Math.atan2(up[0], right[0]) * 180) / Math.PI;
}
const turnedBy = (a: number, b: number): number => ((((b - a) % 360) + 540) % 360) - 180;

describe("standard view detection", () => {
  it("knows the six standard views and nothing in between", () => {
    for (const key of axisKeys) expect([key, standardViewOf(standard(key))]).toEqual([key, key]);
    expect(standardViewOf({ ...base, azimuth: 0.4 })).toBeNull();
    expect(standardViewOf({ ...base, elevation: 0.3 })).toBeNull();
    expect(standardViewOf({ ...base, azimuth: Math.PI / 4, elevation: 0.6155 })).toBeNull();
  });

  it("a top view turned by a free angle is aligned but not a standard view for the steps", () => {
    const free = { ...base, elevation: HALF_PI, azimuth: 0.4 };
    expect(alignedAxis(free)).toBe("+z");
    expect(standardViewOf(free)).toBeNull();
    expect(viewAfterTurn(free, "left")).toBeNull();
    expect(viewAfterTip(free, "down")).toBeNull();
  });
});

describe("tipping to the neighbouring view", () => {
  const directions: readonly TipDirection[] = ["up", "down", "left", "right"];
  const screen: Record<TipDirection, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

  it("matches the axis end that sits in that direction on the navigator, in all 24 cases", () => {
    let cases = 0;
    for (const key of axisKeys) {
      const view = standard(key);
      const ends = navigatorEnds(view, size);
      for (const direction of directions) {
        // the end exactly above / below / left / right of the centre (its offset is the full reach)
        const [dx, dy] = screen[direction];
        const end = ends.find((e) => Math.abs(e.x - size / 2 - dx * reach) < 1e-6 && Math.abs(e.y - size / 2 - dy * reach) < 1e-6);
        expect(end, `${key} ${direction}`).toBeDefined();
        const result = viewAfterTip(view, direction);
        expect(result, `${key} ${direction}`).not.toBeNull();
        expect(standardViewOf(result!), `${key} ${direction}`).toBe(end!.key);
        cases++;
      }
    }
    expect(cases).toBe(24);
  });

  it("from the top view: down is Front, right is Right, up is Back, left is Left", () => {
    const top = standard("+z");
    expect(standardViewOf(viewAfterTip(top, "down")!)).toBe("-y");
    expect(standardViewOf(viewAfterTip(top, "right")!)).toBe("+x");
    expect(standardViewOf(viewAfterTip(top, "up")!)).toBe("+y");
    expect(standardViewOf(viewAfterTip(top, "left")!)).toBe("-x");
  });

  it("keeps target and distance", () => {
    const next = viewAfterTip(standard("+z"), "down")!;
    expect(next.target).toEqual(base.target);
    expect(next.distance).toBe(base.distance);
  });

  it("follows a rolled top view: after a quarter turn 'down' is no longer Front", () => {
    const rolled = viewAfterTurn(standard("+z"), "right")!; // azimuth +90 degrees: world +X is at the bottom of the screen
    expect(standardViewOf(viewAfterTip(rolled, "down")!)).toBe("+x");
    expect(standardViewOf(viewAfterTip(rolled, "right")!)).toBe("+y");
  });
});

describe("turning by 90 degrees about the vertical axis", () => {
  it("in the top view the view stays the top view and the part turns on the screen: left counter-clockwise, right clockwise", () => {
    const top = standard("+z");
    const left = viewAfterTurn(top, "left")!, right = viewAfterTurn(top, "right")!;
    expect(standardViewOf(left)).toBe("+z");
    expect(standardViewOf(right)).toBe("+z");
    expect(turnedBy(screenAngleOfX(top), screenAngleOfX(left))).toBeCloseTo(90, 6);
    expect(turnedBy(screenAngleOfX(top), screenAngleOfX(right))).toBeCloseTo(-90, 6);
  });

  it("in the bottom view the sense is flipped, so left is still counter-clockwise on the screen", () => {
    const bottom = standard("-z");
    const left = viewAfterTurn(bottom, "left")!, right = viewAfterTurn(bottom, "right")!;
    expect(standardViewOf(left)).toBe("-z");
    expect(turnedBy(screenAngleOfX(bottom), screenAngleOfX(left))).toBeCloseTo(90, 6);
    expect(turnedBy(screenAngleOfX(bottom), screenAngleOfX(right))).toBeCloseTo(-90, 6);
  });

  it("in a side view the neighbouring side comes to the front (the same as tipping sideways)", () => {
    const expected: Record<string, [AxisKey, AxisKey]> = { "-y": ["-x", "+x"], "+x": ["-y", "+y"], "+y": ["+x", "-x"], "-x": ["+y", "-y"] };
    for (const [key, [left, right]] of Object.entries(expected)) {
      const view = standard(key as AxisKey);
      expect(standardViewOf(viewAfterTurn(view, "left")!), `${key} left`).toBe(left);
      expect(standardViewOf(viewAfterTurn(view, "right")!), `${key} right`).toBe(right);
      expect(standardViewOf(viewAfterTip(view, "left")!), `${key} tip left`).toBe(left);
      expect(standardViewOf(viewAfterTip(view, "right")!), `${key} tip right`).toBe(right);
    }
  });

  it("four turns in one direction come back to the start, and the azimuth stays inside (-pi, pi]", () => {
    for (const key of axisKeys) {
      let view = standard(key);
      const start = view;
      for (let i = 0; i < 4; i++) {
        view = viewAfterTurn(view, "right")!;
        expect(view.azimuth).toBeLessThanOrEqual(Math.PI + 1e-12);
        expect(view.azimuth).toBeGreaterThan(-Math.PI);
      }
      expect([key, standardViewOf(view)]).toEqual([key, key]);
      expect([key, Math.abs(Math.sin((view.azimuth - start.azimuth) / 2)) < 1e-9]).toEqual([key, true]);
    }
  });

  it("left then right is the identity, and a free view has no turn", () => {
    const top = standard("+z");
    expect(viewsAreEqual(viewAfterTurn(viewAfterTurn(top, "left")!, "right")!, top, 1e-9)).toBe(true);
    expect(viewAfterTurn({ ...base, azimuth: 0.7, elevation: 0.5 }, "left")).toBeNull();
  });
});
