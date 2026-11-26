// Geometry of a tool's preview: the rubber band, its construction variant, dashed guides and the small hint glyphs that say
// what the tool is about to do (horizontal, coincident, tangent ...). Glyphs are drawn a fixed number of pixels big, so they
// are built from the current scale. Pure functions, tested in Node.
import { tessellateArc } from "../geometry.ts";
import type { Seg } from "./dimensions.ts";
import type { UV } from "./scene.ts";
import type { SketchPreview } from "./types.ts";

export type Hint = NonNullable<SketchPreview["hints"]>[number];

/** Distance of a hint glyph from the point it belongs to (right and up), CSS pixels. */
export const HINT_OFFSET_PX = 14;
const S = 5; // half size of a glyph box, px

type PxSeg = readonly [UV, UV];

/** The strokes of a glyph in pixels, relative to its centre, u to the right and v up. */
export function hintStrokes(kind: Hint["kind"]): PxSeg[] {
  const box = (r: number): PxSeg[] => [[[-r, -r], [r, -r]], [[r, -r], [r, r]], [[r, r], [-r, r]], [[-r, r], [-r, -r]]];
  switch (kind) {
    case "horizontal": return [[[-S, 2.5], [S, 2.5]], [[-S, -2.5], [S, -2.5]]];
    case "vertical": return [[[2.5, -S], [2.5, S]], [[-2.5, -S], [-2.5, S]]];
    case "parallel": return [[[-1, -S], [3, S]], [[-4, -S], [0, S]]];
    case "perpendicular": return [[[-S, -S], [S, -S]], [[0, -S], [0, S]]];
    case "tangent": {
      const ring: PxSeg[] = [];
      const pts = tessellateArc([0, 2], 3.5, 0, Math.PI * 2);
      for (let i = 0; i + 1 < pts.length; i++) ring.push([pts[i]!, pts[i + 1]!]);
      return [...ring, [[-S - 1, -1.5], [S + 1, -1.5]]];
    }
    case "coincident": return box(S);
    case "onCurve": return [[[-S, 0], [0, S]], [[0, S], [S, 0]], [[S, 0], [0, -S]], [[0, -S], [-S, 0]]];
  }
}

/**
 * The strokes of all hints in sketch coordinates. Coincident and on-curve glyphs sit on the point (they mark it); the others
 * sit up and to the right of it, away from the geometry being drawn.
 */
export function hintSegments(hints: readonly Hint[], mmPerPx: number): Seg[] {
  const out: Seg[] = [];
  for (const h of hints) {
    const onPoint = h.kind === "coincident" || h.kind === "onCurve";
    const cx = h.at[0] + (onPoint ? 0 : HINT_OFFSET_PX * mmPerPx);
    const cy = h.at[1] + (onPoint ? 0 : HINT_OFFSET_PX * mmPerPx);
    for (const [a, b] of hintStrokes(h.kind)) out.push([[cx + a[0] * mmPerPx, cy + a[1] * mmPerPx], [cx + b[0] * mmPerPx, cy + b[1] * mmPerPx]]);
  }
  return out;
}

/** The polylines of the rubber band lines (a circle is one closed polyline), split by whether they are construction lines. */
export function previewPolylines(preview: SketchPreview): { solid: UV[][]; construction: UV[][] } {
  const solid: UV[][] = [], construction: UV[][] = [];
  for (const l of preview.lines ?? []) (l.construction ? construction : solid).push([l.a, l.b]);
  for (const c of preview.circles ?? []) (c.construction ? construction : solid).push(tessellateArc(c.c, c.r, 0, Math.PI * 2));
  return { solid, construction };
}
