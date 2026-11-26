// Which of the four angles between two lines an angle dimension measures: the one in the sector the
// label lies in. Two lines cross in four sectors; each is bounded by one ray of each line. The dimension stores the two
// rays as reverse flags (Dimension.reverse: true = the ray runs against the line's direction p1 -> p2) and the references
// in the order that makes the angle run counter-clockwise from the first ray to the second, so the value is simply 0 to 180
// degrees and both the solver constraint and the reference measurement agree on it, however the lines move later.
// Pure functions, tested in Node.
import type { LabelGeometry, UV } from "./dimension-label.ts";

export interface AngleSector {
  /** The two lines in the order the angle is counted from the first ray to the second. */
  refs: [string, string];
  /** Per reference: the ray runs against the direction of its line. */
  reverse: [boolean, boolean];
  /** The angle between the two rays, 0 to 180 degrees. */
  degrees: number;
}

const cross = (a: UV, b: UV): number => a[0] * b[1] - a[1] * b[0];
const dot = (a: UV, b: UV): number => a[0] * b[0] + a[1] * b[1];
const sub = (a: UV, b: UV): UV => [a[0] - b[0], a[1] - b[1]];

/** Whether two lines run parallel (or one has no length): the distance between them is measured instead of an angle. */
export function linesParallel(refs: readonly string[], g: LabelGeometry, tolerance = 1e-6): boolean {
  const l1 = g.line(refs[0] ?? ""), l2 = g.line(refs[1] ?? "");
  if (!l1 || !l2) return false;
  const d1 = sub(l1.b, l1.a), d2 = sub(l2.b, l2.a);
  const n = Math.hypot(d1[0], d1[1]) * Math.hypot(d2[0], d2[1]);
  return n === 0 || Math.abs(cross(d1, d2)) <= tolerance * n;
}

/**
 * The sector of the two lines that holds `point`, as an angle between rays. Null when the lines do not resolve or are
 * parallel (no sector, no angle). A point on a line or at the crossing belongs to the sector between the two directions.
 */
export function angleSectorAt(refs: readonly string[], point: UV, g: LabelGeometry): AngleSector | null {
  const l1 = g.line(refs[0] ?? ""), l2 = g.line(refs[1] ?? "");
  if (!l1 || !l2 || refs.length !== 2 || linesParallel(refs, g)) return null;
  const d1 = sub(l1.b, l1.a), d2 = sub(l2.b, l2.a);
  // The crossing of the two infinite lines.
  const t = cross(sub(l2.a, l1.a), d2) / cross(d1, d2);
  const vertex: UV = [l1.a[0] + d1[0] * t, l1.a[1] + d1[1] * t];
  let u = sub(point, vertex);
  if (Math.hypot(u[0], u[1]) < 1e-9) u = [d1[0] / Math.hypot(d1[0], d1[1]) + d2[0] / Math.hypot(d2[0], d2[1]), d1[1] / Math.hypot(d1[0], d1[1]) + d2[1] / Math.hypot(d2[0], d2[1])];
  // The ray of each line that bounds the sector: the one on the same side of the OTHER line as the point.
  const sign = (v: number): number => (v < 0 ? -1 : 1);
  const s1 = sign(cross(d2, d1) * cross(d2, u));
  const s2 = sign(cross(d1, d2) * cross(d1, u));
  const r1: UV = [d1[0] * s1, d1[1] * s1], r2: UV = [d2[0] * s2, d2[1] * s2];
  const degrees = (Math.atan2(Math.abs(cross(r1, r2)), dot(r1, r2)) * 180) / Math.PI;
  const flags: [boolean, boolean] = [s1 < 0, s2 < 0];
  // Counter-clockwise from the first ray to the second: otherwise the references swap places.
  return cross(r1, r2) >= 0 ? { refs: [refs[0]!, refs[1]!], reverse: flags, degrees } : { refs: [refs[1]!, refs[0]!], reverse: [flags[1], flags[0]], degrees };
}
