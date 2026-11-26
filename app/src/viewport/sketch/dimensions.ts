// Dimension graphics: extension lines, the dimension line or arc, and arrowheads, in sketch coordinates. The value text and
// the input box are HTML of the UI and sit at the label point (dimensionAnchors). Sizes that must look the same at every
// zoom (the gap to the geometry, the overshoot of the extension lines, the arrowheads) are given in pixels and turned into
// mm with the current scale, so the graphics are rebuilt when the zoom changes. Pure functions, tested in Node.
import { angleRays, measuredSegment } from "../../document/dimension-label.ts";
import type { SketchDimensionView } from "../../model/editors.ts";
import type { SketchScene, UV } from "./scene.ts";
import type { LiveDimension } from "./types.ts";

export const GAP_PX = 6;
export const OVERSHOOT_PX = 5;
export const ARROW_LENGTH_PX = 9;
export const ARROW_HALF_WIDTH_PX = 3.4;
/** Below this many pixels between its two ends a dimension puts its arrows outside. */
export const INSIDE_ARROWS_MIN_PX = 26;
const OUTSIDE_STUB_PX = 14;

export type Seg = readonly [UV, UV];

export interface Arrow {
  /** The point of the arrowhead. */
  tip: UV;
  /** Unit vector from the tip along the body of the arrow. */
  back: UV;
}

export interface DimensionGraphic {
  id: string;
  /** Centre of the value text (sketch coordinates), as stored with the dimension. */
  label: UV;
  segments: Seg[];
  arrows: Arrow[];
  /** Direction of the dimension line at the label, radians in the sketch plane; for the text rotation if the UI wants it. */
  angle: number;
  /** Driving dimension, or a reference dimension (measured, in parentheses). */
  driving: boolean;
  /** The solver reports a conflict or a redundancy for it. */
  problem: boolean;
}

const sub2 = (a: UV, b: UV): UV => [a[0] - b[0], a[1] - b[1]];
const add2 = (a: UV, b: UV): UV => [a[0] + b[0], a[1] + b[1]];
const mul2 = (a: UV, s: number): UV => [a[0] * s, a[1] * s];
const dot2 = (a: UV, b: UV): number => a[0] * b[0] + a[1] * b[1];
const len2 = (a: UV): number => Math.hypot(a[0], a[1]);
const unit2 = (a: UV, fallback: UV = [1, 0]): UV => {
  const l = len2(a);
  return l < 1e-12 ? fallback : [a[0] / l, a[1] / l];
};
const perp2 = (a: UV): UV => [-a[1], a[0]];

interface Resolved {
  point(ref: string): UV | null;
  /** A line as two points (also the axes), or null. */
  line(ref: string): { a: UV; b: UV } | null;
  circle(ref: string): { c: UV; r: number } | null;
}

function resolver(scene: SketchScene): Resolved {
  return {
    point: (ref) => {
      if (ref === "@origin") return [0, 0];
      const p = scene.pointById.get(ref);
      return p ? [p.u, p.v] : null;
    },
    line: (ref) => {
      if (ref === "@axisU") return { a: [0, 0], b: [1, 0] };
      if (ref === "@axisV") return { a: [0, 0], b: [0, 1] };
      const c = scene.curveById.get(ref);
      return c && c.type === "line" ? { a: c.a, b: c.b } : null;
    },
    circle: (ref) => {
      const c = scene.curveById.get(ref);
      return c && c.type === "circle" ? { c: c.c, r: c.r } : null;
    },
  };
}

/**
 * Builds a linear dimension: the dimension line runs from `a + n * offA` to `b + n * offB` (the points are carried to the
 * line along the extension direction n), the extension lines run from the points to just beyond the dimension line.
 */
