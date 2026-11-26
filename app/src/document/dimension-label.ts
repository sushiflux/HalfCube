// Where the number of a dimension sits, stored RELATIVE to the geometry the dimension measures, so the label travels with
// that geometry: moving a rectangle, dragging a corner, a solve or a typed value never leaves it behind. The stored value
// is Dimension.label (a Vec2 whose x and y mean something different per kind, see below); the UI works with absolute sketch
// coordinates (the view, the pointer), so the model converts at its boundary: placement() when a label is set (the point
// the user clicked or dragged to), position() when a view is built (the point the viewport draws at).
//
//   distance (a line, or two of point, line and circle: the measured segment a to b, see measuredSegment)
//                                          mid = (a + b) / 2, t = unit(b - a), n = perpendicular to t (left of t)
//       x = along t from the midpoint as a share of the length |b - a| (0 = middle, 0.5 = at b, -0.5 = at a; beyond the
//           ends is allowed), so a longer or shorter dimension keeps the label at the same place relative to its ends;
//       y = distance from the line through a and b, mm along n (the gap of the dimension line stays the same when the
//           length changes).
//   distanceX (point a, point b)           x = along u from the midpoint as a share of b.u - a.u; y = v of the dimension
//                                          line minus the midpoint's v, mm.
//   distanceY (point a, point b)           x = along v from the midpoint as a share of b.v - a.v; y = u of the dimension
//                                          line minus the midpoint's u, mm.
//   angle (line l1, line l2)               polar around the vertex (where the lines meet, else the start of l1), between the
//       two rays angleRays names (reverse flags; without them the line directions):
//       x = direction as a share of the swept angle, counted from the first ray (0 = on it, 1 = on the second, 0.5 = middle);
//       y = distance from the vertex, mm (the radius of the dimension arc).
//   diameter, radius (circle)              x, y = offset from the centre as a multiple of the radius (the dimension
//                                          scales with the circle).
//
// A share needs a length to be a share of: when that length is (almost) 0 the share is stored as 0 and the label sits at the
// midpoint (distance, distanceX, distanceY) or on the bisector (angle). Pure functions, tested in Node.
import type { Dimension, SketchData, Vec2 } from "./types.ts";

export type UV = readonly [number, number];

/** What a label can be measured against: the points, lines (two ends) and circles of one sketch, by id (the fixed references too). */
export interface LabelGeometry {
  point(ref: string): UV | null;
  line(ref: string): { a: UV; b: UV } | null;
  circle(ref: string): { c: UV; r: number } | null;
}

const EPS = 1e-9;

const sub = (a: UV, b: UV): UV => [a[0] - b[0], a[1] - b[1]];
const add = (a: UV, b: UV): UV => [a[0] + b[0], a[1] + b[1]];
const mul = (a: UV, s: number): UV => [a[0] * s, a[1] * s];
const dot = (a: UV, b: UV): number => a[0] * b[0] + a[1] * b[1];
const len = (a: UV): number => Math.hypot(a[0], a[1]);
const mid = (a: UV, b: UV): UV => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const wrap = (angle: number): number => {
  const t = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return t > Math.PI ? t - 2 * Math.PI : t;
};

/** The fixed references of every sketch (the origin and the two axes) and the elements of a sketch. */
export function geometryOf(sketch: Pick<SketchData, "points" | "lines" | "circles">): LabelGeometry {
  const points = new Map<string, UV>(sketch.points.map((p) => [p.id, [p.x, p.y]]));
  const point = (ref: string): UV | null => (ref === "@origin" ? [0, 0] : (points.get(ref) ?? null));
  const lines = new Map(sketch.lines.map((l) => [l.id, l]));
  const circles = new Map(sketch.circles.map((c) => [c.id, c]));
  return {
    point,
    line: (ref) => {
      if (ref === "@axisU") return { a: [0, 0], b: [1, 0] };
      if (ref === "@axisV") return { a: [0, 0], b: [0, 1] };
      const l = lines.get(ref);
      const a = l && point(l.p1), b = l && point(l.p2);
      return a && b ? { a, b } : null;
    },
    circle: (ref) => {
      const c = circles.get(ref);
      const centre = c && point(c.center);
      return c && centre ? { c: centre, r: c.radius } : null;
    },
  };
}

type Kind = Dimension["kind"];

/** A measured segment of a distance dimension: from a to b; `crossing` for two circles that cross (no positive gap, no dimension). */
export interface MeasuredSegment {
  a: UV;
  b: UV;
  crossing?: boolean;
}

type Part = { kind: "point"; p: UV } | { kind: "line"; a: UV; b: UV } | { kind: "circle"; c: UV; r: number };

