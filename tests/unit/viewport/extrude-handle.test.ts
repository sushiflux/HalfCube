import { describe, expect, it } from "vitest";
import { cameraBasis, DEFAULT_FOV_Y, pixelsPerWorld, worldToScreen, type Lens, type ViewState } from "../../../app/src/viewport/camera.ts";
import { axisParameterAtPointer, distanceAfterDrag, handleGeometry, handleIsValid, handleTip, hitHandle } from "../../../app/src/viewport/extrude-handle.ts";
import { dot, normalize, type Vec3 } from "../../../app/src/viewport/math.ts";
import type { ExtrudeHandle } from "../../../app/src/viewport/types.ts";

const lens: Lens = { fovY: DEFAULT_FOV_Y, width: 1000, height: 600 };
const viewOf = (azimuth: number, elevation: number, distance = 200, target: Vec3 = [5, -8, 12]): ViewState => ({ target, azimuth, elevation, distance });

const azimuths = [0, 0.7, 2.1, -1.2, Math.PI, 4];
const elevations = [0, 0.5, 1.2, -0.6, 1.5, -1.1];
const axes: Vec3[] = [[0, 0, 1], [1, 0, 0], [0, -1, 0], normalize([1, 1, 1]), normalize([-2, 1, 0.5])];
const origin: Vec3 = [10, 20, 3];
const along = (o: Vec3, d: Vec3, s: number): Vec3 => [o[0] + d[0] * s, o[1] + d[1] * s, o[2] + d[2] * s];

