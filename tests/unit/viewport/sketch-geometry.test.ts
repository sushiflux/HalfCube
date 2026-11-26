import { describe, expect, it } from "vitest";
import { DEFAULT_FOV_Y, type Lens } from "../../../app/src/viewport/camera.ts";
import { bandOfLoop, bandOfLoops, BAND_WIDTH_PX, insideLoops, loopArea } from "../../../app/src/viewport/sketch/band.ts";
import { constraintAnchors, dimensionAnchors, GLYPH_SIZE_PX } from "../../../app/src/viewport/sketch/anchors.ts";
import { ARROW_LENGTH_PX, arrowTriangle, dimensionGraphic, dimensionGraphics, lineIntersection } from "../../../app/src/viewport/sketch/dimensions.ts";
import { frameOfView, makeProjector, viewLookingOnto } from "../../../app/src/viewport/sketch/frame.ts";
import { hintSegments, previewPolylines } from "../../../app/src/viewport/sketch/preview.ts";
import { mergeMeshes, ribbonOfPolyline } from "../../../app/src/viewport/sketch/ribbon.ts";
import { buildScene, curveLineKind, curveSegments, sketchExtent } from "../../../app/src/viewport/sketch/scene.ts";
import { rectangleView } from "./sketch-fixtures.ts";
import type { SketchView } from "../../../app/src/model/editors.ts";

const lens: Lens = { fovY: DEFAULT_FOV_Y, width: 900, height: 600 };

describe("the inner band of a region", () => {
  const square = Float32Array.from([0, 0, 100, 0, 100, 100, 0, 100]); // counter-clockwise

  it("lies inside the contour, one width wide, with its inner edge parallel to it", () => {
    const band = bandOfLoop(square, 6)!;
    const n = band.positions.length / 4;
    expect(n).toBe(4);
    for (let i = 0; i < n; i++) {
      const px = band.positions[i * 4]!, py = band.positions[i * 4 + 1]!, qx = band.positions[i * 4 + 2]!, qy = band.positions[i * 4 + 3]!;
      expect(insideLoops([square], qx, qy)).toBe(true);
      // At the corner of a square the inner corner is 6 mm in from both sides.
      expect(Math.abs(qx - px)).toBeCloseTo(6, 4);
      expect(Math.abs(qy - py)).toBeCloseTo(6, 4);
    }
  });

  it("covers exactly the strip: every triangle lies inside the square, and the area is the strip's area", () => {
    const band = bandOfLoop(square, 6)!;
    let area = 0;
    for (let t = 0; t < band.indices.length; t += 3) {
      const a = band.indices[t]!, b = band.indices[t + 1]!, c = band.indices[t + 2]!;
      const ax = band.positions[a * 2]!, ay = band.positions[a * 2 + 1]!, bx = band.positions[b * 2]!, by = band.positions[b * 2 + 1]!, cx = band.positions[c * 2]!, cy = band.positions[c * 2 + 1]!;
      area += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
      expect(insideLoops([square], (ax + bx + cx) / 3, (ay + by + cy) / 3)).toBe(true);
    }
    expect(area).toBeCloseTo(100 * 100 - 88 * 88, 3);
  });

  it("a hole (clockwise) gets its band outside the hole, in the region", () => {
    const hole = Float32Array.from([40, 40, 40, 60, 60, 60, 60, 40]); // clockwise
    expect(loopArea(hole)).toBeLessThan(0);
    const band = bandOfLoop(hole, 4)!;
    for (let i = 0; i < band.positions.length / 4; i++) {
      expect(insideLoops([hole], band.positions[i * 4 + 2]!, band.positions[i * 4 + 3]!)).toBe(false);
    }
  });

  it("a region with a hole: the whole band lies in the region, never in the hole", () => {
    const hole = Float32Array.from([40, 40, 40, 60, 60, 60, 60, 40]);
    const mesh = bandOfLoops([square, hole], 5);
    for (let t = 0; t < mesh.indices.length; t += 3) {
      let cx = 0, cy = 0;
      for (let k = 0; k < 3; k++) {
        cx += mesh.positions[mesh.indices[t + k]! * 2]! / 3;
        cy += mesh.positions[mesh.indices[t + k]! * 2 + 1]! / 3;
      }
      expect(insideLoops([square, hole], cx, cy), `triangle ${t / 3} is in the region`).toBe(true);
    }
  });

  it("a loop too small for the width is not overrun: the band stays inside", () => {
    const tiny = Float32Array.from([0, 0, 2, 0, 2, 2, 0, 2]);
    const band = bandOfLoop(tiny, 50)!;
    for (let i = 0; i < band.positions.length / 4; i++) {
      const qx = band.positions[i * 4 + 2]!, qy = band.positions[i * 4 + 3]!;
      expect(qx).toBeGreaterThanOrEqual(-1e-6);
      expect(qx).toBeLessThanOrEqual(2 + 1e-6);
      expect(qy).toBeGreaterThanOrEqual(-1e-6);
      expect(qy).toBeLessThanOrEqual(2 + 1e-6);
    }
  });

  it("a circle's loop (many points) gets a closed band", () => {
    const n = 64;
    const loop = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      loop[i * 2] = 20 * Math.cos((i / n) * Math.PI * 2);
      loop[i * 2 + 1] = 20 * Math.sin((i / n) * Math.PI * 2);
    }
    const band = bandOfLoop(loop, 3)!;
    for (let i = 0; i < n; i++) expect(Math.hypot(band.positions[i * 4 + 2]!, band.positions[i * 4 + 3]!)).toBeCloseTo(20 - 3 / Math.cos(Math.PI / n), 1);
    expect(band.indices.length).toBe(n * 6);
  });

  it("the band width constant is six pixels", () => {
    expect(BAND_WIDTH_PX).toBe(6);
  });
});

