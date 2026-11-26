// Sample sketches of the sketch-mode demo (?demo=viewport&sketch=1): a gallery of every state the layer draws and a stress
// sketch of 200 curves. They are plain SketchView objects shaped like what the model delivers, built without the engine.
import { ShapeUtils, Vector2 } from "three/webgpu";
import type { SketchView } from "../model/editors.ts";
import type { SketchPreview } from "../viewport/index.ts";

type State = "under" | "full" | "over";
type Profile = SketchView["profiles"][number];

const XY_FRAME = { origin: { x: 0, y: 0, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 } };
const PLANES = {
  xy: XY_FRAME,
  xz: { origin: { x: 0, y: 0, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 }, normal: { x: 0, y: -1, z: 0 } },
  yz: { origin: { x: 0, y: 0, z: 0 }, u: { x: 0, y: 1, z: 0 }, v: { x: 0, y: 0, z: 1 }, normal: { x: 1, y: 0, z: 0 } },
} as const;

export type DemoPlane = keyof typeof PLANES;

const ring = (cx: number, cy: number, r: number, n: number, clockwise = false): Float32Array => {
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = ((clockwise ? -i : i) / n) * Math.PI * 2;
    out[i * 2] = cx + r * Math.cos(a);
    out[i * 2 + 1] = cy + r * Math.sin(a);
  }
  return out;
};

/** A region with its outline loops and a triangulated fill (earcut through three's ShapeUtils). */
function region(key: string, outer: Float32Array, holes: Float32Array[], loopsDetermined: boolean[]): Profile {
  const toPoints = (a: Float32Array) => Array.from({ length: a.length / 2 }, (_, i) => new Vector2(a[i * 2], a[i * 2 + 1]));
  // ShapeUtils wants the hole loops as given and returns indices into contour + holes in order.
  const contour = toPoints(outer);
  const holePoints = holes.map(toPoints);
  const triangles = ShapeUtils.triangulateShape(contour, holePoints);
  const all = new Float32Array(outer.length + holes.reduce((n, h) => n + h.length, 0));
  all.set(outer);
  let at = outer.length;
  for (const h of holes) { all.set(h, at); at += h.length; }
  const area = Math.abs(ShapeUtils.area(contour));
  return { key, outer: [], holes: holes.map(() => []), area, determined: loopsDetermined.every(Boolean), loopsDetermined, fill: { positions: all, indices: Uint32Array.from(triangles.flat()) }, loops: [outer, ...holes] };
}

class Builder {
  points: SketchView["points"] = [];
  lines: SketchView["lines"] = [];
  circles: SketchView["circles"] = [];
  constraints: SketchView["constraints"] = [];
  dimensions: SketchView["dimensions"] = [];
  profiles: Profile[] = [];
  private n = 0;
  point(x: number, y: number, state: State): string {
    const id = `p${++this.n}`;
    this.points.push({ id, x, y, state });
    return id;
  }
  line(a: string, b: string, state: State, construction = false): string {
    const id = `l${++this.n}`;
    this.lines.push({ id, p1: a, p2: b, construction, state });
    return id;
  }
  circle(center: string, radius: number, state: State, construction = false): string {
    const id = `c${++this.n}`;
    this.circles.push({ id, center, radius, construction, state });
    return id;
  }
  constraint(kind: SketchView["constraints"][number]["kind"], refs: string[], state: "ok" | "conflicting" = "ok"): void {
    this.constraints.push({ id: `k${++this.n}`, kind, refs, state });
  }
  dimension(kind: SketchView["dimensions"][number]["kind"], refs: string[], value: number, label: [number, number], opts: { driving?: boolean; state?: "ok" | "conflicting" } = {}): string {
    const id = `d${++this.n}`;
    this.dimensions.push({
      id, kind, refs, value: { value, unit: kind === "angle" ? "deg" : "mm" }, driving: opts.driving ?? true,
      ...(opts.driving === false ? { measured: value } : {}), label: { x: label[0], y: label[1] }, state: opts.state ?? "ok",
    });
    return id;
  }
  view(plane: DemoPlane, dof: number): SketchView {
    return {
      sketchId: "demo", plane, frame: PLANES[plane], points: this.points, lines: this.lines, circles: this.circles,
      constraints: this.constraints, dimensions: this.dimensions, profiles: this.profiles, dof, freedom: [], shapes: [], forms: [], status: "solved", preview: false,
    };
  }
}

export interface SketchDemo {
  view: SketchView;
  preview: SketchPreview;
  /** Ids worth selecting in the demo (a line, a point, a dimension, a region). */
  samples: { line: string; point: string; dimension: string; region: string };
}