function part(ref: string, g: LabelGeometry): Part | null {
  const p = g.point(ref);
  if (p) return { kind: "point", p };
  const l = g.line(ref);
  if (l) return { kind: "line", a: l.a, b: l.b };
  const c = g.circle(ref);
  return c ? { kind: "circle", c: c.c, r: c.r } : null;
}

const foot = (p: UV, a: UV, b: UV): UV | null => {
  const d = sub(b, a), l2 = dot(d, d);
  return l2 < EPS * EPS ? null : add(a, mul(d, dot(sub(p, a), d) / l2));
};

/**
 * The segment a distance dimension measures, for the references it names (what is clicked is what is
 * measured). A circle given as such is its rim; its centre is a point of the sketch and is measured as a point.
 *   one line                  its two ends
 *   point, point              the two points
 *   point, line               the point and its foot on the infinite line
 *   line, line                the first line (its middle when the lines are parallel, else its start) and its foot on the second line
 *   point, circle             the point and the nearest point of the rim, on the line through the centre
 *   circle, line              the point of the rim that faces the line and the foot of the centre on the line
 *   circle, circle            the rims facing each other along the line through the centres
 * Null when a reference does not resolve or the segment has no direction (a point on the line, concentric circles ...).
 */
export function measuredSegment(refs: readonly string[], g: LabelGeometry): MeasuredSegment | null {
  if (refs.length === 1) return g.line(refs[0]!);
  if (refs.length !== 2) return null;
  const x = part(refs[0]!, g), y = part(refs[1]!, g);
  if (!x || !y) return null;
  const pointLine = (p: UV, l: { a: UV; b: UV }): MeasuredSegment | null => {
    const f = foot(p, l.a, l.b);
    return f ? { a: p, b: f } : null;
  };
  const rimToward = (c: UV, r: number, target: UV): UV | null => {
    const d = sub(target, c), l = len(d);
    return l < EPS ? null : add(c, mul(d, r / l));
  };
  if (x.kind === "point" && y.kind === "point") return { a: x.p, b: y.p };
  const point = x.kind === "point" ? x : y.kind === "point" ? y : null;
  const line = x.kind === "line" ? x : y.kind === "line" ? y : null;
  const circle = x.kind === "circle" ? x : y.kind === "circle" ? y : null;
  if (point && line) return pointLine(point.p, line);
  if (x.kind === "line" && y.kind === "line") {
    const d1 = sub(x.b, x.a), d2 = sub(y.b, y.a);
    const parallel = Math.abs(d1[0] * d2[1] - d1[1] * d2[0]) <= 1e-6 * len(d1) * len(d2);
    return pointLine(parallel ? mid(x.a, x.b) : x.a, y);
  }
  if (point && circle) {
    const rim = rimToward(circle.c, circle.r, point.p);
    return rim ? { a: point.p, b: rim } : null;
  }
  if (circle && line) {
    const f = foot(circle.c, line.a, line.b);
    const rim = f && rimToward(circle.c, circle.r, f);
    return f && rim ? { a: rim, b: f } : null;
  }
  if (x.kind === "circle" && y.kind === "circle") {
    const d = len(sub(y.c, x.c));
    const outside = d >= x.r && d >= y.r;
    const gap = outside ? d - x.r - y.r : Math.max(x.r, y.r) - Math.min(x.r, y.r) - d;
    const along: UV = d < EPS ? [1, 0] : mul(sub(y.c, x.c), 1 / d);
    if (outside) return { a: add(x.c, mul(along, x.r)), b: sub(y.c, mul(along, y.r)), ...(gap < 0 ? { crossing: true } : {}) };
    // One inside the other: the rims face each other on the side the small circle leans to.
    const bigIsX = x.r >= y.r;
    const big = bigIsX ? x : y, small = bigIsX ? y : x;
    const lean: UV = d < EPS ? [1, 0] : mul(sub(small.c, big.c), 1 / d);
    return { a: add(small.c, mul(lean, small.r)), b: add(big.c, mul(lean, big.r)), ...(gap < 0 ? { crossing: true } : {}) };
  }
  return null;
}

/** The two measured ends of a linear dimension (see measuredSegment). */
function ends(refs: readonly string[], g: LabelGeometry): { a: UV; b: UV } | null {
  return measuredSegment(refs, g);
}

/**
 * The two rays an angle dimension measures between: along each line, against its direction (p1 to p2) where reverse says so;
 * without reverse the line directions. The angle runs counter-clockwise from the first ray to the second.
 */