describe("ribbons", () => {
  it("a line gets a rectangle that reaches half a width beyond both ends", () => {
    const r = ribbonOfPolyline([[0, 0], [10, 0]], false, 1)!;
    const xs = Array.from({ length: r.positions.length / 2 }, (_, i) => r.positions[i * 2]!);
    const ys = Array.from({ length: r.positions.length / 2 }, (_, i) => r.positions[i * 2 + 1]!);
    expect(Math.min(...xs)).toBeCloseTo(-1, 6);
    expect(Math.max(...xs)).toBeCloseTo(11, 6);
    expect(Math.min(...ys)).toBeCloseTo(-1, 6);
    expect(Math.max(...ys)).toBeCloseTo(1, 6);
    expect(r.indices.length).toBe(6);
  });

  it("a closed polyline has no loose end; merging keeps the indices apart", () => {
    const a = ribbonOfPolyline([[0, 0], [10, 0], [10, 10], [0, 10]], true, 0.5)!;
    expect(a.indices.length).toBe(4 * 6);
    const m = mergeMeshes([a, a]);
    expect(m.indices.length).toBe(a.indices.length * 2);
    expect(Math.max(...m.indices)).toBe((a.positions.length / 2) * 2 - 1);
  });

  it("no ribbon for a point", () => {
    expect(ribbonOfPolyline([[1, 1], [1, 1]], false, 1)).toBeNull();
  });
});

