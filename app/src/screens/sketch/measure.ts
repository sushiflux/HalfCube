// Reads the shown sketch: where a point is and what a dimension would measure right now. This is only for display (the
// value in the box that opens when a dimension is placed, the ghost label that follows the pointer); the engine measures
// the real value when the dimension is added.
import { angleRays, geometryOf, measuredSegment } from "../../document/dimension-label.ts";
import { SKETCH_ORIGIN, type DimensionKind } from "../../document/types.ts";
import type { SketchView } from "../../model/index.ts";
import { angleBetweenDeg, distance, sub, type P } from "./geometry.ts";

export function pointAt(view: SketchView, id: string): P | null {
  if (id === SKETCH_ORIGIN) return [0, 0];
  const p = view.points.find((q) => q.id === id);
  return p ? [p.x, p.y] : null;
}

export function lineEnds(view: SketchView, id: string): [P, P] | null {
  const l = view.lines.find((q) => q.id === id);
  if (!l) return null;
  const a = pointAt(view, l.p1);
  const b = pointAt(view, l.p2);
  return a && b ? [a, b] : null;
}

/** What the dimension would measure now (mm or degrees, always positive for lengths), or null when a reference is gone. */
export function measureDimension(view: SketchView, kind: DimensionKind, refs: readonly string[], reverse?: readonly boolean[]): number | null {
  const [r0, r1] = refs;
  if (r0 === undefined) return null;
  switch (kind) {
    case "distance": {
      // One line, or two of point, line and circle: the length of the segment that is measured.
      const segment = measuredSegment(refs, geometryOf(view));
      return segment && !segment.crossing ? distance(segment.a, segment.b) : null;
    }
    case "distanceX":
    case "distanceY": {
      const a = r1 === undefined ? null : pointAt(view, r0);
      const b = r1 === undefined ? null : pointAt(view, r1);
      if (!a || !b) return null;
      return Math.abs(kind === "distanceX" ? b[0] - a[0] : b[1] - a[1]);
    }
    case "diameter":
    case "radius": {
      const c = view.circles.find((q) => q.id === r0);
      return c ? (kind === "diameter" ? 2 * c.radius : c.radius) : null;
    }
    case "angle": {
      if (r1 === undefined) return null;
      // Between rays (reverse given): 0 to 180 degrees; without it the angle between the line directions, as before.
      if (reverse) {
        const rays = angleRays(refs, reverse, geometryOf(view));
        return rays ? Math.min(rays.sweep, 2 * Math.PI - rays.sweep) * (180 / Math.PI) : null;
      }
      const a = lineEnds(view, r0);
      const b = lineEnds(view, r1);
      return a && b ? angleBetweenDeg(sub(a[1], a[0]), sub(b[1], b[0])) : null;
    }
  }
}

/**
 * Which length a pair of points gets from where the label is held: inside the box of the two points the distance between
 * them, above or below it the horizontal distance, beside it the vertical distance.
 */
export function pointPairKind(a: P, b: P, label: P): "distance" | "distanceX" | "distanceY" {
  const over = (v: number, lo: number, hi: number) => (v > hi ? v - hi : v < lo ? lo - v : 0);
  const overV = over(label[1], Math.min(a[1], b[1]), Math.max(a[1], b[1]));
  const overU = over(label[0], Math.min(a[0], b[0]), Math.max(a[0], b[0]));
  if (overV === 0 && overU === 0) return "distance";
  return overV >= overU ? "distanceX" : "distanceY";
}