function linear(id: string, label: UV, a: UV, b: UV, n: UV, offA: number, offB: number, mmPerPx: number, driving: boolean, problem: boolean): DimensionGraphic {
  const p1 = add2(a, mul2(n, offA)), p2 = add2(b, mul2(n, offB));
  const t = unit2(sub2(p2, p1), perp2(n));
  const span = len2(sub2(p2, p1));
  const gap = GAP_PX * mmPerPx, over = OVERSHOOT_PX * mmPerPx;
  const segments: Seg[] = [];
  const extension = (p: UV, off: number) => {
    // Nothing to extend when the point is (almost) on the dimension line.
    if (Math.abs(off) < gap + over) return;
    const s = Math.sign(off);
    segments.push([add2(p, mul2(n, s * gap)), add2(p, mul2(n, off + s * over))]);
  };
  extension(a, offA);
  extension(b, offB);
  // The label may sit beside the line's span (outside the two points): the line then reaches out to it.
  const along = dot2(sub2(label, p1), t);
  const lo = Math.min(0, along), hi = Math.max(span, along);
  const inside = span / mmPerPx >= INSIDE_ARROWS_MIN_PX && along >= 0 && along <= span;
  const stub = OUTSIDE_STUB_PX * mmPerPx;
  const from = inside ? 0 : Math.min(lo, -stub);
  const to = inside ? span : Math.max(hi, span + stub);
  segments.push([add2(p1, mul2(t, from)), add2(p1, mul2(t, to))]);
  const arrows: Arrow[] = inside
    ? [{ tip: p1, back: t }, { tip: p2, back: mul2(t, -1) }]
    : [{ tip: p1, back: mul2(t, -1) }, { tip: p2, back: t }];
  return { id, label, segments, arrows, angle: Math.atan2(t[1], t[0]), driving, problem };
}

/** An arc around `centre` from angle a0 to a0 + sweep (counter-clockwise), as short segments. */
export function arcSegments(centre: UV, radius: number, a0: number, sweep: number): Seg[] {
  const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 48)));
  const out: Seg[] = [];
  let prev: UV = [centre[0] + radius * Math.cos(a0), centre[1] + radius * Math.sin(a0)];
  for (let i = 1; i <= steps; i++) {
    const a = a0 + (sweep * i) / steps;
    const cur: UV = [centre[0] + radius * Math.cos(a), centre[1] + radius * Math.sin(a)];
    out.push([prev, cur]);
    prev = cur;
  }
  return out;
}

/** Where two infinite lines meet; null when they are parallel. */
export function lineIntersection(a: { a: UV; b: UV }, b: { a: UV; b: UV }): UV | null {
  const d1 = sub2(a.b, a.a), d2 = sub2(b.b, b.a);
  const cross = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(cross) < 1e-12) return null;
  const w = sub2(b.a, a.a);
  const s = (w[0] * d2[1] - w[1] * d2[0]) / cross;
  return add2(a.a, mul2(d1, s));
}

/**
 * An angular dimension: the arc around `vertex` from angle a1 through `sweep` with an arrowhead at each end, and the two rays
 * extended up to the arc where they end before it (`reach1`, `reach2`: how far each ray runs from the vertex, in mm).
 */
function angular(id: string, label: UV, vertex: UV, a1: number, sweep: number, radius: number, reach1: number, reach2: number, mmPerPx: number, driving: boolean, problem: boolean): DimensionGraphic {
  const gap = GAP_PX * mmPerPx, over = OVERSHOOT_PX * mmPerPx;
  const segments = Math.abs(sweep) < 1e-3 ? [] : arcSegments(vertex, radius, a1, sweep);
  // A line that ends before the arc is extended to it, so the arc always touches something.
  const ray = (angle: number, reach: number) => {
    const dir: UV = [Math.cos(angle), Math.sin(angle)];
    if (reach + gap < radius) segments.push([add2(vertex, mul2(dir, Math.max(reach, 0) + gap)), add2(vertex, mul2(dir, radius + over))]);
  };
  ray(a1, reach1);
  ray(a1 + sweep, reach2);
  const tangentAt = (a: number): UV => [-Math.sin(a), Math.cos(a)];
  const aEnd = a1 + sweep;
  const arrows: Arrow[] = Math.abs(sweep) < 1e-3
    ? []
    : [
        { tip: add2(vertex, mul2([Math.cos(a1), Math.sin(a1)], radius)), back: mul2(tangentAt(a1), 1) },
        { tip: add2(vertex, mul2([Math.cos(aEnd), Math.sin(aEnd)], radius)), back: mul2(tangentAt(aEnd), -1) },
      ];
  const mid = a1 + sweep / 2;
  return { id, label, segments, arrows, angle: mid + Math.PI / 2, driving, problem };
}

