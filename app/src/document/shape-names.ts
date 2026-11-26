// Names of the shapes of a sketch. Every line, rectangle and circle a user step drew gets a running number per kind in its sketch
// (Line 3, Rectangle 1, Circle 2), stored with the step (SketchStep.number) and counted in SketchData.shapeCounts. Shapes that hang
// together (they share points or are tied by constraints) form a group; a group of more than one shape is called Form <n>
// (SketchData.forms, counted under shapeCounts.form). All numbers are stable: never renumbered when another shape is deleted, never
// reused, kept by save, reload, undo and redo. The user sees the kind's word and the number (the word is translated where it is
// shown, see screens/sketch/shape-name.ts). Pure functions, tested in Node.
//
// What happens to a Form number when groups change (reconcileForms):
//   merge   two or more groups become one: the lowest of their numbers stays, the others are retired for good;
//   split   a group falls apart: the part with the most elements keeps the number, the other parts that still are groups of more
//           than one shape get new numbers;
//   shrink  a group shrinks to one shape: it shows its kind's name again, the number is retired.
import type { SketchData, SketchForm, SketchStep } from "./types.ts";

/** Arcs and splines have names ready (Bogen 1, Spline 1) for when the sketch can draw them; no step makes them yet. */
export type ShapeKind = "line" | "rectangle" | "circle" | "arc" | "spline";
export const shapeKinds: readonly ShapeKind[] = ["line", "rectangle", "circle", "arc", "spline"];

/** A step that drew a shape. */
export const isShapeStep = (step: SketchStep): step is SketchStep & { kind: ShapeKind } => (shapeKinds as readonly string[]).includes(step.kind);

export interface Shape {
  /** The id of the step that drew it. */
  id: string;
  kind: ShapeKind;
  number: number;
  /** Every element id the step created and that is still there (points, lines, circles, constraints). */
  members: string[];
}

/** A group of connected shapes with its Form number. */
export interface Form {
  number: number;
  /** Ids of the steps (Shape.id) of its shapes, in creation order. */
  shapes: string[];
}

/** The numbered shapes of a sketch, in creation order. */
export function shapesOf(sketch: Pick<SketchData, "steps">): Shape[] {
  const out: Shape[] = [];
  for (const step of sketch.steps ?? []) if (isShapeStep(step) && step.number !== undefined) out.push({ id: step.id, kind: step.kind, number: step.number, members: step.members });
  return out;
}

/**
 * The sketch with every shape step numbered: steps that have no number yet (documents from before the numbers) get one in
 * creation order, after the numbers already handed out of their kind; shapeCounts is raised to what was handed out. A sketch
 * that is numbered already is returned as it is (the same object), so this is safe to call on every load and every edit.
 */
export function numberShapes<T extends Pick<SketchData, "steps" | "shapeCounts">>(sketch: T): T {
  const steps = sketch.steps ?? [];
  const counts: Record<string, number> = { ...(sketch.shapeCounts ?? {}) };
  let changed = false;
  for (const step of steps) if (isShapeStep(step) && step.number !== undefined) counts[step.kind] = Math.max(counts[step.kind] ?? 0, step.number);
  const numbered = steps.map((step) => {
    if (!isShapeStep(step) || step.number !== undefined) return step;
    changed = true;
    counts[step.kind] = (counts[step.kind] ?? 0) + 1;
    return { ...step, number: counts[step.kind]! };
  });
  const raised = Object.keys(counts).some((k) => (counts[k] ?? 0) > (sketch.shapeCounts?.[k] ?? 0));
  if (!changed && !raised) return sketch;
  return { ...sketch, steps: changed ? numbered : steps, shapeCounts: counts };
}

/** The next number of a kind (or of "form"), and the counts after handing it out. */
export function nextShapeNumber(sketch: Pick<SketchData, "shapeCounts">, kind: ShapeKind | "form"): { number: number; shapeCounts: Record<string, number> } {
  const number = (sketch.shapeCounts?.[kind] ?? 0) + 1;
  return { number, shapeCounts: { ...(sketch.shapeCounts ?? {}), [kind]: number } };
}

/** The shapes (in creation order) that own at least one of the element ids. */
export function shapesOfElements(shapes: readonly Shape[], ids: readonly string[]): Shape[] {
  const wanted = new Set(ids);
  return shapes.filter((s) => s.members.some((m) => wanted.has(m)));
}

// ---- groups of connected shapes: Form 1, Form 2 ---------------------------------------------------------------------------------

interface Group {
  /** Step ids of the shapes in the group, in creation order. */
  shapes: string[];
  /** Per shape: how many points, lines and circles of it lie in the group (the weight when a group splits). */
  elements: Map<string, number>;
}

