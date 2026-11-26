// The automatic names of dimensions: d0, d1, d2 ... (counted from 0; d for dimension). The pattern d + number is
// reserved for these names (later user parameters must not use it). One counter for
// the whole document (HalfCubeDocument.nextParameter), so a name is unique across all sketches and later steps (an extrusion's
// distance can take a number of its own from the same counter); the number is stored with the dimension (Dimension.number) and
// never changes or comes back: not after a deletion, an undo or a reload. Pure functions, tested in Node.
import { isDimension, type Dimension, type HalfCubeDocument } from "./types.ts";

/** "d3": the name of a dimension number. */
export const parameterName = (number: number): string => `d${number}`;

/** The name a dimension is shown with: d3, or its id for a dimension that has no number yet (an old document before it is migrated). */
export const dimensionName = (d: Pick<Dimension, "id" | "number">): string => (d.number !== undefined ? parameterName(d.number) : d.id);

function dimensionsOf(doc: HalfCubeDocument): Dimension[] {
  const out: Dimension[] = [];
  for (const feature of doc.timeline) if (feature.type === "sketch") for (const c of feature.sketch.constraints) if (isDimension(c)) out.push(c);
  return out;
}

/** The highest number any dimension of the document carries (-1 when none has one). */
export function highestParameterNumber(doc: HalfCubeDocument): number {
  return dimensionsOf(doc).reduce((top, d) => Math.max(top, d.number ?? -1), -1);
}

/** The next number to hand out: the stored counter, but never one that is taken already. */
export function nextParameterOf(doc: HalfCubeDocument): number {
  return Math.max(doc.nextParameter ?? 0, highestParameterNumber(doc) + 1);
}

/**
 * The document with every dimension numbered: dimensions without a number (documents from before the names) get one in creation
 * order (timeline order, then the order of the sketch's constraint list, which is the order they were made in), after the highest
 * number in use, and the counter is raised. A document that is numbered already is returned as it is (the same object).
 */
export function numberDimensions(doc: HalfCubeDocument): HalfCubeDocument {
  let next = nextParameterOf(doc);
  let changed = false;
  const timeline = doc.timeline.map((feature) => {
    if (feature.type !== "sketch" || !feature.sketch.constraints.some((c) => isDimension(c) && c.number === undefined)) return feature;
    changed = true;
    return {
      ...feature,
      sketch: { ...feature.sketch, constraints: feature.sketch.constraints.map((c) => (isDimension(c) && c.number === undefined ? { ...c, number: next++ } : c)) },
    };
  });
  if (!changed && (doc.nextParameter ?? 0) >= next) return doc;
  return { ...doc, timeline: changed ? timeline : doc.timeline, nextParameter: next };
}
