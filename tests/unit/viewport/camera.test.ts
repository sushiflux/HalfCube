import { describe, expect, it } from "vitest";
import {
  alignedAxis, axisDirection, cameraBasis, DEFAULT_FOV_Y, defaultView, easeInOutCubic, eyeDirection, fitBounds, focalPlanePoint,
  HALF_PI, HOME_ELEVATION, interpolateView, oppositeAxis, orbitByAngles, orbitByPixels, panByPixels, pixelsPerWorld, screenRay,
  shortestAngle, viewAfterAxisClick, viewFromAxis, worldPerPixel, worldToScreen, zoomAbout, axisKeys, type Lens, type ViewState,
} from "../../../app/src/viewport/camera.ts";
import { add, dot, length, scale, sub, type Vec3 } from "../../../app/src/viewport/math.ts";

const lens: Lens = { fovY: DEFAULT_FOV_Y, width: 1000, height: 600 };
const close = (a: Vec3, b: Vec3, digits = 6) => {
  for (let i = 0; i < 3; i++) expect(a[i]!).toBeCloseTo(b[i]!, digits);
};
const front: ViewState = { target: [0, 0, 0], azimuth: 0, elevation: 0, distance: 200 };

describe("camera basis (right-handed, Z up)", () => {
  it("the front view looks along +Y with +X on the right and +Z up", () => {
    const b = cameraBasis(front);
    close(b.eye, [0, -200, 0]);
    close(b.forward, [0, 1, 0]);
    close(b.right, [1, 0, 0]);
    close(b.up, [0, 0, 1]);
    expect(b.right).toEqual([1, 0, 0]);
  });

  it("the right view sits on +X, the back view on +Y", () => {
    close(cameraBasis({ ...front, azimuth: HALF_PI }).eye, [200, 0, 0]);
    close(cameraBasis({ ...front, azimuth: Math.PI }).eye, [0, 200, 0]);
    expect(cameraBasis({ ...front, azimuth: HALF_PI }).eye[0]).toBeCloseTo(200, 9);
  });

  it("the top view looks down with +X right and +Y up on the screen; the bottom view has +X right and -Y up", () => {
    const top = cameraBasis({ ...front, elevation: HALF_PI });
    close(top.forward, [0, 0, -1]);
    close(top.right, [1, 0, 0]);
    close(top.up, [0, 1, 0]);
    const bottom = cameraBasis({ ...front, elevation: -HALF_PI });
    close(bottom.forward, [0, 0, 1]);
    close(bottom.up, [0, -1, 0]);
    expect(top.up[1]).toBeCloseTo(1, 9);
  });

  it("right, up and forward are orthonormal and right-handed for any orientation, also at the poles", () => {
    for (const azimuth of [-2.5, 0, 0.7, 3]) {
      for (const elevation of [-HALF_PI, -0.4, 0, 0.9, HALF_PI]) {
        const b = cameraBasis({ target: [1, 2, 3], azimuth, elevation, distance: 50 });
        expect(length(b.right)).toBeCloseTo(1, 9);
        expect(length(b.up)).toBeCloseTo(1, 9);
        expect(dot(b.right, b.up)).toBeCloseTo(0, 9);
        expect(dot(b.right, b.forward)).toBeCloseTo(0, 9);
        expect(dot(b.up, b.forward)).toBeCloseTo(0, 9);
        // right x up = -forward (the camera looks down its own -Z axis)
        close([b.right[1] * b.up[2] - b.right[2] * b.up[1], b.right[2] * b.up[0] - b.right[0] * b.up[2], b.right[0] * b.up[1] - b.right[1] * b.up[0]], scale(b.forward, -1), 9);
      }
    }
  });

  it("the start view looks from the front, the right and above", () => {
    const e = eyeDirection(defaultView().azimuth, defaultView().elevation);
    expect(e[0]).toBeGreaterThan(0);
    expect(e[1]).toBeLessThan(0);
    expect(e[2]).toBeGreaterThan(0);
    expect(defaultView().elevation).toBeCloseTo(HOME_ELEVATION, 12);
  });
});

