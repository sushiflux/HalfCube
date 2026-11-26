import { describe, expect, it } from "vitest";
import { DEFAULT_FOV_Y, type Lens, type ViewState } from "../../../app/src/viewport/camera.ts";
import { dimensionGraphics } from "../../../app/src/viewport/sketch/dimensions.ts";
import { frameOfView, makeProjector, viewLookingOnto } from "../../../app/src/viewport/sketch/frame.ts";
import { pickSketch, type PickContext } from "../../../app/src/viewport/sketch/pick.ts";
import { buildScene } from "../../../app/src/viewport/sketch/scene.ts";
import type { SketchView } from "../../../app/src/model/editors.ts";
import { rectangleProfile, rectangleView } from "./sketch-fixtures.ts";

const lens: Lens = { fovY: DEFAULT_FOV_Y, width: 900, height: 600 };

function context(view: SketchView, cam?: Partial<ViewState>): { ctx: PickContext; screen: (u: number, v: number) => { x: number; y: number } } {
  const frame = frameOfView(view);
  const looking = viewLookingOnto(frame, { target: [30, 20, 0], azimuth: 0, elevation: 0, distance: 160 }, [30, 20, 0]);
  const projector = makeProjector({ ...looking, ...cam }, lens, frame);
  const scene = buildScene(view);
  return {
    ctx: { scene, dimensions: dimensionGraphics(view.dimensions, scene, projector.mmPerPx), profiles: view.profiles, projector },
    screen: (u, v) => projector.toScreen(u, v)!,
  };
}

describe("picking in the sketch", () => {
  const view = rectangleView({ x0: 10, y0: 10, x1: 70, y1: 50, withDimensions: false });

  it("a point wins over the line it lies on", () => {
    const { ctx, screen } = context(view);
    const p = screen(10, 10);
    expect(pickSketch(ctx, p.x + 2, p.y + 1)).toEqual({ kind: "point", id: "p1" });
  });

  it("a line is picked within the tolerance, and answers the nearest point on it in sketch coordinates", () => {
    const { ctx, screen } = context(view);
    const m = screen(40, 10);
    const hit = pickSketch(ctx, m.x, m.y + 4)!;
    expect(hit.kind).toBe("line");
    if (hit.kind !== "line") return;
    expect(hit.id).toBe("l1");
    expect(hit.u).toBeCloseTo(40, 1);
    expect(hit.v).toBeCloseTo(10, 6);
    expect(pickSketch(ctx, m.x, m.y + 9, 6)).not.toMatchObject({ kind: "line" });
    expect(pickSketch(ctx, m.x, m.y + 9, 12)).toMatchObject({ kind: "line", id: "l1" });
  });

  it("the nearest of two lines wins near a corner", () => {
    const { ctx, screen } = context(view);
    const c = screen(10, 30);
    expect(pickSketch(ctx, c.x + 1, c.y)).toMatchObject({ kind: "line", id: "l4" });
  });

  it("a circle is picked on its rim with the point on it", () => {
    const v = rectangleView({ withDimensions: false });
    v.circles = [{ id: "c1", center: "p1", radius: 20, construction: false, state: "under" }];
    v.points = v.points.map((p) => (p.id === "p1" ? { ...p, x: 30, y: 20 } : p));
    v.profiles = [];
    const { ctx, screen } = context(v);
    const rim = screen(50, 20);
    const hit = pickSketch(ctx, rim.x - 3, rim.y + 2)!;
    expect(hit).toMatchObject({ kind: "circle", id: "c1" });
    const rimPoint = hit as { u: number; v: number };
    expect(Math.hypot(rimPoint.u - 30, rimPoint.v - 20)).toBeCloseTo(20, 1);
  });

  it("the inside of a closed loop is its region, the hole is not", () => {
    const v = rectangleView({ x0: 0, y0: 0, x1: 100, y1: 80, determined: true, withDimensions: false });
    v.profiles = [rectangleProfile("r1", 0, 0, 100, 80, true, [{ x: 50, y: 40, r: 15 }])];
    const { ctx, screen } = context(v, { distance: 300 });
    const inside = screen(20, 40);
    expect(pickSketch(ctx, inside.x, inside.y)).toEqual({ kind: "region", key: "r1" });
    const hole = screen(50, 40);
    expect(pickSketch(ctx, hole.x, hole.y)).toBeNull();
  });

  it("of nested regions the smaller one wins", () => {
    const v = rectangleView({ x0: 0, y0: 0, x1: 100, y1: 80, withDimensions: false });
    v.profiles = [rectangleProfile("big", 0, 0, 100, 80, true), rectangleProfile("small", 30, 20, 60, 50, true)];
    const { ctx, screen } = context(v, { distance: 300 });
    const p = screen(45, 35);
    expect(pickSketch(ctx, p.x, p.y)).toEqual({ kind: "region", key: "small" });
  });

  it("the origin and the two axes come last", () => {
    const v = rectangleView({ x0: 40, y0: 40, x1: 90, y1: 80, withDimensions: false });
    v.profiles = [];
    const { ctx, screen } = context(v);
    const o = screen(0, 0);
    expect(pickSketch(ctx, o.x + 3, o.y - 2)).toEqual({ kind: "origin" });
    const onU = screen(-20, 0);
    expect(pickSketch(ctx, onU.x, onU.y + 3)).toEqual({ kind: "axis", axis: "u" });
    const onV = screen(0, -30);
    expect(pickSketch(ctx, onV.x - 3, onV.y)).toEqual({ kind: "axis", axis: "v" });
    const away = screen(-30, -30);
    expect(pickSketch(ctx, away.x, away.y)).toBeNull();
  });

  it("a dimension is picked on its label box, before what lies under it", () => {
    const v = rectangleView({ x0: 10, y0: 10, x1: 70, y1: 50 });
    v.profiles = [];
    const { ctx, screen } = context(v);
    expect(ctx.dimensions.map((d) => d.id)).toEqual(["d1", "d2"]);
    const label = screen(40, -2);
    expect(pickSketch(ctx, label.x + 20, label.y)).toEqual({ kind: "dimension", id: "d1" });
    // A pixel on the line l1 itself, away from every dimension line and label, still gives the line.
    const onLine = screen(25, 10);
    expect(pickSketch(ctx, onLine.x, onLine.y)).toMatchObject({ kind: "line", id: "l1" });
  });

  it("nothing in an empty area", () => {
    const { ctx } = context(view);
    expect(pickSketch(ctx, 5, 5)).toBeNull();
  });
});