describe("dimension graphics", () => {
  const view = rectangleView({ x0: 10, y0: 10, x1: 70, y1: 50 });
  const scene = buildScene(view);
  const mm = 0.25; // 4 px per mm

  it("a length dimension: extension lines, a dimension line at the label's offset, and two arrows on its ends", () => {
    const g = dimensionGraphic(view.dimensions[0]!, scene, mm)!;
    expect(g.arrows).toHaveLength(2);
    // The label is 12 mm below the line l1 (from (10,10) to (70,10)): the dimension line is at v = -2.
    const dim = g.segments[g.segments.length - 1]!;
    expect(dim[0][1]).toBeCloseTo(-2, 6);
    expect(dim[1][1]).toBeCloseTo(-2, 6);
    expect(Math.abs(dim[1][0] - dim[0][0])).toBeCloseTo(60, 6);
    expect(g.segments).toHaveLength(3);
    // The extension lines start a gap away from the geometry and end beyond the dimension line.
    const ext = g.segments[0]!;
    expect(ext[0][1]).toBeCloseTo(10 - 6 * mm, 6);
    expect(ext[1][1]).toBeCloseTo(-2 - 5 * mm, 6);
    // The arrow tips are on the dimension line's ends; the body of each lies towards the other end.
    expect(g.arrows[0]!.tip[0]).toBeCloseTo(10, 6);
    expect(g.arrows[0]!.back[0]).toBeCloseTo(1, 6);
    expect(g.arrows[1]!.back[0]).toBeCloseTo(-1, 6);
  });

  it("the arrowhead is nine pixels long at any scale", () => {
    const g = dimensionGraphic(view.dimensions[0]!, scene, mm)!;
    for (const m of [0.05, 0.25, 3]) {
      const t = arrowTriangle(g.arrows[0]!, m);
      expect(((t[1][0] + t[2][0]) / 2 - t[0][0]) / m).toBeCloseTo(ARROW_LENGTH_PX, 6);
    }
  });

  it("a short dimension puts its arrows outside", () => {
    const g = dimensionGraphic(view.dimensions[0]!, scene, 5)!; // 60 mm are 12 px
    expect(g.arrows[0]!.back[0]).toBeCloseTo(-1, 6);
    expect(g.arrows[1]!.back[0]).toBeCloseTo(1, 6);
  });

  it("horizontal and vertical distances between points follow the label", () => {
    const v = rectangleView({ x0: 10, y0: 10, x1: 70, y1: 50 });
    const dx = dimensionGraphic({ id: "dx", kind: "distanceX", refs: ["p1", "p3"], value: { value: 60, unit: "mm" }, driving: true, label: { x: 40, y: 70 }, state: "ok" }, buildScene(v), mm)!;
    const line = dx.segments[dx.segments.length - 1]!;
    expect(line[0][1]).toBeCloseTo(70, 6);
    expect(line[1][1]).toBeCloseTo(70, 6);
    expect(Math.min(line[0][0], line[1][0])).toBeCloseTo(10, 6);
    expect(Math.max(line[0][0], line[1][0])).toBeCloseTo(70, 6);
    const dy = dimensionGraphic({ id: "dy", kind: "distanceY", refs: ["p1", "p3"], value: { value: 40, unit: "mm" }, driving: true, label: { x: 90, y: 30 }, state: "ok" }, buildScene(v), mm)!;
    const vl = dy.segments[dy.segments.length - 1]!;
    expect(vl[0][0]).toBeCloseTo(90, 6);
    expect(Math.min(vl[0][1], vl[1][1])).toBeCloseTo(10, 6);
    expect(Math.max(vl[0][1], vl[1][1])).toBeCloseTo(50, 6);
  });

  it("a radius and a diameter dimension run through the circle's centre towards the label", () => {
    const v = rectangleView();
    v.circles = [{ id: "c1", center: "p1", radius: 10, construction: false, state: "under" }];
    v.points = v.points.map((p) => (p.id === "p1" ? { ...p, x: 0, y: 0 } : p));
    const s = buildScene(v);
    const r = dimensionGraphic({ id: "dr", kind: "radius", refs: ["c1"], value: { value: 10, unit: "mm" }, driving: true, label: { x: 20, y: 0 }, state: "ok" }, s, mm)!;
    expect(r.arrows).toHaveLength(1);
    expect(r.arrows[0]!.tip[0]).toBeCloseTo(10, 6);
    const d = dimensionGraphic({ id: "dd", kind: "diameter", refs: ["c1"], value: { value: 20, unit: "mm" }, driving: true, label: { x: 0, y: 15 }, state: "ok" }, s, mm)!;
    const ys = d.arrows.map((a) => a.tip[1]).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(-10, 6);
    expect(ys[1]).toBeCloseTo(10, 6);
  });

  it("an angle dimension is an arc around the corner between the two lines, with an arrow at each end", () => {
    const v = rectangleView({ x0: 0, y0: 0, x1: 50, y1: 30 });
    const g = dimensionGraphic({ id: "da", kind: "angle", refs: ["l1", "l2"], value: { value: 90, unit: "deg" }, driving: true, label: { x: 40, y: 10 }, state: "ok" }, buildScene(v), mm)!;
    expect(g.arrows).toHaveLength(2);
    // l1 and l2 meet at (50, 0); the arc radius is the distance of the label from the corner.
    const r = Math.hypot(40 - 50, 10 - 0);
    for (const a of g.arrows) expect(Math.hypot(a.tip[0] - 50, a.tip[1] - 0)).toBeCloseTo(r, 6);
  });

  it("a dimension that refers to something that is gone is left out", () => {
    const list = dimensionGraphics([{ id: "dx", kind: "distance", refs: ["l99"], value: { value: 1, unit: "mm" }, driving: true, label: { x: 0, y: 0 }, state: "ok" }, ...view.dimensions], scene, mm);
    expect(list.map((g) => g.id)).toEqual(["d1", "d2"]);
  });

  it("conflicting and redundant dimensions are reported as problems", () => {
    expect(dimensionGraphic({ ...view.dimensions[0]!, state: "conflicting" }, scene, mm)!.problem).toBe(true);
    expect(dimensionGraphic(view.dimensions[0]!, scene, mm)!.problem).toBe(false);
  });

  it("lines meet where they should", () => {
    expect(lineIntersection({ a: [0, 0], b: [1, 0] }, { a: [5, -1], b: [5, 1] })).toEqual([5, 0]);
    expect(lineIntersection({ a: [0, 0], b: [1, 0] }, { a: [0, 1], b: [3, 1] })).toBeNull();
  });
});