/** The dimension line of a diameter (through the centre, arrowheads on the rim) or of a radius (from the centre to the rim). */
function circular(kind: "diameter" | "radius", id: string, label: UV, centre: UV, radius: number, mmPerPx: number, driving: boolean, problem: boolean): DimensionGraphic {
  const toLabel = sub2(label, centre);
  const dir = len2(toLabel) < 1e-9 ? ([Math.SQRT1_2, Math.SQRT1_2] as UV) : unit2(toLabel);
  const reach = Math.max(radius, len2(toLabel));
  const fits = radius / mmPerPx >= INSIDE_ARROWS_MIN_PX / 2;
  const stub = OUTSIDE_STUB_PX * mmPerPx;
  const angle = Math.atan2(dir[1], dir[0]);
  if (kind === "radius") {
    const tip = add2(centre, mul2(dir, radius));
    const segments: Seg[] = [[centre, add2(centre, mul2(dir, fits ? reach : reach + stub))]];
    return { id, label, segments, arrows: [{ tip, back: fits ? mul2(dir, -1) : dir }], angle, driving, problem };
  }
  const far = add2(centre, mul2(dir, -radius)), near = add2(centre, mul2(dir, radius));
  const start = fits ? far : add2(far, mul2(dir, -stub));
  const end = add2(centre, mul2(dir, fits ? reach : Math.max(reach, radius + stub)));
  return {
    id, label, segments: [[start, end]],
    arrows: [{ tip: far, back: fits ? dir : mul2(dir, -1) }, { tip: near, back: fits ? mul2(dir, -1) : dir }],
    angle, driving, problem,
  };
}

/** Half the width and half the height of a value on a live dimension line, px (the text stays horizontal; the line leaves room for it). */
export const LIVE_LABEL_HALF_W_PX = 56;
export const LIVE_LABEL_HALF_H_PX = 13;
/** How far beyond its arc the value of a live angle sits, and beyond the rim the value of a live diameter, px. */
export const LIVE_ANGLE_LABEL_PX = LIVE_LABEL_HALF_W_PX + 6;
export const LIVE_DIAMETER_LABEL_PX = LIVE_LABEL_HALF_W_PX + 14;

/**
 * How much of a dimension line the value hides, per side, px: the text is horizontal, so on a horizontal line it takes half
 * its width and on a vertical one half its height. A live length shorter than this and two arrowheads puts its value beside
 * the line's end instead of on it. `t` is the unit direction of the line in the sketch (the view looks straight onto it).
 */
export function liveLabelReach(t: UV): number {
  return LIVE_LABEL_HALF_W_PX * Math.abs(t[0]) + LIVE_LABEL_HALF_H_PX * Math.abs(t[1]);
}

/** The graphics of one value of the shape being drawn: the graphics of a finished dimension, without needing its references. */
export function liveDimensionGraphic(id: string, live: LiveDimension, mmPerPx: number, problem: boolean): DimensionGraphic {
  switch (live.shape) {
    case "linear": {
      const a: UV = live.a, b: UV = live.b, n: UV = live.n;
      const off = live.offsetPx * mmPerPx;
      if (len2(sub2(b, a)) < 1e-12) return { id, label: add2(a, mul2(n, off)), segments: [], arrows: [], angle: 0, driving: true, problem };
      const p1 = add2(a, mul2(n, off)), p2 = add2(b, mul2(n, off));
      const t = unit2(sub2(p2, p1));
      const reach = liveLabelReach(t);
      const roomy = len2(sub2(p2, p1)) / mmPerPx >= 2 * reach + 2 * ARROW_LENGTH_PX + 8;
      const label: UV = roomy ? mul2(add2(p1, p2), 0.5) : add2(p2, mul2(t, (OUTSIDE_STUB_PX + reach) * mmPerPx));
      return linear(id, label, a, b, n, off, off, mmPerPx, true, problem);
    }
    case "angle": {
      const radius = live.radiusPx * mmPerPx;
      const mid = live.start + live.sweep / 2;
      const label = add2(live.vertex, mul2([Math.cos(mid), Math.sin(mid)], radius + LIVE_ANGLE_LABEL_PX * mmPerPx));
      return angular(id, label, live.vertex, live.start, live.sweep, radius, live.reach[0], live.reach[1], mmPerPx, true, problem);
    }
    case "diameter": {
      const dir = unit2(live.dir);
      const label = add2(live.c, mul2(dir, live.r + LIVE_DIAMETER_LABEL_PX * mmPerPx));
      // A circle that is still (almost) a point has no line to draw yet, only the place of its value.
      if (live.r / mmPerPx < 3) return { id, label, segments: [], arrows: [], angle: Math.atan2(dir[1], dir[0]), driving: true, problem };
      return circular("diameter", id, label, live.c, live.r, mmPerPx, true, problem);
    }
  }
}

