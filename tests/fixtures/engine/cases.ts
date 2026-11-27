// A fixed set of sketch.solve and model.sync requests. The contract tests run them against the native engine and
// compare the answers with the recorded ones (tests/fixtures/engine/record.ts); the replay stub plays the same recordings for UI work without an engine.
import type {
  Dimension,
  GeometricConstraint,
  HalfCubeDocument,
  Quantity,
  SketchCircle,
  SketchData,
  SketchLine,
  SketchPoint,
} from "../../../app/src/document/types.ts";
import type { CommandInput } from "../../../app/src/engine/client.ts";

export const mmQ = (value: number): Quantity => ({ value, unit: "mm" });
export const degQ = (value: number): Quantity => ({ value, unit: "deg" });
const point = (id: string, x: number, y: number): SketchPoint => ({ id, x, y });
const line = (id: string, p1: string, p2: string): SketchLine => ({ id, p1, p2, construction: false });
const circle = (id: string, center: string, radius: number): SketchCircle => ({ id, center, radius, construction: false });
const constraint = (id: string, kind: GeometricConstraint["kind"], refs: string[]): GeometricConstraint => ({ id, kind, refs });
const dimension = (id: string, kind: Dimension["kind"], refs: string[], value: Quantity, driving = true): Dimension => ({
  id,
  kind,
  refs,
  value,
  driving,
  label: { x: 0, y: 0 },
});

/** Rectangle p1..p4 / l1..l4, slightly off 60 x 40 so the solver has work; steps 0..3 add constraints (DOF 8, 4, 2, 0). */
export function rectangle(steps = 3, width = 60, height = 40): SketchData {
  const s: SketchData = {
    points: [point("p1", 0.5, -0.3), point("p2", 61, 0.2), point("p3", 59, 41), point("p4", -0.4, 39)],
    lines: [line("l1", "p1", "p2"), line("l2", "p2", "p3"), line("l3", "p3", "p4"), line("l4", "p4", "p1")],
    circles: [],
    constraints: [],
  };
  if (steps >= 1) {
    s.constraints.push(
      constraint("k1", "horizontal", ["l1"]),
      constraint("k2", "horizontal", ["l3"]),
      constraint("k3", "vertical", ["l2"]),
      constraint("k4", "vertical", ["l4"]),
    );
  }
  if (steps >= 2) s.constraints.push(dimension("d1", "distance", ["l1"], mmQ(width)), dimension("d2", "distance", ["l2"], mmQ(height)));
  if (steps >= 3) s.constraints.push(constraint("k5", "coincident", ["p1", "@origin"]));
  return s;
}

/** The rectangle with a fixed circle (radius 5 at 20, 20) inside: regions "c1" and "l1,l2,l3,l4|c1". */
export function rectangleWithHole(): SketchData {
  const s = rectangle(3);
  s.points.push(point("pc", 20, 20));
  s.circles.push(circle("c1", "pc", 5));
  s.constraints.push(constraint("k6", "fix", ["pc"]), dimension("d3", "radius", ["c1"], mmQ(5)));
  return s;
}

/** A circle of diameter 30 at the origin. */
export function disc(): SketchData {
  return {
    points: [point("m", 1, -1)],
    lines: [],
    circles: [circle("c1", "m", 12)],
    constraints: [constraint("k1", "coincident", ["m", "@origin"]), dimension("d1", "diameter", ["c1"], mmQ(30))],
  };
}

/** Circles, fix, equal, pointOnCurve, distanceX and an angle against the u axis; fully defined. */
export function mixed(): SketchData {
  return {
    points: [point("o", 1, 1), point("q", 10, 3), point("e", 30, 5)],
    lines: [line("n1", "q", "e")],
    circles: [circle("c1", "o", 4), circle("c2", "q", 7)],
    constraints: [
      constraint("k1", "fix", ["o"]),
      dimension("d1", "diameter", ["c1"], mmQ(10)),
      constraint("k2", "equal", ["c1", "c2"]),
      dimension("d2", "distanceX", ["o", "q"], mmQ(3)),
      constraint("k3", "pointOnCurve", ["q", "c1"]),
      dimension("d3", "angle", ["@axisU", "n1"], degQ(30)),
      dimension("d4", "distance", ["n1"], mmQ(25)),
    ],
  };
}

/**
 * Forty rectangles with a circle in each (200 curves, 80 regions), every one fully determined except the last
 * rectangle, which is free to move (so a point of it can be dragged): the stress sketch of the speed measurements.
 */
export function stress(count = 40): SketchData {
  const s: SketchData = { points: [], lines: [], circles: [], constraints: [] };
  let k = 0;
  for (let i = 0; i < count; i++) {
    const ox = (i % 8) * 30;
    const oy = Math.floor(i / 8) * 30;
    const p = (name: string) => `p${i}_${name}`;
    const l = (name: string) => `l${i}_${name}`;
    s.points.push(
      point(p("1"), ox + 0.1, oy - 0.1),
      point(p("2"), ox + 20.2, oy + 0.1),
      point(p("3"), ox + 19.9, oy + 20.1),
      point(p("4"), ox - 0.2, oy + 19.8),
      point(p("c"), ox + 10.3, oy + 10.2),
    );
    s.lines.push(line(l("1"), p("1"), p("2")), line(l("2"), p("2"), p("3")), line(l("3"), p("3"), p("4")), line(l("4"), p("4"), p("1")));
    s.circles.push(circle(`c${i}`, p("c"), 4));
    s.constraints.push(
      constraint(`k${++k}`, "horizontal", [l("1")]),
      constraint(`k${++k}`, "horizontal", [l("3")]),
      constraint(`k${++k}`, "vertical", [l("2")]),
      constraint(`k${++k}`, "vertical", [l("4")]),
      dimension(`d${++k}`, "distance", [l("1")], mmQ(20)),
      dimension(`d${++k}`, "distance", [l("2")], mmQ(20)),
      constraint(`k${++k}`, "fix", [p("c")]),
      dimension(`d${++k}`, "diameter", [`c${i}`], mmQ(8)),
    );
    if (i < count - 1) s.constraints.push(constraint(`k${++k}`, "fix", [p("1")]));
  }
  return s;
}