describe("scene and styles of the curves", () => {
  it("curves are drawn by their solver state; construction geometry has its own kind", () => {
    expect(curveLineKind(false, "under")).toBe("sketchUnder");
    expect(curveLineKind(false, "full")).toBe("sketchFull");
    expect(curveLineKind(false, "over")).toBe("sketchOver");
    expect(curveLineKind(true, "full")).toBe("construction");
  });

  it("one segment buffer per kind in use, owned by the curve index", () => {
    const v = rectangleView({ state: "full" });
    v.lines = v.lines.map((l, i) => (i === 3 ? { ...l, construction: true, state: "under" as const } : l));
    const segs = curveSegments(frameOfView(v), buildScene(v));
    expect(segs.map((s) => s.kind)).toEqual(["construction", "sketchFull"]);
    expect(segs[0]!.buffers.segmentCount).toBe(1);
    expect(segs[1]!.buffers.segmentCount).toBe(3);
    expect(Array.from(segs[0]!.buffers.owners)).toEqual([3]);
  });

  it("the extent covers points and circles", () => {
    const v = rectangleView({ x0: 10, y0: 10, x1: 70, y1: 50 });
    v.circles = [{ id: "c1", center: "p1", radius: 30, construction: false, state: "under" }];
    expect(sketchExtent(buildScene(v))).toEqual({ min: [-20, -20], max: [70, 50] });
    expect(sketchExtent(buildScene({ ...v, points: [], lines: [], circles: [] }))).toBeNull();
  });
});