describe("the length a pointer position means (drag along an axis)", () => {
  it("is exact for a pointer on the axis, at every camera angle and for every axis", () => {
    let checked = 0;
    for (const azimuth of azimuths) {
      for (const elevation of elevations) {
        for (const direction of axes) {
          const view = viewOf(azimuth, elevation);
          const basis = cameraBasis(view);
          // An axis that points almost at the eye has no readable length: that is the one case for null (see below).
          if (Math.abs(dot(direction, basis.forward)) > 0.995) continue;
          for (const s of [-60, -5, 0, 7.5, 40, 120]) {
            const px = worldToScreen(view, lens, along(origin, direction, s), basis);
            if (!px) continue;
            const got = axisParameterAtPointer(view, lens, origin, direction, px.x, px.y, basis);
            expect(got, `az ${azimuth} el ${elevation} axis ${direction.join(",")} s ${s}`).not.toBeNull();
            expect(got!).toBeCloseTo(s, 4);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(400);
  });

  it("follows the pointer's foot on the axis' screen line: a pointer beside the axis reads the same length as its foot", () => {
    const view = viewOf(0.7, 0.5);
    const direction: Vec3 = [0, 0, 1];
    const a = worldToScreen(view, lens, origin)!;
    const b = worldToScreen(view, lens, along(origin, direction, 50))!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const onAxis = worldToScreen(view, lens, along(origin, direction, 31))!;
    for (const offset of [-40, -3, 12, 90]) {
      const got = axisParameterAtPointer(view, lens, origin, direction, onAxis.x - uy * offset, onAxis.y + ux * offset);
      expect(got!, `offset ${offset} px`).toBeCloseTo(31, 4);
    }
  });

  it("grows when the pointer moves along the axis in the arrow's direction, at every angle", () => {
    for (const azimuth of azimuths) {
      for (const elevation of [0.3, -0.5, 1.0]) {
        const view = viewOf(azimuth, elevation);
        const direction: Vec3 = normalize([0.3, 0.4, 0.8]);
        const handle: ExtrudeHandle = { origin, direction, distance: 10 };
        const start = worldToScreen(view, lens, handleTip(handle))!;
        const further = worldToScreen(view, lens, along(origin, direction, 25))!;
        const grab = axisParameterAtPointer(view, lens, origin, direction, start.x, start.y)!;
        expect(distanceAfterDrag(view, lens, handle, 10, grab, further.x, further.y)!, `az ${azimuth} el ${elevation}`).toBeCloseTo(25, 4);
        const back = worldToScreen(view, lens, along(origin, direction, -6))!;
        expect(distanceAfterDrag(view, lens, handle, 10, grab, back.x, back.y)!).toBeCloseTo(-6, 4);
      }
    }
  });

  it("does not jump at the grab: the distance after a drag that has not moved is the one at the start", () => {
    const view = viewOf(1.1, 0.4);
    const handle: ExtrudeHandle = { origin, direction: [0, 0, 1], distance: 14 };
    // The pointer grabs the head a few pixels beside the tip.
    const tip = worldToScreen(view, lens, handleTip(handle))!;
    const grab = axisParameterAtPointer(view, lens, origin, handle.direction, tip.x + 4, tip.y - 3)!;
    expect(distanceAfterDrag(view, lens, handle, 14, grab, tip.x + 4, tip.y - 3)!).toBeCloseTo(14, 9);
  });

  it("goes negative when dragged through the profile to the other side", () => {
    const view = viewOf(0.7, 0.5);
    const handle: ExtrudeHandle = { origin, direction: [0, 0, 1], distance: 20 };
    const tip = worldToScreen(view, lens, handleTip(handle))!;
    const grab = axisParameterAtPointer(view, lens, origin, handle.direction, tip.x, tip.y)!;
    const below = worldToScreen(view, lens, along(origin, handle.direction, -15))!;
    expect(distanceAfterDrag(view, lens, handle, 20, grab, below.x, below.y)!).toBeCloseTo(-15, 4);
  });

  it("gives null, not a wild number, when the axis points at the eye or lies behind it", () => {
    // Looking straight down the Z axis (top view) with the axis through the view target.
    const top = viewOf(0, Math.PI / 2, 200, [0, 0, 0]);
    expect(axisParameterAtPointer(top, lens, [0, 0, 0], [0, 0, 1], 500, 300)).toBeNull();
    // An axis behind the camera.
    const view = viewOf(0, 0.3, 100, [0, 0, 0]);
    const eye = cameraBasis(view).eye;
    expect(axisParameterAtPointer(view, lens, [eye[0], eye[1] - 50, eye[2]], [1, 0, 0], 500, 300)).toBeNull();
  });

  it("is perspective-correct: an axis running into the distance gives the right length for near and far points", () => {
    const view = viewOf(0, 0, 120, [0, 0, 0]);
    const o: Vec3 = [-20, -30, 0];
    const direction: Vec3 = normalize([0.3, 1, 0]);
    for (const s of [10, 60, 150]) {
      const p = worldToScreen(view, lens, along(o, direction, s))!;
      expect(axisParameterAtPointer(view, lens, o, direction, p.x, p.y)!, `s ${s}`).toBeCloseTo(s, 4);
    }
  });
});

describe("the arrow's head", () => {
  const handle: ExtrudeHandle = { origin: [0, 0, 0], direction: [0, 0, 2], distance: 30 };

  it("has the same size on the screen at every zoom", () => {
    for (const distance of [40, 200, 5000]) {
      const view: ViewState = { target: [0, 0, 15], azimuth: 0.6, elevation: 0.5, distance };
      const g = handleGeometry(view, lens, handle, 18, 7);
      const basis = cameraBasis(view);
      const depth = dot([g.tip[0] - basis.eye[0], g.tip[1] - basis.eye[1], g.tip[2] - basis.eye[2]], basis.forward);
      expect(g.length * pixelsPerWorld(lens, depth)).toBeCloseTo(18, 6);
      expect(g.radius * pixelsPerWorld(lens, depth)).toBeCloseTo(7, 6);
    }
  });

  it("points away from the origin: the axis for a positive distance, the other way for a negative one", () => {
    const view = viewOf(0.6, 0.5);
    expect(handleGeometry(view, lens, handle, 18, 7).dir).toEqual([0, 0, 1]);
    // A flipped zero is -0 in JavaScript; the comparison is on the numbers, not on the sign of zero.
    const flipped = handleGeometry(view, lens, { ...handle, distance: -30 }, 18, 7).dir;
    expect([flipped[0] + 0, flipped[1] + 0, flipped[2]]).toEqual([0, 0, -1]);
    expect(handleTip({ ...handle, distance: -30 })).toEqual([0, 0, -30]);
  });

  it("is invalid without a direction or with a number that is not finite", () => {
    expect(handleIsValid(handle)).toBe(true);
    expect(handleIsValid({ ...handle, direction: [0, 0, 0] })).toBe(false);
    expect(handleIsValid({ ...handle, distance: Number.NaN })).toBe(false);
    expect(handleIsValid({ ...handle, origin: [0, Infinity, 0] })).toBe(false);
  });
});

describe("what the pointer is on", () => {
  const view: ViewState = { target: [0, 0, 15], azimuth: 0.6, elevation: 0.5, distance: 200 };
  const handle: ExtrudeHandle = { origin: [0, 0, 0], direction: [0, 0, 1], distance: 30 };
  const at = (p: Vec3) => worldToScreen(view, lens, p)!;

  it("finds the head at the tip and the shaft along the line, and nothing far from the arrow", () => {
    const tip = at([0, 0, 30]);
    expect(hitHandle(view, lens, handle, 18, 7, tip.x, tip.y)?.part).toBe("head");
    const mid = at([0, 0, 8]);
    expect(hitHandle(view, lens, handle, 18, 7, mid.x + 3, mid.y)?.part).toBe("shaft");
    expect(hitHandle(view, lens, handle, 18, 7, mid.x + 60, mid.y)).toBeNull();
    expect(hitHandle(view, lens, handle, 18, 7, tip.x + 80, tip.y - 80)).toBeNull();
  });

  it("the head wins where it covers the shaft", () => {
    const tip = at([0, 0, 30]);
    const hit = hitHandle(view, lens, handle, 18, 7, tip.x, tip.y)!;
    expect(hit.part).toBe("head");
    expect(hit.distancePx).toBe(0);
  });

  it("an arrow of length zero has only its head", () => {
    const zero: ExtrudeHandle = { ...handle, distance: 0 };
    const o = at([0, 0, 0]);
    expect(hitHandle(view, lens, zero, 18, 7, o.x, o.y)?.part).toBe("head");
    expect(hitHandle(view, lens, zero, 18, 7, o.x + 30, o.y)).toBeNull();
  });
});
