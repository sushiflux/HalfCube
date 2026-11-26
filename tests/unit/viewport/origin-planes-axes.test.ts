import { describe, expect, it } from "vitest";
import { cameraBasis, DEFAULT_FOV_Y, worldToScreen, type Lens, type ViewState } from "../../../app/src/viewport/camera.ts";
import { AXIS_FADE_END, AXIS_FADE_START, AXIS_HOVER_WIDTH_FACTOR, AXIS_REST_OPACITY, AXIS_REST_WIDTH_FACTOR, axesShown, axisFade, axisFadeRange, axisLook, nearestAxis } from "../../../app/src/viewport/axis-style.ts";
import { originPlaneHalf, planeEdgePx, PLANE_EDGE_FRACTION } from "../../../app/src/viewport/origin-planes.ts";
import { getTheme, modes, themeKeys } from "../../../app/src/theme/themes.ts";
import { styleFromTheme } from "../../../app/src/viewport/style.ts";
import { contrastRatio } from "../../../app/src/theme/contrast.ts";

const lens: Lens = { fovY: DEFAULT_FOV_Y, width: 1000, height: 600 };
const viewOf = (azimuth: number, elevation: number, distance: number, target: [number, number, number] = [0, 0, 0]): ViewState => ({ target, azimuth, elevation, distance });

describe("size of the origin planes", () => {
  it("an edge is a sixth of the view's shorter side", () => {
    expect(PLANE_EDGE_FRACTION).toBeCloseTo(1 / 6, 12);
    expect(planeEdgePx(lens)).toBeCloseTo(100, 9);
    expect(planeEdgePx({ ...lens, width: 300, height: 900 })).toBeCloseTo(50, 9);
  });

  it("seen square-on, one edge covers that many pixels at every zoom and for any content", () => {
    for (const distance of [5, 60, 300, 5000, 400000]) {
      const view = viewOf(0, Math.PI / 2, distance); // top view, looking at the XY plane
      const half = originPlaneHalf(view, lens);
      const a = worldToScreen(view, lens, [-half, 0, 0])!, b = worldToScreen(view, lens, [half, 0, 0])!;
      expect(Math.abs(b.x - a.x), `distance ${distance}`).toBeCloseTo(100, 4);
    }
  });

  it("does not depend on where the view looks: a view far from the origin keeps the size of the origin's depth", () => {
    const far = viewOf(0.7, 0.5, 200, [900, -400, 50]);
    const half = originPlaneHalf(far, lens);
    const basis = cameraBasis(far);
    const rel = [-basis.eye[0], -basis.eye[1], -basis.eye[2]] as const;
    const depth = rel[0] * basis.forward[0] + rel[1] * basis.forward[1] + rel[2] * basis.forward[2];
    expect(depth).toBeGreaterThan(0);
    // one plane edge, laid across the screen's right axis at the origin, spans 100 px
    const a = worldToScreen(far, lens, [-half * basis.right[0], -half * basis.right[1], -half * basis.right[2]])!;
    const b = worldToScreen(far, lens, [half * basis.right[0], half * basis.right[1], half * basis.right[2]])!;
    expect(Math.abs(b.x - a.x)).toBeCloseTo(100, 3);
  });

  it("grows and shrinks in step with the zoom, and a window narrower than it is high gives a smaller plane (the shorter side counts)", () => {
    const near = originPlaneHalf(viewOf(0.7, 0.5, 100), lens), far = originPlaneHalf(viewOf(0.7, 0.5, 400), lens);
    expect(far / near).toBeCloseTo(4, 6);
    expect(originPlaneHalf(viewOf(0.7, 0.5, 100), { ...lens, width: 300 })).toBeCloseTo(near / 2, 9);
    // a window that is only shorter keeps the world size: the vertical field of view is the same, the edge shrinks with the height
    expect(originPlaneHalf(viewOf(0.7, 0.5, 100), { ...lens, height: 300 })).toBeCloseTo(near, 9);
  });

  it("is a usable number when the origin is behind the camera: the zoom distance stands in for its depth", () => {
    const behind = viewOf(0, 0.2, 50, [0, 800, 0]); // the camera looks away from the origin
    const half = originPlaneHalf(behind, lens);
    expect(Number.isFinite(half)).toBe(true);
    expect(half).toBeGreaterThan(0);
  });
});

