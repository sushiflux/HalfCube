import { describe, expect, it } from "vitest";
import { cameraBasis, DEFAULT_FOV_Y, defaultView, pixelsPerWorld, screenRay, type Lens, type ViewState } from "../../../app/src/viewport/camera.ts";
import {
  DENSE_FULL_PX, DENSE_NONE_PX, densityFade, gridCamera, gridLayout, gridLevels, LEVEL_FADE_IN_FULL_PX, LEVEL_FADE_IN_START_PX, levelSpacing,
  lineCoverage, MAX_GRID_LEVELS, pixelFootprint, REACH_FACTOR, reachFade,
} from "../../../app/src/viewport/grid-math.ts";
import { cross, dot, normalize, sub, type Vec3 } from "../../../app/src/viewport/math.ts";
import { rayPlane } from "../../../app/src/viewport/picking.ts";
import type { Frame3 } from "../../../app/src/viewport/sketch/frame.ts";

const lens: Lens = { fovY: DEFAULT_FOV_Y, width: 1200, height: 800 };

/** A plane tilted away from every world axis, so the checks do not pass by luck of an aligned frame. */
const tilted: Frame3 = (() => {
  const u = normalize([1, 0.4, -0.2]);
  const v0 = normalize([-0.3, 1, 0.5]);
  const normal = normalize(cross(u, v0));
  const v = normalize(cross(normal, u));
  return { origin: [12, -7, 30], u, v, normal };
})();