/**
 * The groups of the sketch as it is now: shapes whose elements are joined by a line or circle that uses a point, or by a driving
 * constraint or dimension that refers to both (the same connection the engine's shapes have). Single shapes are no groups.
 */
function groupsOf(sketch: SketchData): Group[] {
  const steps = (sketch.steps ?? []).filter(isShapeStep);
  const owner = new Map<string, string>();
  for (const step of steps) for (const m of step.members) owner.set(m, step.id);
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = parent.get(id) ?? id;
    if (root !== id) {
      root = find(root);
      parent.set(id, root);
    }
    return root;
  };
  const join = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const l of sketch.lines) {
    join(l.id, l.p1);
    join(l.id, l.p2);
  }
  for (const c of sketch.circles) join(c.id, c.center);
  for (const c of sketch.constraints) {
    if ("driving" in c && !c.driving) continue; // a reference dimension only measures: it connects nothing
    const refs = c.refs.filter((r) => !r.startsWith("@"));
    for (const r of refs.slice(1)) join(refs[0]!, r);
  }
  const geometry = [...sketch.points.map((p) => p.id), ...sketch.lines.map((l) => l.id), ...sketch.circles.map((c) => c.id)];
  const byRoot = new Map<string, Map<string, number>>();
  for (const id of geometry) {
    const step = owner.get(id);
    if (!step) continue;
    const root = find(id);
    const shapes = byRoot.get(root) ?? new Map<string, number>();
    shapes.set(step, (shapes.get(step) ?? 0) + 1);
    byRoot.set(root, shapes);
  }
  const order = new Map(steps.map((s, i) => [s.id, i]));
  const groups: Group[] = [];
  for (const elements of byRoot.values()) {
    if (elements.size < 2) continue;
    groups.push({ shapes: [...elements.keys()].sort((a, b) => order.get(a)! - order.get(b)!), elements });
  }
  return groups.sort((a, b) => order.get(a.shapes[0]!)! - order.get(b.shapes[0]!)!);
}

/**
 * The sketch with its Form numbers brought up to date (SketchData.forms): the groups are worked out from the sketch and matched with
 * the groups that had numbers. An old number goes to the group that has most of the old group's elements; when two old groups fall
 * into one group the lower number wins and the other is retired; groups without an old number get new ones; groups that shrank to one
 * shape lose theirs. Numbers are never reused (shapeCounts.form). The sketch itself is returned when nothing changes.
 */
export function reconcileForms(sketch: SketchData): SketchData {
  const groups = groupsOf(sketch);
  const old = [...(sketch.forms ?? [])].sort((a, b) => a.number - b.number);
  const taken = new Set<number>();
  const numberOf = new Map<Group, number>();
  for (const form of old) {
    let best: Group | null = null;
    let bestWeight = 0;
    for (const g of groups) {
      if (numberOf.has(g)) continue;
      let weight = 0;
      for (const id of form.shapes) weight += g.elements.get(id) ?? 0;
      if (weight > bestWeight) {
        best = g;
        bestWeight = weight;
      }
    }
    if (best) {
      numberOf.set(best, form.number);
      taken.add(form.number);
    }
  }
  let counts: Record<string, number> = { ...(sketch.shapeCounts ?? {}) };
  counts.form = Math.max(counts.form ?? 0, ...old.map((f) => f.number));
  for (const g of groups) {
    if (numberOf.has(g)) continue;
    counts = { ...counts, form: (counts.form ?? 0) + 1 };
    numberOf.set(g, counts.form!);
  }
  const forms: SketchForm[] = groups.map((g) => ({ number: numberOf.get(g)!, shapes: g.shapes })).sort((a, b) => a.number - b.number);
  const same =
    forms.length === old.length && forms.every((f, i) => f.number === old[i]!.number && f.shapes.length === old[i]!.shapes.length && f.shapes.every((s, j) => s === old[i]!.shapes[j]));
  if (same && (counts.form ?? 0) === (sketch.shapeCounts?.form ?? 0)) return sketch;
  const { form, ...others } = counts;
  return { ...sketch, forms, shapeCounts: form ? { ...others, form } : others };
}

/** The forms of a sketch (groups of more than one shape), as stored. */
export function formsOf(sketch: Pick<SketchData, "forms">): Form[] {
  return (sketch.forms ?? []).map((f) => ({ number: f.number, shapes: f.shapes }));
}

/** The form that holds all of the given shapes, if there is one. */
export function formOfShapes(forms: readonly Form[], shapes: readonly Shape[]): Form | undefined {
  return forms.find((f) => shapes.every((s) => f.shapes.includes(s.id)));
}
