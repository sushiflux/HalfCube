// Converts documents of earlier states of the working format. There are no saved files yet; the only documents of an
// earlier state are the ones a running session keeps in its tab's session storage (screens/main/autosave.ts).
import { geometryOf, labelPlacement } from "./dimension-label.ts";
import { numberDimensions } from "./parameter-names.ts";
import { numberShapes, reconcileForms } from "./shape-names.ts";
import { isDimension, type HalfCubeDocument, type SketchConstraint } from "./types.ts";

/**
 * A document whose dimension labels still hold absolute sketch coordinates (the first working format) with the labels
 * stored relative to the measured geometry (see dimension-label.ts). Call it once per old document, never on a new one.
 */
export function absoluteLabelsToRelative(doc: HalfCubeDocument): HalfCubeDocument {
  return {
    ...doc,
    timeline: doc.timeline.map((feature) => {
      if (feature.type !== "sketch") return feature;
      const g = geometryOf(feature.sketch);
      const constraints: SketchConstraint[] = feature.sketch.constraints.map((c) =>
        isDimension(c) ? { ...c, label: labelPlacement(c.kind, c.refs, c.label, g) } : c,
      );
      return { ...feature, sketch: { ...feature.sketch, constraints } };
    }),
  };
}

/**
 * A document whose shapes and dimensions have no numbers yet (written before the automatic names) with every shape numbered in creation
 * order, per kind, and the counts of the sketches set. A document that is numbered already is returned as it is.
 */
export function numberNamesInDocument(doc: HalfCubeDocument): HalfCubeDocument {
  return numberDimensions(numberShapesOnly(doc));
}

function numberShapesOnly(doc: HalfCubeDocument): HalfCubeDocument {
  let changed = false;
  const timeline = doc.timeline.map((feature) => {
    if (feature.type !== "sketch") return feature;
    const sketch = reconcileForms(numberShapes(feature.sketch));
    if (sketch === feature.sketch) return feature;
    changed = true;
    return { ...feature, sketch };
  });
  return changed ? { ...doc, timeline } : doc;
}