describe("grid levels", () => {
  const ppm = (distance: number) => pixelsPerWorld(lens, distance);

  it("the spacings are round numbers and nested: every line of a coarser level is a line of every finer one", () => {
    let previous = levelSpacing(-12);
    for (let n = -11; n <= 12; n++) {
      const spacing = levelSpacing(n);
      const ratio = spacing / previous;
      expect([2, 5].some((r) => Math.abs(ratio - r) < 1e-9)).toBe(true);
      // The mantissa is 1 or 5: 0.1, 0.5, 1, 5, 10, 50 ...
      const mantissa = spacing / Math.pow(10, Math.floor(Math.log10(spacing) + 1e-9));
      expect([1, 5].some((m) => Math.abs(mantissa - m) < 1e-9)).toBe(true);
      previous = spacing;
    }
    expect([0, 1, 2, 3, 4].map(levelSpacing)).toEqual([1, 5, 10, 50, 100]);
    expect([-1, -2, -3].map(levelSpacing)).toEqual([0.5, 0.1, 0.05]);
  });

  it("the levels of one zoom are neighbours in that sequence, finest first, and every spacing divides the next", () => {
    for (const pxPerMm of [0.0004, 0.01, 0.3, 1, 4.2, 9, 20, 130, 2500, 90000]) {
      const levels = gridLevels(pxPerMm);
      expect(levels.length).toBeGreaterThanOrEqual(1);
      expect(levels.length).toBeLessThanOrEqual(MAX_GRID_LEVELS);
      for (let i = 1; i < levels.length; i++) {
        const ratio = levels[i]!.spacing / levels[i - 1]!.spacing;
        expect(Math.abs(ratio - Math.round(ratio))).toBeLessThan(1e-9);
        expect([2, 5]).toContain(Math.round(ratio));
      }
    }
  });

  it("the default view shows three levels: a fading 5 mm, a full 10 mm and the coarse 50 mm", () => {
    const levels = gridLevels(ppm(300));
    expect(levels.map((l) => l.spacing)).toEqual([5, 10, 50]);
    expect(levels[1]!.opacity).toBe(1);
    expect(levels[0]!.opacity).toBeGreaterThan(0);
    expect(levels[0]!.opacity).toBeLessThan(0.6);
    expect(levels[1]!.major).toBe(0);
    expect(levels[2]!.major).toBe(1);
    // Each level leaves out the lines the next coarser one draws: every 2nd 5 mm line, every 5th 10 mm line, nothing of the 50 mm level.
    expect(levels.map((l) => l.coarser)).toEqual([2, 5, 0]);
  });

  it("a level fades in as its lines get further apart: nothing below the start spacing, full at the comfortable spacing", () => {
    const opacity = (px: number) => gridLevels(px / 5).find((l) => l.spacing === 5)?.opacity ?? 0;
    expect(opacity(LEVEL_FADE_IN_START_PX)).toBe(0);
    expect(opacity(LEVEL_FADE_IN_START_PX * 0.5)).toBe(0);
    expect(opacity(LEVEL_FADE_IN_FULL_PX)).toBe(1);
    expect(opacity(LEVEL_FADE_IN_FULL_PX * 3)).toBe(1);
    let last = 0;
    for (let px = LEVEL_FADE_IN_START_PX; px <= LEVEL_FADE_IN_FULL_PX; px += 0.5) {
      expect(opacity(px)).toBeGreaterThanOrEqual(last - 1e-12);
      last = opacity(px);
    }
  });

  it("zooming changes nothing abruptly: tiny zoom steps never make a level's opacity or look jump, and levels only come and go where they are invisible", () => {
    // Sweep seven decades of zoom in steps of 0.05 %: compare each spacing's opacity and look with the previous step's.
    let previous = gridLevels(0.01);
    let maxOpacityJump = 0;
    let maxMajorJump = 0;
    let comings = 0;
    const problems: string[] = [];
    for (let ppmNow = 0.01; ppmNow < 100000; ppmNow *= 1.0005) {
      const now = gridLevels(ppmNow);
      const before = new Map(previous.map((l) => [l.spacing, l]));
      const after = new Map(now.map((l) => [l.spacing, l]));
      for (const [spacing, l] of after) {
        const was = before.get(spacing);
        if (was) {
          maxOpacityJump = Math.max(maxOpacityJump, Math.abs(l.opacity - was.opacity));
          maxMajorJump = Math.max(maxMajorJump, Math.abs(l.major - was.major));
        } else if (spacing < previous[0]!.spacing) {
          // A finer level appears (zooming in): it starts invisible.
          if (!(l.opacity < 1e-3)) problems.push(`finer level ${spacing} appeared with opacity ${l.opacity}`);
          comings++;
        } else {
          // A coarser level appears at the coarse end (zooming out): the one that was last already looks fully coarse.
          if (previous[previous.length - 1]!.major !== 1 || l.major !== 1) problems.push(`coarser level ${spacing} appeared with a different look`);
          comings++;
        }
      }
      for (const [spacing, was] of before) {
        if (after.has(spacing)) continue;
        if (spacing < now[0]!.spacing) {
          if (!(was.opacity < 1e-3)) problems.push(`finest level ${spacing} left while still visible (${was.opacity})`);
        } else if (was.major !== 1) {
          problems.push(`coarse level ${spacing} left while it looked different (${was.major})`);
        }
      }
      previous = now;
    }
    expect(problems).toEqual([]);
    expect(comings).toBeGreaterThan(10);
    // A step of 0.05 % of the zoom moves the opacity and the look by a few thousandths at most.
    expect(maxOpacityJump).toBeLessThan(0.01);
    expect(maxMajorJump).toBeLessThan(0.01);
  });

  it("the coarsest level always has the full coarse look and full opacity", () => {
    for (const pxPerMm of [0.02, 0.5, 3, 40, 700]) {
      const last = gridLevels(pxPerMm).at(-1)!;
      expect(last.major).toBe(1);
      expect(last.opacity).toBe(1);
    }
  });

  it("the levels depend on the zoom distance alone: the same distance gives the same levels wherever the camera looks from", () => {
    const base = defaultView();
    const expected = gridLevels(pixelsPerWorld(lens, base.distance));
    const others: ViewState[] = [
      { ...base, azimuth: 2.2 },
      { ...base, elevation: 0.05 },
      { ...base, elevation: -1.2 },
      { ...base, target: [4000, -2500, 900] },
      { target: [0, 0, 0], azimuth: 0, elevation: Math.PI / 2, distance: base.distance },
    ];
    for (const view of others) {
      for (const frame of [null, tilted]) expect(gridLayout(view, lens, frame).levels).toEqual(expected);
    }
  });
});