describe("anchors for the HTML overlays", () => {
  const view = rectangleView({ x0: 10, y0: 10, x1: 70, y1: 50 });
  const frame = frameOfView(view);
  const proj = makeProjector(viewLookingOnto(frame, { target: [40, 30, 0], azimuth: 0, elevation: 0, distance: 160 }, [40, 30, 0]), lens, frame);
  const scene = buildScene(view);
  const dims = dimensionGraphics(view.dimensions, scene, proj.mmPerPx);
  const bounds = { width: lens.width, height: lens.height };

  it("dimension anchors sit at the labels, with an upright text angle", () => {
    const a = dimensionAnchors(dims, proj);
    expect(a.map((x) => x.id)).toEqual(["d1", "d2"]);
    const label = proj.toScreen(40, -2)!;
    expect(a[0]!.x).toBeCloseTo(label.x, 6);
    expect(a[0]!.y).toBeCloseTo(label.y, 6);
    for (const x of a) {
      expect(x.angle!).toBeGreaterThan(-Math.PI / 2 - 1e-9);
      expect(x.angle!).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
    }
    expect(a[0]!.angle!).toBeCloseTo(0, 6); // horizontal
    expect(Math.abs(a[1]!.angle!)).toBeCloseTo(Math.PI / 2, 6); // vertical
  });

  it("every constraint gets an anchor beside its entity and no two glyphs overlap", () => {
    const many: SketchView["constraints"] = [];
    for (let i = 0; i < 12; i++) many.push({ id: `h${i}`, kind: "horizontal", refs: ["l1"], state: "ok" });
    const anchors = constraintAnchors([...view.constraints, ...many], scene, dims, proj, bounds);
    expect(anchors.length).toBe(view.constraints.length + 12);
    for (let i = 0; i < anchors.length; i++) {
      for (let j = i + 1; j < anchors.length; j++) {
        const overlap = Math.abs(anchors[i]!.x - anchors[j]!.x) < GLYPH_SIZE_PX && Math.abs(anchors[i]!.y - anchors[j]!.y) < GLYPH_SIZE_PX;
        expect(overlap, `${anchors[i]!.id} and ${anchors[j]!.id}`).toBe(false);
      }
    }
    // A horizontal constraint sits above its line (smaller y on the screen), close to its middle.
    const k1 = anchors.find((a) => a.id === "k1")!;
    const mid = proj.toScreen(40, 10)!;
    expect(k1.y).toBeLessThan(mid.y);
    expect(Math.abs(k1.x - mid.x)).toBeLessThan(30);
  });

  it("no glyph lies on a dimension label", () => {
    const anchors = constraintAnchors(view.constraints, scene, dims, proj, bounds);
    for (const d of dimensionAnchors(dims, proj)) for (const a of anchors) expect(Math.abs(a.x - d.x) < 40 && Math.abs(a.y - d.y) < 22).toBe(false);
  });

  it("two-curve constraints get two anchors (the second has the id with #2); the same input gives the same places", () => {
    const parallel: SketchView["constraints"] = [{ id: "kp", kind: "parallel", refs: ["l1", "l3"], state: "ok" }];
    const a = constraintAnchors(parallel, scene, dims, proj, bounds);
    expect(a.map((x) => x.id)).toEqual(["kp", "kp#2"]);
    expect(constraintAnchors(parallel, scene, dims, proj, bounds)).toEqual(a);
  });

  it("a constraint whose entities are gone has no anchor", () => {
    const gone: SketchView["constraints"] = [{ id: "kx", kind: "horizontal", refs: ["l99"], state: "ok" }];
    expect(constraintAnchors(gone, scene, dims, proj, bounds)).toEqual([]);
  });
});

describe("tool preview geometry", () => {
  it("splits rubber band lines from construction lines; a circle is one closed polyline", () => {
    const p = previewPolylines({ lines: [{ a: [0, 0], b: [1, 1] }, { a: [0, 0], b: [2, 2], construction: true }], circles: [{ c: [0, 0], r: 5 }] });
    expect(p.solid).toHaveLength(2);
    expect(p.construction).toHaveLength(1);
    const ring = p.solid[1]!;
    expect(ring[0]![0]).toBeCloseTo(ring[ring.length - 1]![0], 6);
  });

  it("hints are drawn a fixed number of pixels big, whatever the zoom", () => {
    const hint = { kind: "horizontal" as const, at: [10, 10] as [number, number] };
    const a = hintSegments([hint], 0.1), b = hintSegments([hint], 1);
    expect(a.length).toBe(b.length);
    const span = (s: ReturnType<typeof hintSegments>, mm: number) => {
      const xs = s.flatMap((x) => [x[0][0], x[1][0]]);
      return (Math.max(...xs) - Math.min(...xs)) / mm;
    };
    expect(span(a, 0.1)).toBeCloseTo(span(b, 1), 6);
  });

  it("every hint kind has strokes", () => {
    for (const kind of ["horizontal", "vertical", "coincident", "onCurve", "tangent", "perpendicular", "parallel"] as const) {
      expect(hintSegments([{ kind, at: [0, 0] }], 1).length).toBeGreaterThan(0);
    }
  });
});
