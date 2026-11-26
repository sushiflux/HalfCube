// The names shapes of a sketch are shown with, in one place. A single shape drawn by one tool keeps the word of its kind and its running
// number ("Rechteck 1", "Circle 2", "Bogen 1", "Spline 1"); a group of connected shapes that was made by more than one tool is "Form 1",
// "Shape 2". The numbers are stored in the document (document/shape-names.ts); only the words are translated here. The owner may choose
// other wording; it is only here.
import { formOfShapes, shapesOfElements, type Form, type Shape } from "../../document/shape-names.ts";
import type { Translate } from "../../i18n/core.ts";
import { elementWord } from "../../model/index.ts";

export function shapeName(t: Translate, shape: Pick<Shape, "kind" | "number">): string {
  return t(`sketch.shape.${shape.kind}`, { n: shape.number });
}

export function formName(t: Translate, number: number): string {
  return t("sketch.form", { n: number });
}

/**
 * What a fact about these elements (ids of points, lines, circles) is about: the name of the one shape that owns them, or the Form that
 * holds the several shapes that do. `fallback` (the bare kind word) names what has no numbered shape (a sketch that lost its steps).
 */
export function nameOfElements(t: Translate, sketch: { shapes: readonly Shape[]; forms: readonly Form[] }, ids: readonly string[], fallback: string): string {
  const shapes = shapesOfElements(sketch.shapes, ids);
  if (shapes.length === 0) return fallback;
  if (shapes.length === 1) return shapeName(t, shapes[0]!);
  const form = formOfShapes(sketch.forms, shapes);
  return form ? formName(t, form.number) : fallback;
}

// ---- what a constraint or dimension refers to, in words -------------------------------------------------------------------------

/** One element in words: the name of the shape (or Form) that owns it; a bare kind word when no numbered shape does; never its id. */
function refName(t: Translate, sketch: { shapes: readonly Shape[]; forms: readonly Form[] }, id: string): { text: string; numbered: boolean } {
  const word = elementWord(t, id);
  if (id.startsWith("@")) return { text: word, numbered: false };
  const text = nameOfElements(t, sketch, [id], word);
  return { text, numbered: text !== word };
}

/**
 * What a constraint or dimension refers to, e.g. "Rechteck 1, Linie 3". A name is shown once: when all references lie in the same
 * shape (two sides of one rectangle) the text is "in Rechteck 1", so it is clear that the shape is meant as a whole and not
 * that the same thing was named twice. Elements of no numbered shape and the fixed references keep their kind word.
 */
export function refsText(t: Translate, sketch: { shapes: readonly Shape[]; forms: readonly Form[] }, refs: readonly string[]): string {
  const names = refs.map((id) => refName(t, sketch, id));
  const seen = new Set<string>();
  const unique = names.filter((n) => !n.numbered || (!seen.has(n.text) && seen.add(n.text)));
  const first = unique[0];
  if (refs.length >= 2 && unique.length === 1 && first?.numbered) return t("sketch.element.within", { name: first.text });
  return unique.map((n) => n.text).join(", ");
}