/** Every state at once: fully constrained with a hole, under-constrained, over-constrained, construction, circles, dimensions. */
export function gallerySketch(plane: DemoPlane = "xy"): SketchDemo {
  const b = new Builder();

  // 1. A fully constrained rectangle with a round hole (a determined region with a hole), dimensions and constraints.
  const a1 = b.point(0, 0, "full"), a2 = b.point(60, 0, "full"), a3 = b.point(60, 40, "full"), a4 = b.point(0, 40, "full");
  const l1 = b.line(a1, a2, "full"), l2 = b.line(a2, a3, "full"), l3 = b.line(a3, a4, "full"), l4 = b.line(a4, a1, "full");
  const hc = b.point(30, 20, "full");
  const hole = b.circle(hc, 8, "full");
  b.constraint("horizontal", [l1]);
  b.constraint("vertical", [l2]);
  b.constraint("horizontal", [l3]);
  b.constraint("vertical", [l4]);
  b.constraint("coincident", [a1, "@origin"]);
  b.dimension("distance", [l1], 60, [30, -14]);
  b.dimension("distance", [l2], 40, [76, 20]);
  const dDia = b.dimension("diameter", [hole], 16, [49, 31]);
  b.profiles.push(region("r-rect", Float32Array.from([0, 0, 60, 0, 60, 40, 0, 40]), [ring(30, 20, 8, 40, true)], [true, true]));
  // Construction lines through the rectangle (dashed).
  b.line(b.point(-10, 20, "under"), b.point(70, 20, "under"), "under", true);
  b.line(b.point(30, -8, "under"), b.point(30, 48, "under"), "under", true);

  // 2. A fully constrained circle (a determined region without a hole) with a radius dimension.
  const cc = b.point(30, -50, "full");
  const circle = b.circle(cc, 14, "full");
  b.dimension("radius", [circle], 14, [48, -62]);
  b.profiles.push(region("r-circle", ring(30, -50, 14, 64), [], [true]));

  // 3. An under-constrained quadrilateral: hollow points, blue lines, a closed loop but no highlight.
  const q = [[100, 0], [150, 6], [146, 44], [104, 38]] as const;
  const qp = q.map(([x, y]) => b.point(x, y, "under"));
  const ql = qp.map((p, i) => b.line(p, qp[(i + 1) % 4]!, "under"));
  b.constraint("parallel", [ql[0]!, ql[2]!]);
  b.dimension("distanceX", [qp[0]!, qp[1]!], 50, [125, -12]);
  b.profiles.push(region("r-quad", Float32Array.from(q.flat()), [], [false]));
  b.dimension("angle", [ql[0]!, ql[1]!], 96, [138, 14], { driving: false });

  // 4. An over-constrained pair: red lines with a conflicting dimension.
  const o1 = b.point(100, -40, "over"), o2 = b.point(140, -40, "over"), o3 = b.point(140, -70, "over");
  const ol1 = b.line(o1, o2, "over"), ol2 = b.line(o2, o3, "over");
  b.constraint("perpendicular", [ol1, ol2], "conflicting");
  b.dimension("distance", [ol1], 40, [120, -30], { state: "conflicting" });

  const view = b.view(plane, 3);
  return {
    view,
    preview: {
      lines: [{ a: [160, -20], b: [188, -4] }, { a: [160, -20], b: [188, -34], construction: true }],
      circles: [{ c: [-30, 20], r: 12 }],
      points: [[188, -4]],
      hints: [{ kind: "horizontal", at: [188, -4] }, { kind: "coincident", at: [160, -20] }, { kind: "tangent", at: [-18, 20] }],
      guides: [{ a: [188, -4], b: [188, 60] }, { a: [150, -4], b: [200, -4] }],
    },
    samples: { line: l3, point: a3, dimension: dDia, region: "r-rect" },
  };
}

/** The stress sketch: 150 lines and 50 circles in a row-by-row layout with mixed states, no dimensions. */
export function stressSketch(plane: DemoPlane = "xy"): SketchDemo {
  const b = new Builder();
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const states: State[] = ["under", "under", "full", "over"];
  for (let i = 0; i < 150; i++) {
    const x = (i % 15) * 22, y = Math.floor(i / 15) * 22;
    const p = b.point(x + rand() * 6, y + rand() * 6, states[i % 4]!);
    const q = b.point(x + 12 + rand() * 6, y + 6 + rand() * 10, states[(i + 1) % 4]!);
    b.line(p, q, states[i % 4]!, i % 11 === 0);
  }
  for (let i = 0; i < 50; i++) {
    const c = b.point((i % 10) * 30 + 8, -30 - Math.floor(i / 10) * 30, states[i % 4]!);
    b.circle(c, 6 + (i % 5) * 2, states[i % 4]!, i % 13 === 0);
  }
  const view = b.view(plane, 100);
  return { view, preview: {}, samples: { line: view.lines[0]!.id, point: view.points[0]!.id, dimension: "", region: "" } };
}

/**
 * Calibration sketch for the pixel tests: four horizontal lines of 80 mm (under-constrained, fully constrained, over-constrained,
 * construction) at v = 10, 22, 34, 46 (clear of the sketch axes) and a row of three points, one of each state. Nothing else is in the way.
 */
export function statesSketch(plane: DemoPlane = "xy"): SketchDemo {
  const b = new Builder();
  const rows: [State, boolean][] = [["under", false], ["full", false], ["over", false], ["under", true]];
  let first = "";
  rows.forEach(([state, construction], i) => {
    const id = b.line(b.point(0, 10 + i * 12, state), b.point(80, 10 + i * 12, state), state, construction);
    if (i === 0) first = id;
  });
  b.point(20, 70, "under");
  b.point(40, 70, "full");
  b.point(60, 70, "over");
  const view = b.view(plane, 3);
  return { view, preview: {}, samples: { line: first, point: view.points[0]!.id, dimension: "", region: "" } };
}