/** The graphics of one dimension, or null when its references cannot be resolved (the view is then drawn without it). */
export function dimensionGraphic(d: SketchDimensionView, scene: SketchScene, mmPerPx: number): DimensionGraphic | null {
  const r = resolver(scene);
  const label: UV = [d.label.x, d.label.y];
  const problem = d.state === "conflicting" || d.state === "redundant" || d.state === "partiallyRedundant";
  switch (d.kind) {
    case "distance": {
      // One line, or two of point, line and circle: the segment that is measured, see measuredSegment.
      const segment = measuredSegment(d.refs, r);
      if (!segment) return null;
      const a = segment.a, b = segment.b;
      if (len2(sub2(b, a)) < 1e-12) return null;
      const t = unit2(sub2(b, a));
      const n = perp2(t);
      const off = dot2(sub2(label, a), n);
      return linear(d.id, label, a, b, n, off, off, mmPerPx, d.driving, problem);
    }
    case "distanceX": {
      const a = r.point(d.refs[0] ?? ""), b = r.point(d.refs[1] ?? "");
      if (!a || !b) return null;
      return linear(d.id, label, a, b, [0, 1], label[1] - a[1], label[1] - b[1], mmPerPx, d.driving, problem);
    }
    case "distanceY": {
      const a = r.point(d.refs[0] ?? ""), b = r.point(d.refs[1] ?? "");
      if (!a || !b) return null;
      return linear(d.id, label, a, b, [1, 0], label[0] - a[0], label[0] - b[0], mmPerPx, d.driving, problem);
    }
    case "angle": {
      const l1 = r.line(d.refs[0] ?? ""), l2 = r.line(d.refs[1] ?? "");
      const rays = angleRays(d.refs, d.reverse, r);
      if (!l1 || !l2 || !rays) return null;
      // The two rays the angle is measured between (against the line direction where d.reverse says so).
      const { vertex, start: a1, sweep } = rays;
      const d1: UV = [Math.cos(a1), Math.sin(a1)], d2: UV = [Math.cos(a1 + sweep), Math.sin(a1 + sweep)];
      const radius = Math.max(len2(sub2(label, vertex)), 24 * mmPerPx);
      const reachOf = (dir: UV, l: { a: UV; b: UV }) => Math.max(dot2(sub2(l.a, vertex), dir), dot2(sub2(l.b, vertex), dir));
      return angular(d.id, label, vertex, a1, sweep, radius, reachOf(d1, l1), reachOf(d2, l2), mmPerPx, d.driving, problem);
    }
    case "diameter":
    case "radius": {
      const c = r.circle(d.refs[0] ?? "");
      if (!c) return null;
      return circular(d.kind, d.id, label, c.c, c.r, mmPerPx, d.driving, problem);
    }
  }
}

/** The graphics of all dimensions that can be drawn. */
export function dimensionGraphics(dimensions: readonly SketchDimensionView[], scene: SketchScene, mmPerPx: number): DimensionGraphic[] {
  const out: DimensionGraphic[] = [];
  for (const d of dimensions) {
    const g = dimensionGraphic(d, scene, mmPerPx);
    if (g) out.push(g);
  }
  return out;
}

/** The three corners of an arrowhead in sketch coordinates. */
export function arrowTriangle(a: Arrow, mmPerPx: number): [UV, UV, UV] {
  const len = ARROW_LENGTH_PX * mmPerPx, half = ARROW_HALF_WIDTH_PX * mmPerPx;
  const base = add2(a.tip, mul2(a.back, len));
  const side = perp2(a.back);
  return [a.tip, add2(base, mul2(side, half)), add2(base, mul2(side, -half))];
}