describe("grid layout", () => {
  it("zooming in makes the finest level finer, step by step", () => {
    const finest: number[] = [];
    for (const distance of [400000, 20000, 2000, 300, 40, 5, 0.5]) finest.push(gridLayout({ ...defaultView(), distance }, lens, null).levels[0]!.spacing);
    for (let i = 1; i < finest.length; i++) expect(finest[i]).toBeLessThan(finest[i - 1]!);
  });

  it("the quad's middle is a whole number of every level's spacing, so the lines of every level keep their place in the plane", () => {
    for (const target of [[0, 0, 0], [123.4, -88.8, 5], [-9000, 4000, 0]] as const) {
      for (const frame of [null, tilted]) {
        for (const distance of [0.7, 20, 120, 5000]) {
          const layout = gridLayout({ ...defaultView(), target, distance }, lens, frame);
          for (const c of [layout.centerU, layout.centerV]) {
            for (const level of layout.levels) expect(Math.abs(c / level.spacing - Math.round(c / level.spacing))).toBeLessThan(1e-6);
          }
          expect(layout.snap).toBe(layout.levels[layout.levels.length - 1]!.spacing);
        }
      }
    }
  });

  it("the quad lies under the eye and covers everything within the reach", () => {
    const views: ViewState[] = [defaultView(), { ...defaultView(), elevation: 0.02, azimuth: 1 }, { ...defaultView(), target: [500, 500, 400], distance: 90 }];
    for (const view of views) {
      for (const frame of [null, tilted]) {
        const layout = gridLayout(view, lens, frame);
        const eye = cameraBasis(view).eye;
        const rel = frame ? sub(eye, frame.origin) : eye;
        const eu = frame ? dot(rel, frame.u) : rel[0];
        const ev = frame ? dot(rel, frame.v) : rel[1];
        // The eye's foot point is within half a snap step of the middle in each direction; every point within the reach of the eye is
        // within the reach of the foot point, so the quad (half size reach + 2 snap) contains it.
        expect(Math.abs(layout.centerU - eu)).toBeLessThanOrEqual(layout.snap / 2 + 1e-9);
        expect(Math.abs(layout.centerV - ev)).toBeLessThanOrEqual(layout.snap / 2 + 1e-9);
        expect(layout.half).toBeGreaterThanOrEqual(layout.reach + Math.abs(layout.centerU - eu));
        expect(layout.half).toBeGreaterThanOrEqual(layout.reach + Math.abs(layout.centerV - ev));
      }
    }
  });

  it("the reach follows the larger one of the zoom distance and the eye's height over the plane", () => {
    const near = gridLayout({ ...defaultView(), target: [0, 0, 0], distance: 100 }, lens, null);
    expect(near.reach).toBe(REACH_FACTOR * 100);
    // Far above the plane: the height decides.
    const view: ViewState = { target: [0, 0, 5000], azimuth: 0.3, elevation: 0.9, distance: 100 };
    const height = Math.abs(cameraBasis(view).eye[2]);
    expect(height).toBeGreaterThan(100);
    expect(gridLayout(view, lens, null).reach).toBeCloseTo(REACH_FACTOR * height, 6);
  });
});

describe("fade of the grid", () => {
  it("lines that are far apart on the screen are fully drawn, lines that are too close are not drawn at all, in between it is smooth", () => {
    expect(densityFade(DENSE_FULL_PX)).toBe(1);
    expect(densityFade(DENSE_FULL_PX * 10)).toBe(1);
    expect(densityFade(DENSE_NONE_PX)).toBe(0);
    expect(densityFade(0.5)).toBe(0);
    expect(densityFade(Number.NaN)).toBe(0);
    let last = 0;
    for (let px = DENSE_NONE_PX; px <= DENSE_FULL_PX; px += 0.25) {
      const f = densityFade(px);
      expect(f).toBeGreaterThanOrEqual(last - 1e-12);
      last = f;
    }
    // The grid is drawn at its normal zoom: the minor lines are at least 22 px apart there.
    expect(densityFade(22)).toBe(1);
  });

  it("the fade by distance is 1 up to half the reach and 0 at the reach", () => {
    expect(reachFade(0, 1000)).toBe(1);
    expect(reachFade(500, 1000)).toBe(1);
    expect(reachFade(1000, 1000)).toBe(0);
    expect(reachFade(5000, 1000)).toBe(0);
    expect(reachFade(750, 1000)).toBeGreaterThan(0);
    expect(reachFade(750, 1000)).toBeLessThan(1);
    expect(reachFade(10, 0)).toBe(0);
  });
});

describe("line coverage", () => {
  /** What a column of pixels (centres one device pixel apart) adds up to for a line that crosses it at `slope` degrees from the pixel rows. */
  const columnSum = (phase: number, width: number, degrees: number): number => {
    const across = Math.cos((degrees * Math.PI) / 180);
    let sum = 0;
    for (let i = -8; i <= 8; i++) sum += lineCoverage(Math.abs(phase + i) * across, width);
    return sum;
  };
  const phases = Array.from({ length: 100 }, (_, i) => i / 100);

  it("a row of pixels adds up to exactly the line's width wherever the line falls between them: nothing drops out", () => {
    for (const width of [0.3, 0.6, 1, 1.6, 2.2, 3]) {
      for (const phase of phases) expect(columnSum(phase, width, 0)).toBeCloseTo(width, 9);
    }
  });

  it("a tilted line stays unbroken: the ink of a column varies by a few percent at shallow slopes and stays within 13 % at 45 degrees", () => {
    for (const width of [0.6, 1, 1.6]) {
      for (const [degrees, tolerance] of [[5, 0.01], [15, 0.04], [30, 0.1], [45, 0.13]] as const) {
        const expected = width / Math.cos((degrees * Math.PI) / 180);
        for (const phase of phases) expect(Math.abs(columnSum(phase, width, degrees) / expected - 1), `${width} px at ${degrees} degrees, phase ${phase}`).toBeLessThan(tolerance);
      }
    }
  });

  it("a line thinner than one pixel is drawn one pixel wide and paler by the ratio; a wider one has a solid core and a one pixel edge", () => {
    expect(lineCoverage(0, 0.6)).toBeCloseTo(0.6, 12);
    expect(lineCoverage(0.5, 0.6)).toBeCloseTo(0.3, 12);
    expect(lineCoverage(1, 0.6)).toBe(0);
    expect(lineCoverage(0, 1.6)).toBe(1);
    expect(lineCoverage(0.3, 1.6)).toBe(1);
    expect(lineCoverage(0.8, 1.6)).toBeCloseTo(0.5, 12);
    expect(lineCoverage(1.3, 1.6)).toBe(0);
  });

  it("is never above 1, falls off monotonically with the distance and does not depend on the side", () => {
    for (const width of [0.2, 0.6, 1, 1.8, 4]) {
      let last = Infinity;
      for (let d = 0; d <= width / 2 + 1.5; d += 0.05) {
        const c = lineCoverage(d, width);
        expect(c).toBeLessThanOrEqual(1);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(last + 1e-12);
        last = c;
      }
    }
  });
});