/** A chain of links in a row along u, the first point fixed, every link a driving length (the solver test's P04). */
export function chain(links = 40, length = 5): SketchData {
  const s: SketchData = { points: [], lines: [], circles: [], constraints: [] };
  for (let i = 0; i <= links; i++) s.points.push(point(`q${i}`, i * length, 0));
  for (let i = 0; i < links; i++) {
    s.lines.push(line(`m${i}`, `q${i}`, `q${i + 1}`));
    s.constraints.push(dimension(`e${i}`, "distance", [`m${i}`], mmQ(length)));
  }
  s.constraints.push(constraint("kf", "fix", ["q0"]));
  return s;
}

export function document(
  sketch: SketchData,
  extrude: { extent?: "oneSide" | "symmetric"; distance?: number; region?: string; plane?: "xy" | "xz" | "yz" } = {},
): HalfCubeDocument {
  return {
    format: 1,
    documentId: "doc-fixture",
    settings: { lengthUnit: "mm" },
    nextId: 100,
    parameters: [],
    components: [{ id: "root", name: "Teil", bodies: [{ id: "b1", name: "Körper1", createdBy: "f2", visible: true }] }],
    timeline: [
      { id: "f1", type: "sketch", name: "Skizze1", component: "root", visible: true, plane: { kind: "originPlane", plane: extrude.plane ?? "xy" }, sketch },
      {
        id: "f2",
        type: "extrude",
        name: "Extrusion1",
        component: "root",
        profile: { sketch: "f1", region: extrude.region ?? "l1,l2,l3,l4" },
        extent: extrude.extent ?? "oneSide",
        distance: mmQ(extrude.distance ?? 10),
        operation: "newBody",
        body: "b1",
      },
    ],
  };
}

export type SolveCommand = Extract<CommandInput, { type: "sketch.solve" }>;
export type SyncCommand = Extract<CommandInput, { type: "model.sync" }>;

const solve = (sketch: SketchData, extra: Partial<SolveCommand> = {}): SolveCommand => ({
  type: "sketch.solve",
  sketch,
  plane: { kind: "originPlane", plane: "xy" },
  ...extra,
});

const sync = (document: HalfCubeDocument, extra: Partial<SyncCommand> = {}): SyncCommand => ({
  type: "model.sync",
  revision: 1,
  document,
  purpose: "commit",
  ...extra,
});

function conflicting(driving: boolean): SketchData {
  const s = rectangle(3);
  s.constraints.push(dimension("d3", "distance", ["l3"], mmQ(50), driving));
  return s;
}

export interface EngineCase {
  name: string;
  command: SolveCommand | SyncCommand;
}

/** Every recorded case. Names are file names in tests/fixtures/engine/. */
export const ENGINE_CASES: EngineCase[] = [
  // What the sketch editor sends: element states and regions with every solve.
  { name: "solve-rectangle-0", command: solve(rectangle(0), { profiles: true }) },
  { name: "solve-rectangle-1", command: solve(rectangle(1), { profiles: true }) },
  { name: "solve-rectangle-2", command: solve(rectangle(2), { profiles: true }) },
  { name: "solve-rectangle-3", command: solve(rectangle(3), { profiles: true }) },
  { name: "solve-conflict", command: solve(conflicting(true), { profiles: true }) },
  { name: "solve-reference", command: solve(conflicting(false), { profiles: true }) },
  { name: "solve-mixed", command: solve(mixed(), { profiles: true }) },
  { name: "solve-profiles-hole", command: solve(rectangleWithHole(), { profiles: true }) },
  // Drag steps: a free corner, a corner of a fully determined sketch (does not move), a rectangle with sizes that moves as a whole.
  { name: "solve-drag-free", command: solve(rectangle(1), { profiles: true, drag: { points: [{ id: "p3", x: 70, y: 55 }] } }) },
  { name: "solve-drag-fixed", command: solve(rectangle(3), { profiles: true, drag: { points: [{ id: "p3", x: 100, y: 100 }] } }) },
  { name: "solve-drag-sizes", command: solve(rectangle(2), { profiles: true, drag: { points: [{ id: "p3", x: 100, y: 80 }] } }) },
  { name: "solve-profiles-rectangle-xz", command: solve(rectangle(3), { profiles: true, plane: { kind: "originPlane", plane: "xz" } }) },
  { name: "sync-rectangle", command: sync(document(rectangle(3))) },
  { name: "sync-disc-xz", command: sync(document(disc(), { plane: "xz", region: "c1", distance: 5 })) },
  { name: "sync-hole-symmetric", command: sync(document(rectangleWithHole(), { region: "l1,l2,l3,l4|c1", extent: "symmetric" })) },
  { name: "sync-rectangle-preview", command: sync(document(rectangle(3), { distance: -20 }), { purpose: "preview", previewFeatures: ["f2"] }) },
];
