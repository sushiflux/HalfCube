// Names of sketch elements in messages, tooltips and labels: "Parallel: Rechteck 1, Linie 3", "d3 · 40 mm". Shapes carry their numbered
// names (shape-name.ts), dimensions their automatic name d<number>; an internal element id (l4, k5, d12) is never part of a text.
// The describer works on the small structural shape both the live view (SketchView) and a stored sketch (describeSketchData) have.
import { formsOf, isDimension, parameterName, shapesOf, type Form, type Shape } from "../../document/index.ts";
import type { DimensionKind, HalfCubeDocument, Quantity, SketchData } from "../../document/types.ts";
import type { Translate } from "../../i18n/core.ts";
import { formatNumber } from "./geometry.ts";
import { refsText } from "./shape-name.ts";

export function dimensionKindLabel(t: Translate, kind: DimensionKind): string {
  return t(`sketch.dim.${kind}`);
}

/** What the describer needs of a sketch. SketchView satisfies it as it is. */
export interface DescribedSketch {
  shapes: readonly Shape[];
  forms: readonly Form[];
  constraints: readonly { id: string; kind: string; refs: readonly string[] }[];
  dimensions: readonly DescribedDimension[];
}

export interface DescribedDimension {
  id: string;
  kind: DimensionKind;
  refs: readonly string[];
  number?: number | undefined;
  value: Quantity;
  driving: boolean;
  /** Reference dimensions: the measured value (mm or deg). */
  measured?: number | undefined;
}

/** A stored sketch (document) in the shape the describer reads. */
export function describeSketchData(sketch: SketchData): DescribedSketch {
  return {
    shapes: shapesOf(sketch),
    forms: formsOf(sketch),
    constraints: sketch.constraints.filter((c) => !isDimension(c)),
    dimensions: sketch.constraints.filter(isDimension),
  };
}

/** "40 mm", "30°", "Ø40 mm", "R5 mm"; a reference dimension in brackets. */
export function dimensionValueText(d: Pick<DescribedDimension, "kind" | "value" | "driving" | "measured">, decimalComma: boolean): string {
  const value = d.driving ? d.value.value : (d.measured ?? d.value.value);
  const n = formatNumber(value, decimalComma);
  const text = d.kind === "angle" ? `${n}°` : `${d.kind === "diameter" ? "Ø" : d.kind === "radius" ? "R" : ""}${n} mm`;
  return d.driving ? text : `(${text})`;
}

/** The name of a dimension for the user: d3, never its id (a dimension that is not numbered yet is named by its kind). */
export function dimensionLabelName(t: Translate, d: Pick<DescribedDimension, "kind" | "number">): string {
  return d.number !== undefined ? parameterName(d.number) : dimensionKindLabel(t, d.kind);
}

/** "d3 · 40 mm": the text of a dimension in the timeline, in tooltips and in messages. */
export function dimensionLabel(t: Translate, d: DescribedDimension, decimalComma: boolean): string {
  return `${dimensionLabelName(t, d)} · ${dimensionValueText(d, decimalComma)}`;
}

/** A constraint in words, with what it holds together: "Parallel: Rechteck 1, Linie 3". */
export function constraintLabel(t: Translate, sketch: Pick<DescribedSketch, "shapes" | "forms">, kind: string, refs: readonly string[]): string {
  const word = t(`main.timeline.constraints.${kind as "coincident"}`);
  const what = refsText(t, sketch, refs);
  return what === "" ? word : `${word}: ${what}`;
}

/** Whether the sketch knows this constraint or dimension (the engine names the proposed dimension while solving, before it exists). */
export function knowsConstraint(sketch: Pick<DescribedSketch, "constraints" | "dimensions">, id: string): boolean {
  return sketch.constraints.some((c) => c.id === id) || sketch.dimensions.some((d) => d.id === id);
}

export function describeElement(t: Translate, sketch: DescribedSketch, id: string, decimalComma: boolean): string {
  const constraint = sketch.constraints.find((c) => c.id === id);
  if (constraint) return constraintLabel(t, sketch, constraint.kind, constraint.refs);
  const dimension = sketch.dimensions.find((d) => d.id === id);
  if (dimension) return dimensionLabel(t, dimension, decimalComma);
  // A point, line or circle: the name of the shape that owns it; the fixed references and anything unknown by their kind word.
  return refsText(t, sketch, [id]);
}

/**
 * Any id of the document in words, for problems that name elements of other steps: a timeline step by its name, an element of a
 * sketch by the same names the sketch uses (ids are unique in the whole document). An id the document does not know is named by
 * its kind, never shown.
 */
export function describeDocumentId(t: Translate, doc: HalfCubeDocument, id: string, decimalComma: boolean): string {
  const feature = doc.timeline.find((f) => f.id === id);
  if (feature) return feature.name;
  for (const f of doc.timeline) {
    if (f.type !== "sketch") continue;
    const s = f.sketch;
    const there = [...s.points, ...s.lines, ...s.circles, ...s.constraints].some((e) => e.id === id);
    if (there) return describeElement(t, describeSketchData(s), id, decimalComma);
  }
  return refsText(t, { shapes: [], forms: [] }, [id]);
}