describe("pixel footprint on the plane", () => {
  /** What one device pixel covers along u and v, measured by shooting rays through neighbouring pixels. */
  function measured(view: ViewState, frame: Frame3 | null, sx: number, sy: number, pixelRatio: number): [number, number] {
    const origin: Vec3 = frame ? frame.origin : [0, 0, 0];
    const normal: Vec3 = frame ? frame.normal : [0, 0, 1];
    const u: Vec3 = frame ? frame.u : [1, 0, 0];
    const v: Vec3 = frame ? frame.v : [0, 1, 0];
    const at = (x: number, y: number): [number, number] => {
      const hit = rayPlane(screenRay(view, lens, x, y), origin, normal);
      if (!hit) throw new Error("no hit");
      const rel = sub(hit.point, origin);
      return [dot(rel, u), dot(rel, v)];
    };
    // Central differences over a small step (in device pixels), scaled to one device pixel.
    const e = 0.01;
    const h = e / pixelRatio;
    const right = at(sx + h, sy), left = at(sx - h, sy), down = at(sx, sy + h), up = at(sx, sy - h);
    const gu = Math.hypot(right[0] - left[0], down[0] - up[0]) / (2 * e);
    const gv = Math.hypot(right[1] - left[1], down[1] - up[1]) / (2 * e);
    return [gu, gv];
  }

  const views: [string, ViewState][] = [
    ["from above", { target: [0, 0, 0], azimuth: 0.4, elevation: 1.2, distance: 250 }],
    ["default", defaultView()],
    ["grazing", { target: [0, 0, 0], azimuth: 0.7, elevation: 0.12, distance: 300 }],
    ["panned far off", { target: [3000, -2000, 50], azimuth: 2.4, elevation: 0.5, distance: 40 }],
    ["from below", { target: [0, 0, 0], azimuth: 1, elevation: -0.7, distance: 300 }],
  ];

  for (const [name, view] of views) {
    for (const frame of [null, tilted]) {
      for (const pixelRatio of [1, 1.5]) {
        it(`matches the footprint measured with rays (${name}, ${frame ? "tilted plane" : "XY plane"}, ${pixelRatio} device px per CSS px)`, () => {
          const layout = gridLayout(view, lens, frame);
          const camera = gridCamera(view, lens, frame, layout, pixelRatio);
          let checked = 0;
          for (const [sx, sy] of [[600, 400], [100, 700], [1100, 120], [300, 520], [900, 650]] as const) {
            const origin: Vec3 = frame ? frame.origin : [0, 0, 0];
            const normal: Vec3 = frame ? frame.normal : [0, 0, 1];
            const hit = rayPlane(screenRay(view, lens, sx, sy), origin, normal);
            if (!hit) continue;
            const u: Vec3 = frame ? frame.u : [1, 0, 0];
            const v: Vec3 = frame ? frame.v : [0, 1, 0];
            const rel = sub(hit.point, origin);
            const expected = measured(view, frame, sx, sy, pixelRatio);
            const got = pixelFootprint(camera, dot(rel, u) - layout.centerU, dot(rel, v) - layout.centerV);
            expect(got[0] / expected[0]).toBeCloseTo(1, 4);
            expect(got[1] / expected[1]).toBeCloseTo(1, 4);
            checked++;
          }
          expect(checked).toBeGreaterThan(0);
        });
      }
    }
  }

  it("a plane seen exactly edge-on has no footprint", () => {
    const view: ViewState = { target: [0, 0, 0], azimuth: 0, elevation: 0, distance: 300 };
    const layout = gridLayout(view, lens, null);
    const camera = gridCamera(view, lens, null, layout, 1);
    expect(pixelFootprint(camera, 10, 10)[0]).toBe(Infinity);
  });
});
