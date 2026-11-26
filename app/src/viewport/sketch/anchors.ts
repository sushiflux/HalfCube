// Where the UI puts its HTML pieces over the sketch: the glyph of each constraint beside the entity it belongs to, and the
// value labels of the dimensions. Constraint glyphs are placed on the screen so that none covers another one, a dimension
// label or (as far as it can be avoided) its own entity. Deterministic: the same sketch and camera give the same places.
// Pure functions, tested in Node.
import type { SketchConstraintView } from "../../model/editors.ts";
import type { DimensionGraphic } from "./dimensions.ts";
import type { SketchProjector } from "./frame.ts";
import type { SceneCurve, SketchScene, UV } from "./scene.ts";
import type { ScreenAnchor } from "./types.ts";
import { LABEL_HALF_HEIGHT_PX, LABEL_HALF_WIDTH_PX } from "./pick.ts";

/** Distance of a glyph from its entity, CSS pixels. */
export const GLYPH_OFFSET_PX = 16;
/** Two glyphs closer than this (in both directions) overlap. */
export const GLYPH_SIZE_PX = 20;

interface Candidate {
  id: string;
  /** Screen position of the entity part the glyph belongs to. */
  base: { x: number; y: number };
  /** Preferred direction of the offset on the screen (unit vector). */
  dir: { x: number; y: number };
}

const UP_LEFT = { x: -Math.SQRT1_2, y: -Math.SQRT1_2 };

function normalise(x: number, y: number, fallback = UP_LEFT): { x: number; y: number } {
  const l = Math.hypot(x, y);
  return l < 1e-9 ? fallback : { x: x / l, y: y / l };
}

/** The screen normal of a line that points up (or left for a vertical one): glyphs sit above their lines. */
function lineSide(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
  const n = normalise(-(b.y - a.y), b.x - a.x);
  return n.y < -1e-6 || (Math.abs(n.y) <= 1e-6 && n.x < 0) ? n : { x: -n.x, y: -n.y };
}

function curveCandidate(id: string, c: SceneCurve, proj: SketchProjector): Candidate | null {
  if (c.type === "line") {
    const a = proj.toScreen(c.a[0], c.a[1]), b = proj.toScreen(c.b[0], c.b[1]);
    if (!a || !b) return null;
    return { id, base: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dir: lineSide(a, b) };
  }
  const s = proj.toScreen(c.c[0] + c.r * Math.SQRT1_2, c.c[1] + c.r * Math.SQRT1_2);
  const centre = proj.toScreen(c.c[0], c.c[1]);
  return s && centre ? { id, base: s, dir: normalise(s.x - centre.x, s.y - centre.y) } : null;
}

function pointCandidate(id: string, p: UV, proj: SketchProjector): Candidate | null {
  const s = proj.toScreen(p[0], p[1]);
  return s ? { id, base: s, dir: { x: Math.SQRT1_2, y: -Math.SQRT1_2 } } : null;
}

/** The entity parts a constraint hangs its glyphs on: one candidate for most kinds, two for kinds that relate two curves. */
function candidatesOf(c: SketchConstraintView, scene: SketchScene, proj: SketchProjector): Candidate[] {
  const out: (Candidate | null)[] = [];
  const point = (ref: string): UV | null => {
    if (ref === "@origin") return [0, 0];
    const p = scene.pointById.get(ref);
    return p ? [p.u, p.v] : null;
  };
  const curve = (ref: string, id: string): Candidate | null => {
    const cu = scene.curveById.get(ref);
    return cu ? curveCandidate(id, cu, proj) : null;
  };
  switch (c.kind) {
    case "coincident": {
      const p = point(c.refs[0] ?? "") ?? point(c.refs[1] ?? "");
      out.push(p ? pointCandidate(c.id, p, proj) : null);
      break;
    }
    case "pointOnCurve": {
      const p = point(c.refs[0] ?? "");
      out.push(p ? pointCandidate(c.id, p, proj) : null);
      break;
    }
    case "horizontal":
    case "vertical":
      out.push(curve(c.refs[0] ?? "", c.id));
      break;
    case "fix": {
      const ref = c.refs[0] ?? "";
      const p = point(ref);
      out.push(p ? pointCandidate(c.id, p, proj) : curve(ref, c.id));
      break;
    }
    case "parallel":
    case "perpendicular":
    case "equal":
      out.push(curve(c.refs[0] ?? "", c.id), curve(c.refs[1] ?? "", `${c.id}#2`));
      break;
  }
  return out.filter((x): x is Candidate => x !== null);
}

