// The timeline as a list of steps, built from the document and the step states of the last rebuild. A sketch is ONE step
// what is inside it (lines, circles, dimensions, constraints) is listed as its inner steps, in the order they were
// made. The document records them (sketch.steps), so a rectangle is one inner step, not four lines and four constraints.
import { isDimension, type ShapeKind } from "../../document/index.ts";
import type { Dimension, PartcraftDocument, SketchData, SketchFeature } from "../../document/types.ts";
import type { StepStatus } from "../../engine/generated/protocol.ts";
import type { GlyphName } from "../../ui/glyph-data.ts";
import type { StepState } from "./tree-model.ts";

export type SubStepKind = "line" | "construction" | "rectangle" | "circle" | "dimension" | "reference" | "constraint";

export interface SubStep {
  /** The step id ("s5") or, for an element without a recorded step, the element id ("l6", "d12"). */
  id: string;
  kind: SubStepKind;
  glyph: GlyphName;
  label: string;
}

export interface TimelineStep {
  featureId: string;
  kind: "sketch" | "extrude";
  glyph: GlyphName;
  label: string;
  state: StepState | "unknown";
  /** Only sketches have inner steps. */
  subSteps: SubStep[];
  /** A step that is still being made in a dialog (not in the document yet): shown at the end, marked as in progress. */
  draft?: boolean;
}

export interface TimelineText {
  /** The bare kind words: for an element that has no numbered shape (documents from before the numbers). */
  line: string;
  construction: string;
  rectangle: string;
  circle: string;
  /** The name of a numbered shape, "Rechteck 1"; a construction line is named with that and its kind. */
  shape: (kind: ShapeKind, number: number) => string;
  constructionNamed: (name: string) => string;
  /** A dimension by its automatic name and value, "d3 · 40 mm" (a reference dimension has its value in brackets). */
  dimension: (d: Dimension) => string;
  /** A constraint with what it holds together, "Parallel: Rechteck 1, Linie 3". */
  constraint: (sketch: SketchData, kind: string, refs: readonly string[]) => string;
}

export const constraintGlyph: Record<string, GlyphName> = {
  coincident: "cCoincident",
  pointOnCurve: "cOnCurve",
  horizontal: "cHorizontal",
  vertical: "cVertical",
  parallel: "cParallel",
  perpendicular: "cPerpendicular",
  equal: "cEqual",
  fix: "cFix",
};

const idNumber = (id: string): number => {
  const n = Number(id.slice(1));
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
};

/** One entry for an element that belongs to no recorded step (documents from before the steps were recorded). */
function elementSubStep(feature: SketchFeature, id: string, text: TimelineText): SubStep | null {
  const s = feature.sketch;
  const line = s.lines.find((l) => l.id === id);
  if (line) return line.construction ? { id, kind: "construction", glyph: "line", label: text.construction } : { id, kind: "line", glyph: "line", label: text.line };
  if (s.circles.some((c) => c.id === id)) return { id, kind: "circle", glyph: "circle", label: text.circle };
  const c = s.constraints.find((x) => x.id === id);
  if (!c) return null;
  if (isDimension(c)) return { id, kind: c.driving ? "dimension" : "reference", glyph: "dimension", label: text.dimension(c) };
  return { id, kind: "constraint", glyph: constraintGlyph[c.kind] ?? "cFix", label: text.constraint(s, c.kind, c.refs) };
}

/**
 * The steps inside a sketch, in the order they were made. The document records them (sketch.steps): a rectangle is ONE step
 * with its four lines and constraints as members. Elements that no step knows (older documents, which have no record) are
 * listed one entry each, in the order of their ids; the id numbers come from one counter that never goes backwards.
 */
export function sketchSubSteps(feature: SketchFeature, text: TimelineText): SubStep[] {
  const s = feature.sketch;
  const keyed: { key: number; sub: SubStep }[] = [];
  const covered = new Set<string>();
  for (const step of s.steps ?? []) {
    for (const m of step.members) covered.add(m);
    const key = Math.min(...step.members.map(idNumber), idNumber(step.id));
    const first = (letter: string) => step.members.find((m) => m.startsWith(letter));
    let sub: SubStep | null = null;
    switch (step.kind) {
      case "line": {
        const id = first("l");
        const line = id ? s.lines.find((l) => l.id === id) : undefined;
        const name = step.number !== undefined ? text.shape("line", step.number) : null;
        sub = line?.construction
          ? { id: step.id, kind: "construction", glyph: "line", label: name ? text.constructionNamed(name) : text.construction }
          : { id: step.id, kind: "line", glyph: "line", label: name ?? text.line };
        break;
      }
      case "rectangle":
        sub = { id: step.id, kind: "rectangle", glyph: "rectangle", label: step.number !== undefined ? text.shape("rectangle", step.number) : text.rectangle };
        break;
      case "circle":
        sub = { id: step.id, kind: "circle", glyph: "circle", label: step.number !== undefined ? text.shape("circle", step.number) : text.circle };
        break;
      case "constraint": {
        const id = step.members.find((m) => s.constraints.some((c) => c.id === m && !isDimension(c)));
        const c = s.constraints.find((x) => x.id === id);
        if (c) sub = { id: step.id, kind: "constraint", glyph: constraintGlyph[c.kind] ?? "cFix", label: text.constraint(s, c.kind, c.refs) };
        break;
      }
      case "dimension": {
        const id = step.members.find((m) => s.constraints.some((c) => c.id === m && isDimension(c)));
        const e = id ? elementSubStep(feature, id, text) : null;
        if (e) sub = { ...e, id: step.id };
        break;
      }
    }
    if (sub) keyed.push({ key, sub });
  }
  const loose = [...s.lines.map((l) => l.id), ...s.circles.map((c) => c.id), ...s.constraints.map((c) => c.id)].filter((id) => !covered.has(id));
  for (const id of loose) {
    const sub = elementSubStep(feature, id, text);
    if (sub) keyed.push({ key: idNumber(id), sub });
  }
  return keyed.sort((a, b) => a.key - b.key).map((k) => k.sub);
}

/** An extrusion being made in its dialog: it is not in the document until OK, but the timeline already shows where it will go. */
export interface DraftStep {
  featureId: string;
  label: string;
}

export function buildTimeline(doc: PartcraftDocument, steps: readonly StepStatus[], text: TimelineText, draft?: DraftStep | null): TimelineStep[] {
  const stateOf = new Map(steps.map((s) => [s.featureId, s.state]));
  const built = doc.timeline.map((f): TimelineStep => {
    const state = stateOf.get(f.id) ?? "unknown";
    return f.type === "sketch"
      ? { featureId: f.id, kind: "sketch", glyph: "pencil", label: f.name, state, subSteps: sketchSubSteps(f, text) }
      : { featureId: f.id, kind: "extrude", glyph: "fnExtrude", label: f.name, state, subSteps: [] };
  });
  // A draft of a step that exists already (an extrusion being edited) is that step itself, not a second one.
  if (draft && !doc.timeline.some((f) => f.id === draft.featureId)) {
    built.push({ featureId: draft.featureId, kind: "extrude", glyph: "fnExtrude", label: draft.label, state: "unknown", subSteps: [], draft: true });
  }
  return built;
}

/** Steps whose rebuild failed or warned, in timeline order. */
export function problemSteps(steps: readonly StepStatus[]): StepStatus[] {
  return steps.filter((s) => s.state === "error" || s.state === "warning");
}