describe("projection", () => {
  it("the target is in the middle of the screen at the target distance", () => {
    const s = worldToScreen(front, lens, [0, 0, 0])!;
    expect(s.x).toBeCloseTo(500, 6);
    expect(s.y).toBeCloseTo(300, 6);
    expect(s.depth).toBeCloseTo(200, 6);
  });

  it("a point to the right and above lands right of and above the middle", () => {
    const s = worldToScreen(front, lens, [10, 0, 10])!;
    expect(s.x).toBeGreaterThan(500);
    expect(s.y).toBeLessThan(300);
  });

  it("points behind the camera do not project", () => {
    expect(worldToScreen(front, lens, [0, -300, 0])).toBeNull();
  });

  it("screenRay is the inverse of worldToScreen", () => {
    const p: Vec3 = [12, 30, -7];
    const s = worldToScreen(front, lens, p)!;
    const ray = screenRay(front, lens, s.x, s.y);
    const t = dot(sub(p, ray.origin), ray.dir);
    close(add(ray.origin, scale(ray.dir, t)), p, 6);
    expect(t).toBeGreaterThan(0);
  });

  it("millimetres per pixel and pixels per millimetre are inverse", () => {
    expect(worldPerPixel(lens, 123) * pixelsPerWorld(lens, 123)).toBeCloseTo(1, 12);
  });
});

describe("orbit", () => {
  it("dragging right turns the model to the right (the eye moves towards -X), dragging down raises the eye", () => {
    expect(orbitByPixels(front, 100, 0).azimuth).toBeLessThan(0);
    expect(orbitByPixels(front, 0, 100).elevation).toBeGreaterThan(0);
  });

  it("clamps the elevation at the poles", () => {
    expect(orbitByAngles(front, 0, 10).elevation).toBe(HALF_PI);
    expect(orbitByAngles(front, 0, -10).elevation).toBe(-HALF_PI);
  });

  it("keeps the pivot where it is on the screen", () => {
    const view: ViewState = { target: [0, 0, 0], azimuth: 0.4, elevation: 0.3, distance: 150 };
    const pivot: Vec3 = [20, 10, 5];
    const before = worldToScreen(view, lens, pivot)!;
    const after = worldToScreen(orbitByAngles(view, 0.6, -0.2, pivot), lens, pivot)!;
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(after.depth).toBeCloseTo(before.depth, 6);
  });

  it("without a pivot the target stays", () => {
    expect(orbitByAngles(front, 0.5, 0.2).target).toEqual([0, 0, 0]);
  });
});

describe("pan", () => {
  it("moves the scene with the pointer: the point at the target depth follows the pointer", () => {
    const p: Vec3 = [15, 0, 8];
    const before = worldToScreen(front, lens, p)!;
    const after = worldToScreen(panByPixels(front, lens, 40, -25), lens, p)!;
    expect(after.x - before.x).toBeCloseTo(40, 4);
    expect(after.y - before.y).toBeCloseTo(-25, 4);
  });
});

describe("zoom towards the cursor", () => {
  const view: ViewState = { target: [0, 0, 0], azimuth: 0.5, elevation: 0.4, distance: 300 };

  it("keeps the point under the cursor under the cursor", () => {
    const px = 700, py = 200;
    const ray = screenRay(view, lens, px, py);
    const anchor = focalPlanePoint(view, ray);
    const zoomed = zoomAbout(view, anchor, 0.5);
    const s = worldToScreen(zoomed, lens, anchor)!;
    expect(s.x).toBeCloseTo(px, 5);
    expect(s.y).toBeCloseTo(py, 5);
    expect(zoomed.distance).toBeCloseTo(150, 9);
  });

  it("zooming in and out again returns to the start", () => {
    const anchor: Vec3 = [30, -20, 10];
    const back = zoomAbout(zoomAbout(view, anchor, 0.5), anchor, 2);
    close(back.target, view.target, 9);
    expect(back.distance).toBeCloseTo(view.distance, 9);
  });

  it("stops at the distance limit and then moves the target no further", () => {
    const anchor: Vec3 = [30, -20, 10];
    const near = zoomAbout({ ...view, distance: 0.06 }, anchor, 0.01);
    expect(near.distance).toBeCloseTo(0.05, 9);
    const again = zoomAbout(near, anchor, 0.01);
    close(again.target, near.target, 12);
  });
});

