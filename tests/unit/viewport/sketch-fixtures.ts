// Sketch views for the tests of the sketch layer: plain objects shaped like the model's SketchView.
import type { SketchView } from "../../../app/src/model/editors.ts";

type EntityState = "under" | "full" | "over";
export type Plane = "xy" | "xz" | "yz";

const frames = {
  xy: { origin: { x: 0, y: 0, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
  xz: { origin: { x: 0, y: 0, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 }, normal: { x: 0, y: -1, z: 0 } },
  yz: { origin: { x: 0, y: 0, z: 0 }, u: { x: 0, y: 1, z: 0 }, v: { x: 0, y: 0, z: 1 }, normal: { x: 1, y: 0, z: 0 } },
} as const;

export function frameOf(plane: Plane) {
  return frames[plane];
}

/** Two-triangle fill and the loop of an axis-aligned rectangle (counter-clockwise). */
export function rectangleProfile(key: string, x0: number, y0: number, x1: number, y1: number, determined: boolean, holes: { x: number; y: number; r: number }[] = [], loopsDetermined?: boolean[]): SketchView["profiles"][number] {
  const outer = Float32Array.from([x0, y0, x1, y0, x1, y1, x0, y1]);
  const loops: Float32Array[] = [outer];
  for (const h of holes) {
    const pts: number[] = [];
    // A hole runs clockwise.
    for (let i = 0; i < 24; i++) pts.push(h.x + h.r * Math.cos(-(i / 24) * Math.PI * 2), h.y + h.r * Math.sin(-(i / 24) * Math.PI * 2));
    loops.push(Float32Array.from(pts));
  }
  return {
    key,
    outer: ["l1", "l2", "l3", "l4"],
    holes: holes.map(() => ["c1"]),
    area: (x1 - x0) * (y1 - y0),
    determined,
    // Per loop (outer first, then the holes); by default every loop has the state of the whole region.
    loopsDetermined: loopsDetermined ?? loops.map(() => determined),
    fill: { positions: outer, indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) },
    loops,
  };
}

export interface RectOptions {
  plane?: Plane;
  state?: EntityState;
  x0?: number;
  y0?: number;
  x1?: number;
  y1?: number;
  determined?: boolean;
  construction?: boolean;
  withDimensions?: boolean;
  drag?: SketchView["drag"];
}

/** A rectangle of four points and four lines with a horizontal and a vertical constraint on two lines and two dimensions. */
export function rectangleView(o: RectOptions = {}): SketchView {
  const { plane = "xy", state = "under", x0 = 0, y0 = 0, x1 = 60, y1 = 40, determined = state === "full" } = o;
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const points = pts.map((p, i) => ({ id: `p${i + 1}`, x: p[0]!, y: p[1]!, state }));
  const lines = [0, 1, 2, 3].map((i) => ({ id: `l${i + 1}`, p1: `p${i + 1}`, p2: `p${((i + 1) % 4) + 1}`, construction: o.construction ?? false, state }));
  return {
    sketchId: "s1",
    plane: plane === "xy" ? "xy" : plane === "xz" ? "xz" : "yz",
    frame: frames[plane],
    points,
    lines,
    circles: [],
    constraints: [
      { id: "k1", kind: "horizontal", refs: ["l1"], state: "ok" },
      { id: "k2", kind: "vertical", refs: ["l2"], state: "ok" },
      { id: "k3", kind: "coincident", refs: ["p1", "@origin"], state: "ok" },
    ],
    dimensions: o.withDimensions === false ? [] : [
      { id: "d1", kind: "distance", refs: ["l1"], value: { value: x1 - x0, unit: "mm" }, driving: true, label: { x: (x0 + x1) / 2, y: y0 - 12 }, state: "ok" },
      { id: "d2", kind: "distance", refs: ["l2"], value: { value: y1 - y0, unit: "mm" }, driving: true, label: { x: x1 + 14, y: (y0 + y1) / 2 }, state: "ok" },
    ],
    profiles: [rectangleProfile("r1", x0, y0, x1, y1, determined)],
    dof: state === "full" ? 0 : 3,
    status: "solved",
    preview: false,
    ...(o.drag ? { drag: o.drag } : {}),
  } as unknown as SketchView;
}
