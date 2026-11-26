// Pure helpers of the sketch editor: the solved positions written back into a sketch, and the view the viewport draws
// from a sketch and an engine answer.
import type { SketchSolveResult } from "../engine/generated/protocol.ts";
import { geometryOf, labelPosition } from "../document/dimension-label.ts";
import { formsOf, shapesOf } from "../document/shape-names.ts";
import { isDimension, type SketchData, type SketchFeature } from "../document/types.ts";
import { planeOf } from "./doc-edit.ts";
import type { DragView, SketchView } from "./editors.ts";
import { profileView } from "./payload.ts";

/** The proposed sketch with the solved positions written back (unchanged objects are kept). */
export function applySolved(s: SketchData, r: SketchSolveResult): SketchData {
  const pts = new Map(r.points.map((p) => [p.id, p]));
  const rad = new Map(r.circles.map((c) => [c.id, c.radius]));
  let changed = false;
  const points = s.points.map((p) => {
    const q = pts.get(p.id);
    if (!q || (q.x === p.x && q.y === p.y)) return p;
    changed = true;
    return { ...p, x: q.x, y: q.y };
  });
  const circles = s.circles.map((c) => {
    const radius = rad.get(c.id);
    if (radius === undefined || radius === c.radius) return c;
    changed = true;
    return { ...c, radius };
  });
  return changed ? { ...s, points, circles } : s;
}

export function sketchViewOf(
  feature: SketchFeature,
  sketch: SketchData,
  r: SketchSolveResult,
  preview: boolean,
  payload: ArrayBuffer | null = null,
  drag?: DragView,
): SketchView {
  const state = (id: string) => r.entities[id] ?? "under";
  const cstate = (id: string) => r.constraints[id] ?? "ok";
  const constraints: SketchView["constraints"] = [];
  const dimensions: SketchView["dimensions"] = [];
  // The labels are stored relative to what they measure; the view carries the points they sit at on THIS geometry, so a
  // moved, dragged or re-solved sketch takes its labels along.
  const geometry = geometryOf(sketch);
  for (const c of sketch.constraints) {
    if (isDimension(c)) {
      const measured = r.reference[c.id];
      dimensions.push({
        id: c.id,
        kind: c.kind,
        refs: c.refs,
        ...(c.number !== undefined ? { number: c.number } : {}),
        value: c.value,
        driving: c.driving,
        ...(measured !== undefined ? { measured } : {}),
        ...(c.reverse ? { reverse: c.reverse } : {}),
        label: labelPosition(c.kind, c.refs, c.label, geometry, c.reverse) ?? { x: 0, y: 0 },
        state: cstate(c.id),
      });
    } else {
      constraints.push({ id: c.id, kind: c.kind, refs: c.refs, state: cstate(c.id) });
    }
  }
  return {
    sketchId: feature.id,
    plane: planeOf(feature),
    frame: r.frame,
    points: sketch.points.map((p) => ({ id: p.id, x: p.x, y: p.y, state: state(p.id) })),
    lines: sketch.lines.map((l) => ({ ...l, state: state(l.id) })),
    circles: sketch.circles.map((c) => ({ ...c, state: state(c.id) })),
    constraints,
    dimensions,
    profiles: r.profiles.map((region) => profileView(region, payload, r.entities)),
    dof: r.dof,
    // An engine from before the facts answers without the field.
    freedom: (r as { freedom?: SketchView["freedom"] }).freedom ?? [],
    shapes: shapesOf(sketch),
    forms: formsOf(sketch),
    status: r.status,
    ...(r.problem ? { problem: r.problem } : {}),
    preview,
    ...(drag ? { drag } : {}),
  };
}