describe("fit all", () => {
  const box = { min: [-40, -25, 0] as Vec3, max: [40, 25, 20] as Vec3 };

  it("centres the box and shows all corners inside the screen, nearly touching it", () => {
    for (const azimuth of [0, 0.8, 2]) {
      for (const elevation of [0, 0.5, HALF_PI]) {
        const view = fitBounds({ ...defaultView(), azimuth, elevation }, lens, box, 1);
        close(view.target, [0, 0, 10], 9);
        let maxX = 0, maxY = 0;
        for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) {
          const s = worldToScreen(view, lens, [x, y, z])!;
          maxX = Math.max(maxX, Math.abs(s.x - 500) / 500);
          maxY = Math.max(maxY, Math.abs(s.y - 300) / 300);
        }
        expect(Math.max(maxX, maxY)).toBeCloseTo(1, 4);
        expect(Math.max(maxX, maxY)).toBeLessThanOrEqual(1 + 1e-6);
      }
    }
  });

  it("leaves a margin", () => {
    const tight = fitBounds(defaultView(), lens, box, 1).distance;
    const loose = fitBounds(defaultView(), lens, box, 1.2).distance;
    expect(loose).toBeGreaterThan(tight);
  });

  it("an empty box shows the origin area; a single point gets a sensible distance", () => {
    expect(fitBounds(defaultView(), lens, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }).target).toEqual([0, 0, 0]);
    const point = fitBounds(defaultView(), lens, { min: [5, 5, 5], max: [5, 5, 5] });
    expect(point.distance).toBeGreaterThan(1);
    close(point.target, [5, 5, 5], 9);
  });

  it("a narrower screen needs a larger distance for a wide box", () => {
    const wide = fitBounds(front, { ...lens, width: 1600, height: 600 }, box, 1).distance;
    const narrow = fitBounds(front, { ...lens, width: 600, height: 600 }, box, 1).distance;
    expect(narrow).toBeGreaterThan(wide);
  });
});

describe("standard views", () => {
  it("looks from each axis end", () => {
    for (const key of axisKeys) {
      const v = viewFromAxis(front, key);
      close(eyeDirection(v.azimuth, v.elevation), axisDirection(key), 9);
      expect(alignedAxis(v)).toBe(key);
    }
  });

  it("recognises only exact standard views", () => {
    expect(alignedAxis(defaultView())).toBeNull();
    expect(alignedAxis({ ...front, azimuth: 0.01 })).toBeNull();
    expect(alignedAxis({ ...front, azimuth: 0.0001 })).toBe("-y");
  });

  it("a click turns to the view, a second click on the same end shows the opposite side", () => {
    const first = viewAfterAxisClick(defaultView(), "+z");
    expect(alignedAxis(first)).toBe("+z");
    const second = viewAfterAxisClick(first, "+z");
    expect(alignedAxis(second)).toBe(oppositeAxis["+z"]);
    expect(alignedAxis(viewAfterAxisClick(second, "+z"))).toBe("+z");
  });

  it("clicking another end from a standard view goes there, not to the opposite side", () => {
    expect(alignedAxis(viewAfterAxisClick(viewFromAxis(front, "-y"), "+x"))).toBe("+x");
  });

  it("top and bottom keep the nearest quarter turn, so the screen stays square to the axes", () => {
    expect(viewFromAxis({ ...front, azimuth: 0.9 }, "+z").azimuth).toBeCloseTo(HALF_PI, 12);
    expect(viewFromAxis({ ...front, azimuth: -2.4 }, "-z").azimuth).toBeCloseTo(-HALF_PI * 2, 12);
  });

  it("keeps target and distance", () => {
    const v = viewFromAxis({ target: [1, 2, 3], azimuth: 1, elevation: 1, distance: 77 }, "+x");
    expect(v.target).toEqual([1, 2, 3]);
    expect(v.distance).toBe(77);
  });
});

describe("view transitions", () => {
  it("the azimuth takes the short way round", () => {
    expect(shortestAngle(3, -3)).toBeCloseTo(2 * Math.PI - 6, 12);
    const mid = interpolateView({ ...front, azimuth: 3 }, { ...front, azimuth: -3 }, 0.5);
    // halfway between 3 and -3 going through pi, not through 0
    expect(Math.cos(mid.azimuth)).toBeLessThan(-0.99);
  });

  it("interpolation starts and ends exactly at the two views", () => {
    const a: ViewState = { target: [0, 0, 0], azimuth: 0.2, elevation: 0.1, distance: 100 };
    const b: ViewState = { target: [10, 20, 30], azimuth: 1.2, elevation: 0.7, distance: 400 };
    const s = interpolateView(a, b, 0), e = interpolateView(a, b, 1);
    expect(s.distance).toBeCloseTo(100, 9);
    expect(e.distance).toBeCloseTo(400, 9);
    close(e.target, b.target, 9);
    expect(e.azimuth).toBeCloseTo(1.2, 9);
  });

  it("the easing is 0 at the start, 1 at the end, 0.5 in the middle and never goes backwards", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 12);
    let last = 0;
    for (let i = 1; i <= 100; i++) {
      const v = easeInOutCubic(i / 100);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });
});