export function angleRays(refs: readonly string[], reverse: readonly boolean[] | undefined, g: LabelGeometry): { vertex: UV; start: number; sweep: number } | null {
  const l1 = g.line(refs[0] ?? ""), l2 = g.line(refs[1] ?? "");
  if (!l1 || !l2) return null;
  const turn = (flag: boolean | undefined): number => (flag ? Math.PI : 0);
  const d1 = sub(l1.b, l1.a), d2 = sub(l2.b, l2.a);
  const start = Math.atan2(d1[1], d1[0]) + turn(reverse?.[0]);
  const sweep = ((((Math.atan2(d2[1], d2[0]) + turn(reverse?.[1])) - start) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const cross = d1[0] * d2[1] - d1[1] * d2[0];
  let vertex = l1.a;
  if (Math.abs(cross) > 1e-12) {
    const w = sub(l2.a, l1.a);
    vertex = add(l1.a, mul(d1, (w[0] * d2[1] - w[1] * d2[0]) / cross));
  }
  return { vertex, start, sweep };
}

/**
 * The absolute label point (sketch coordinates) of a stored relative label, or null when the references of the dimension
 * cannot be resolved in this geometry.
 */
export function labelPosition(kind: Kind, refs: readonly string[], label: Vec2, g: LabelGeometry, reverse?: readonly boolean[]): Vec2 | null {
  const at = (p: UV): Vec2 => ({ x: p[0], y: p[1] });
  switch (kind) {
    case "distance": {
      const e = ends(refs, g);
      if (!e) return null;
      const d = sub(e.b, e.a), length = len(d);
      const t: UV = length < EPS ? [1, 0] : mul(d, 1 / length);
      const n: UV = [-t[1], t[0]];
      return at(add(add(mid(e.a, e.b), mul(t, label.x * length)), mul(n, label.y)));
    }
    case "distanceX": {
      const e = ends(refs, g);
      if (!e) return null;
      const m = mid(e.a, e.b);
      return at([m[0] + label.x * (e.b[0] - e.a[0]), m[1] + label.y]);
    }
    case "distanceY": {
      const e = ends(refs, g);
      if (!e) return null;
      const m = mid(e.a, e.b);
      return at([m[0] + label.y, m[1] + label.x * (e.b[1] - e.a[1])]);
    }
    case "angle": {
      const f = angleRays(refs, reverse, g);
      if (!f) return null;
      const direction = f.start + label.x * f.sweep;
      return at(add(f.vertex, [label.y * Math.cos(direction), label.y * Math.sin(direction)]));
    }
    case "diameter":
    case "radius": {
      const c = g.circle(refs[0] ?? "");
      if (!c) return null;
      return at(add(c.c, mul([label.x, label.y], c.r)));
    }
  }
}

/**
 * The relative label for an absolute point on the current geometry (what the user clicked or dragged the label to).
 * When the references cannot be resolved the point cannot be related to anything: {0, 0} (the middle of the measured
 * thing, on its line) is stored rather than a number that means something else.
 */
export function labelPlacement(kind: Kind, refs: readonly string[], point: Vec2, g: LabelGeometry, reverse?: readonly boolean[]): Vec2 {
  const p: UV = [point.x, point.y];
  switch (kind) {
    case "distance": {
      const e = ends(refs, g);
      if (!e) return { x: 0, y: 0 };
      const d = sub(e.b, e.a), length = len(d);
      const t: UV = length < EPS ? [1, 0] : mul(d, 1 / length);
      const n: UV = [-t[1], t[0]];
      const rel = sub(p, mid(e.a, e.b));
      return { x: length < EPS ? 0 : dot(rel, t) / length, y: dot(rel, n) };
    }
    case "distanceX": {
      const e = ends(refs, g);
      if (!e) return { x: 0, y: 0 };
      const m = mid(e.a, e.b), span = e.b[0] - e.a[0];
      return { x: Math.abs(span) < EPS ? 0 : (p[0] - m[0]) / span, y: p[1] - m[1] };
    }
    case "distanceY": {
      const e = ends(refs, g);
      if (!e) return { x: 0, y: 0 };
      const m = mid(e.a, e.b), span = e.b[1] - e.a[1];
      return { x: Math.abs(span) < EPS ? 0 : (p[1] - m[1]) / span, y: p[0] - m[0] };
    }
    case "angle": {
      const f = angleRays(refs, reverse, g);
      if (!f) return { x: 0, y: 0 };
      const rel = sub(p, f.vertex);
      if (f.sweep < EPS) return { x: 0, y: len(rel) };
      // The direction relative to the middle of the swept angle, in (-pi, pi], so a label outside the arc keeps its side.
      const delta = wrap(Math.atan2(rel[1], rel[0]) - (f.start + f.sweep / 2));
      return { x: 0.5 + delta / f.sweep, y: len(rel) };
    }
    case "diameter":
    case "radius": {
      const c = g.circle(refs[0] ?? "");
      if (!c || c.r < EPS) return { x: 0, y: 0 };
      const rel = sub(p, c.c);
      return { x: rel[0] / c.r, y: rel[1] / c.r };
    }
  }
}