describe("the origin axes", () => {
  it("are solid near the origin, gone far away, smooth in between, the same in both directions", () => {
    const d = 200;
    const { start, end } = axisFadeRange(d);
    expect(start).toBeCloseTo(d * AXIS_FADE_START, 9);
    expect(end).toBeCloseTo(d * AXIS_FADE_END, 9);
    expect(axisFade(0, d)).toBe(1);
    expect(axisFade(start * 0.9, d)).toBe(1);
    expect(axisFade(end, d)).toBe(0);
    expect(axisFade(end * 3, d)).toBe(0);
    let last = 1;
    for (let x = start; x <= end; x += (end - start) / 20) {
      const f = axisFade(x, d);
      expect(f).toBeLessThanOrEqual(last + 1e-12);
      last = f;
    }
    expect(axisFade(-90, d)).toBeCloseTo(axisFade(90, d), 12);
    expect(axisFade((start + end) / 2, d)).toBeCloseTo(0.5, 9);
  });

  it("the fade scales with the zoom: the same share of the axis stays solid whatever the zoom", () => {
    expect(axisFade(30, 100)).toBeCloseTo(axisFade(300, 1000), 12);
  });

  it("at rest they are thin and pale, under the pointer thicker and fully opaque, from the line style of the theme", () => {
    for (const key of themeKeys) {
      for (const mode of modes) {
        const s = styleFromTheme(key, mode);
        for (const kind of ["axisX", "axisY", "axisZ"] as const) {
          const rest = axisLook(s.lines[kind], false), hover = axisLook(s.lines[kind], true);
          expect(rest.width).toBeCloseTo(s.lines[kind].width * AXIS_REST_WIDTH_FACTOR, 9);
          expect(rest.opacity).toBe(AXIS_REST_OPACITY);
          expect(hover.width).toBeCloseTo(s.lines[kind].width * AXIS_HOVER_WIDTH_FACTOR, 9);
          expect(hover.opacity).toBe(1);
          expect(hover.width).toBeGreaterThan(rest.width * 2);
          // the colour under the pointer is the full one, at 3:1 against the view colour
          expect(contrastRatio(s.lines[kind].color, s.background), `${key}/${mode}/${kind}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("under the pointer the part of the axis that can be hovered comes out in full colour: the fade is boosted, never above 1", () => {
    const line = styleFromTheme("praezision", "light").lines.axisZ;
    const rest = axisLook(line, false), hover = axisLook(line, true);
    expect(rest.fadeBoost).toBe(1);
    expect(hover.fadeBoost).toBeGreaterThan(1);
    // where the axis is still at least 0.3 solid (the hover limit) ... and at 0.65 solid it is already full
    expect(Math.min(1, 0.65 * hover.fadeBoost)).toBe(1);
    expect(Math.min(1, 0.3 * hover.fadeBoost)).toBeGreaterThan(0.3);
  });

  it("a changed weight carries over to the rest look (a user override keeps working)", () => {
    const base = styleFromTheme("praezision", "light").lines.axisX;
    expect(axisLook({ ...base, width: 4 }, false).width).toBeCloseTo(4 * AXIS_REST_WIDTH_FACTOR, 9);
  });

  it("the weights of the themes stay as the owner set them: the calmer look comes from the factors, not from changed tokens", () => {
    expect(getTheme("praezision").weights.axisX).toBe(1.6);
  });

  it("show with the grid, hide with it, and never in a sketch plane", () => {
    expect(axesShown(true, true, false)).toBe(true);
    expect(axesShown(false, true, false)).toBe(false);
    expect(axesShown(true, false, false)).toBe(false);
    expect(axesShown(true, true, true)).toBe(false);
  });

  it("the pointer finds the axis it is on, at any camera angle, and none when it is away", () => {
    for (const az of [0.4, 2, -1.3]) {
      for (const el of [0.3, 0.9, -0.5]) {
        const view = viewOf(az, el, 200);
        for (const [i, d] of [[0, [1, 0, 0]], [1, [0, 1, 0]], [2, [0, 0, 1]]] as const) {
          const p = worldToScreen(view, lens, [d[0] * 25, d[1] * 25, d[2] * 25]);
          if (!p) continue;
          const hit = nearestAxis(view, lens, p.x + 2, p.y);
          expect(hit?.axis, `az ${az} el ${el} axis ${i}`).toBe(i);
          expect(nearestAxis(view, lens, p.x + 300, p.y + 300)).toBeNull();
        }
      }
    }
  });
});