interface Box {
  x: number;
  y: number;
  hw: number;
  hh: number;
}

const overlaps = (a: Box, b: Box): boolean => Math.abs(a.x - b.x) < a.hw + b.hw && Math.abs(a.y - b.y) < a.hh + b.hh;

/**
 * The anchors of the constraint glyphs. Each glyph starts at its preferred offset from its entity; when that place is taken
 * (by another glyph, a dimension label or the view's edge) it moves round its entity and then further out, until it fits.
 * `bounds` is the size of the view. Constraints that cannot be placed (references gone) are left out.
 */
export function constraintAnchors(
  constraints: readonly SketchConstraintView[],
  scene: SketchScene,
  dimensions: readonly DimensionGraphic[],
  proj: SketchProjector,
  bounds: { width: number; height: number },
): ScreenAnchor[] {
  const taken: Box[] = [];
  for (const d of dimensions) {
    const s = proj.toScreen(d.label[0], d.label[1]);
    if (s) taken.push({ x: s.x, y: s.y, hw: LABEL_HALF_WIDTH_PX, hh: LABEL_HALF_HEIGHT_PX });
  }
  const half = GLYPH_SIZE_PX / 2;
  const out: ScreenAnchor[] = [];
  for (const c of constraints) {
    for (const cand of candidatesOf(c, scene, proj)) {
      let placed: { x: number; y: number } | null = null;
      // Rings of growing radius; on each ring the preferred direction first, then turning by 45 degrees alternately both ways.
      for (let ring = 0; ring < 4 && !placed; ring++) {
        const radius = GLYPH_OFFSET_PX + ring * GLYPH_SIZE_PX;
        for (let k = 0; k < 8 && !placed; k++) {
          const turn = (Math.ceil(k / 2) * (k % 2 === 0 ? 1 : -1) * Math.PI) / 4;
          const cos = Math.cos(turn), sin = Math.sin(turn);
          const dx = cand.dir.x * cos - cand.dir.y * sin, dy = cand.dir.x * sin + cand.dir.y * cos;
          const x = cand.base.x + dx * radius, y = cand.base.y + dy * radius;
          if (x < half || y < half || x > bounds.width - half || y > bounds.height - half) continue;
          const box: Box = { x, y, hw: half, hh: half };
          if (taken.some((t) => overlaps(box, t))) continue;
          placed = { x, y };
        }
      }
      // Nothing free within reach: stay at the preferred place (a glyph on a glyph beats a glyph that is missing).
      const at = placed ?? { x: cand.base.x + cand.dir.x * GLYPH_OFFSET_PX, y: cand.base.y + cand.dir.y * GLYPH_OFFSET_PX };
      taken.push({ x: at.x, y: at.y, hw: half, hh: half });
      out.push({ id: cand.id, x: at.x, y: at.y });
    }
  }
  return out;
}

/** The anchors of the dimension labels, with the screen angle of the dimension line (normalised so text never stands on its head). */
export function dimensionAnchors(dimensions: readonly DimensionGraphic[], proj: SketchProjector): ScreenAnchor[] {
  const out: ScreenAnchor[] = [];
  for (const d of dimensions) {
    const s = proj.toScreen(d.label[0], d.label[1]);
    if (!s) continue;
    const ahead = proj.toScreen(d.label[0] + Math.cos(d.angle), d.label[1] + Math.sin(d.angle));
    let angle = ahead ? Math.atan2(ahead.y - s.y, ahead.x - s.x) : 0;
    if (angle > Math.PI / 2) angle -= Math.PI;
    else if (angle <= -Math.PI / 2) angle += Math.PI;
    out.push({ id: d.id, x: s.x, y: s.y, angle });
  }
  return out;
}
