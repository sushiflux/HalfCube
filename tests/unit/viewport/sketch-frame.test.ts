import { describe, expect, it } from "vitest";
import { cameraBasis, DEFAULT_FOV_Y, pixelsPerWorld, viewFromAxis, type Lens, type ViewState } from "../../../app/src/viewport/camera.ts";
import { frameOfView, fittedViewOnto, makeProjector, viewAgreement, viewLookingOnto, sketchToWorld, worldToSketch } from "../../../app/src/viewport/sketch/frame.ts";
import { frameOf, rectangleView, type Plane } from "./sketch-fixtures.ts";

const lens: Lens = { fovY: DEFAULT_FOV_Y, width: 900, height: 600 };
const home: ViewState = { target: [10, 20, 30], azimuth: Math.PI / 4, elevation: 0.6, distance: 250 };
const frames = (["xy", "xz", "yz"] as Plane[]).map((p) => [p, frameOfView({ frame: frameOf(p) })] as const);

describe("alignToSketch: the view that looks onto the sketch plane", () => {
  for (const [plane, frame] of frames) {
    it(`${plane}: the eye is on the normal, u goes to the right and v up on the screen`, () => {
      const view = viewLookingOnto(frame, home);
      const b = cameraBasis(view);
      for (let i = 0; i < 3; i++) {
        expect(b.right[i]!).toBeCloseTo(frame.u[i]!, 9);
        expect(b.up[i]!).toBeCloseTo(frame.v[i]!, 9);
        expect(b.forward[i]!).toBeCloseTo(-frame.normal[i]!, 9);
      }
      expect(viewAgreement(frame, view)).toEqual({ u: expect.closeTo(1, 9), v: expect.closeTo(1, 9) });
    });

    it(`${plane}: the result does not depend on where the camera was before`, () => {
      const a = viewLookingOnto(frame, home);
      const b = viewLookingOnto(frame, { ...home, azimuth: -2.4, elevation: -0.9 });
      expect(a.azimuth).toBeCloseTo(b.azimuth, 9);
      expect(a.elevation).toBeCloseTo(b.elevation, 9);
    });
  }

  it("keeps target and distance unless they are given", () => {
    const frame = frames[0]![1];
    const v = viewLookingOnto(frame, home);
    expect(v.target).toEqual(home.target);
    expect(v.distance).toBe(home.distance);
    const w = viewLookingOnto(frame, home, [1, 2, 3], 99);
    expect(w.target).toEqual([1, 2, 3]);
    expect(w.distance).toBe(99);
  });

  it("the navigator's top view from the start view shows +X down (the bug of the first sketch): the view of the sketch does not", () => {
    // viewFromAxis keeps the nearest quarter turn of the azimuth for top and bottom: from the start azimuth of 45 degrees it
    // picks 90 degrees, so +Y is to the right and +X points down on the screen.
    const nav = cameraBasis(viewFromAxis(home, "+z"));
    expect(nav.right[1]).toBeCloseTo(1, 9);
    expect(nav.up[0]).toBeCloseTo(-1, 9);
    const sketch = cameraBasis(viewLookingOnto(frames[0]![1], home));
    expect(sketch.right[0]).toBeCloseTo(1, 9);
    expect(sketch.up[1]).toBeCloseTo(1, 9);
  });

  it("a plane seen from below (normal -Z) keeps u to the right and v up", () => {
    const frame = { origin: [0, 0, 0] as const, u: [1, 0, 0] as const, v: [0, -1, 0] as const, normal: [0, 0, -1] as const };
    const b = cameraBasis(viewLookingOnto(frame, home));
    expect(b.right[0]).toBeCloseTo(1, 9);
    expect(b.up[1]).toBeCloseTo(-1, 9);
  });

  it("fits the sketch: its corners end up inside the view, centred", () => {
    const frame = frames[1]![1];
    const bounds = { min: [0, 0, 0] as const, max: [200, 0, 100] as const };
    const view = fittedViewOnto(frame, home, lens, bounds);
    const proj = makeProjector(view, lens, frame);
    for (const [u, v] of [[0, 0], [200, 100]] as const) {
      const s = proj.toScreen(u, v)!;
      expect(s.x).toBeGreaterThan(0);
      expect(s.x).toBeLessThan(lens.width);
      expect(s.y).toBeGreaterThan(0);
      expect(s.y).toBeLessThan(lens.height);
    }
    const mid = proj.toScreen(100, 50)!;
    expect(mid.x).toBeCloseTo(lens.width / 2, 3);
    expect(mid.y).toBeCloseTo(lens.height / 2, 3);
  });

  it("an empty sketch looks at the origin of its plane", () => {
    const v = fittedViewOnto(frames[2]![1], home, lens, null);
    expect(v.target).toEqual([0, 0, 0]);
    expect(v.distance).toBe(home.distance);
  });
});

describe("projection between pixels and the sketch", () => {
  for (const [plane, frame] of frames) {
    it(`${plane}: toSketch undoes toScreen, also from an oblique view`, () => {
      for (const view of [viewLookingOnto(frame, home), home]) {
        const proj = makeProjector(view, lens, frame);
        for (const [u, v] of [[0, 0], [37.5, -12.25], [-80, 44]] as const) {
          const s = proj.toScreen(u, v)!;
          const back = proj.toSketch(s.x, s.y)!;
          expect(back.u).toBeCloseTo(u, 4);
          expect(back.v).toBeCloseTo(v, 4);
        }
      }
    });
  }

  it("in the aligned view u runs right and v up, at the scale of the camera", () => {
    const frame = frames[0]![1];
    const view = viewLookingOnto(frame, { ...home, target: [0, 0, 0] });
    const proj = makeProjector(view, lens, frame);
    const o = proj.toScreen(0, 0)!, u = proj.toScreen(10, 0)!, v = proj.toScreen(0, 10)!;
    expect(u.x).toBeGreaterThan(o.x);
    expect(u.y).toBeCloseTo(o.y, 6);
    expect(v.y).toBeLessThan(o.y);
    expect(v.x).toBeCloseTo(o.x, 6);
    expect(proj.pxPerMm).toBeCloseTo(pixelsPerWorld(lens, view.distance), 6);
    expect(Math.hypot(u.x - o.x, u.y - o.y)).toBeCloseTo(10 * proj.pxPerMm, 6);
  });

  it("a plane seen edge-on has no sketch point under a pixel on its line of sight; the scale stays finite", () => {
    const frame = frames[0]![1];
    const edgeOn: ViewState = { target: [0, 0, 0], azimuth: 0, elevation: 0, distance: 200 };
    const proj = makeProjector(edgeOn, lens, frame);
    expect(Number.isFinite(proj.pxPerMm)).toBe(true);
    expect(proj.pxPerMm).toBeGreaterThan(0);
  });

  it("sketch and world coordinates convert both ways", () => {
    const frame = frames[1]![1];
    const w = sketchToWorld(frame, 12, 34);
    expect(w).toEqual([12, 0, 34]);
    expect(worldToSketch(frame, w)).toEqual([12, 34]);
  });
});

describe("the test fixture is a consistent sketch view", () => {
  it("its normals are u x v", () => {
    for (const [, f] of frames) {
      const c = [f.u[1] * f.v[2] - f.u[2] * f.v[1], f.u[2] * f.v[0] - f.u[0] * f.v[2], f.u[0] * f.v[1] - f.u[1] * f.v[0]];
      for (let i = 0; i < 3; i++) expect(c[i]!).toBeCloseTo(f.normal[i]!, 12);
    }
    expect(rectangleView().points).toHaveLength(4);
  });
});
