// "Go to the element": pan to the middle, zoom out only when the elements do not fit, in only when they would be tiny, never turn.
import { describe, expect, it } from "vitest";
import { DEFAULT_FOV_Y, pixelsPerWorld, type Lens, type ViewState } from "../../../app/src/viewport/camera.ts";
import type { Bounds } from "../../../app/src/viewport/math.ts";
import { focusedView } from "../../../app/src/viewport/sketch/frame.ts";

const lens: Lens = { fovY: DEFAULT_FOV_Y, width: 1000, height: 600 };
// Looking straight down onto the XY plane from 300 mm, as a sketch is shown.
const view: ViewState = { target: [0, 0, 0], azimuth: -Math.PI / 2, elevation: Math.PI / 2 - 1e-6, distance: 300 };
const box = (u0: number, v0: number, u1: number, v1: number): Bounds => ({ min: [u0, v0, 0], max: [u1, v1, 0] });
/** The share of the view's width the width of the box takes at that distance. */
const share = (distance: number, width: number) => (pixelsPerWorld(lens, distance) * width) / lens.width;

describe("focusedView", () => {
  it("pans to the middle of the elements and keeps the zoom and the orientation when they fit well", () => {
    const next = focusedView(view, lens, box(100, 50, 160, 90));
    expect(next.target[0]).toBeCloseTo(130, 6);
    expect(next.target[1]).toBeCloseTo(70, 6);
    expect(next.distance).toBe(view.distance);
    expect(next.azimuth).toBe(view.azimuth);
    expect(next.elevation).toBe(view.elevation);
  });

  it("zooms out when they would not fit in the view, to about 80 % of it", () => {
    const next = focusedView(view, lens, box(-600, -400, 600, 400));
    expect(next.distance).toBeGreaterThan(view.distance);
    expect(share(next.distance, 1200)).toBeLessThan(1);
  });

  it("zooms in when they would be tiny (under 5 % of the view), to about a third of it", () => {
    expect(share(view.distance, 6)).toBeLessThan(0.05);
    const next = focusedView(view, lens, box(10, 10, 16, 14));
    expect(next.distance).toBeLessThan(view.distance);
    const after = share(next.distance, 6);
    expect(after).toBeGreaterThan(0.15);
    expect(after).toBeLessThan(0.5);
  });

  it("leaves the zoom alone in between (5 to 85 % of the view)", () => {
    expect(share(view.distance, 100)).toBeGreaterThan(0.05);
    expect(share(view.distance, 100)).toBeLessThan(0.85);
    expect(focusedView(view, lens, box(0, 0, 100, 40)).distance).toBe(view.distance);
  });
});
