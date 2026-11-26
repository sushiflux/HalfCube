// Constraint tools ("Abhängigkeiten"): the user picks the references one after the other, and when the last one is picked
// the constraint is added. Only the kinds the engine supports. The same rules apply when the constraint is applied to
// what is selected already (constraintFromSelection).
import { SKETCH_AXIS_U, SKETCH_AXIS_V, SKETCH_ORIGIN, type ConstraintKind } from "../../document/types.ts";
import type { SketchHit } from "../../viewport/sketch/types.ts";
import { BaseTool, type PromptId, type Pointer, type ToolContext, type ToolId } from "./tool.ts";

export type RefKind = "point" | "line" | "circle" | "axis";
export interface Ref {
  /** Engine reference: "p3", "l4", "c2", "@origin", "@axisU", "@axisV". */
  id: string;
  kind: RefKind;
}

export function refOfHit(hit: SketchHit | null): Ref | null {
  if (!hit) return null;
  if (hit.kind === "point") return { id: hit.id, kind: "point" };
  if (hit.kind === "origin") return { id: SKETCH_ORIGIN, kind: "point" };
  if (hit.kind === "line") return { id: hit.id, kind: "line" };
  if (hit.kind === "circle") return { id: hit.id, kind: "circle" };
  if (hit.kind === "axis") return { id: hit.axis === "u" ? SKETCH_AXIS_U : SKETCH_AXIS_V, kind: "axis" };
  return null;
}

/** The kind of a sketch element from its id letter (p point, l line, c circle). */
export function refOfId(id: string): Ref | null {
  if (id.startsWith("p")) return { id, kind: "point" };
  if (id.startsWith("l")) return { id, kind: "line" };
  if (id.startsWith("c")) return { id, kind: "circle" };
  return null;
}

export type ConstraintToolId = Extract<ToolId, ConstraintKind>;

interface Spec {
  /** How many references the constraint takes. */
  need: 1 | 2;
  /** Can this be the first reference of a valid constraint? */
  first(ref: Ref): boolean;
  /** The references in the order the engine wants them, or null when they do not make a valid constraint. */
  resolve(refs: readonly Ref[]): string[] | null;
}

const isCurve = (r: Ref): boolean => r.kind === "line" || r.kind === "circle";
const distinct = (a: Ref, b: Ref): boolean => a.id !== b.id;

export const constraintSpecs: Record<ConstraintToolId, Spec> = {
  coincident: {
    need: 2,
    first: (r) => r.kind === "point",
    resolve: ([a, b]) => (a && b && a.kind === "point" && b.kind === "point" && distinct(a, b) ? [a.id, b.id] : null),
  },
  pointOnCurve: {
    need: 2,
    first: (r) => r.kind === "point" || isCurve(r),
    resolve: ([a, b]) => {
      if (!a || !b) return null;
      if (a.kind === "point" && isCurve(b)) return [a.id, b.id];
      if (b.kind === "point" && isCurve(a)) return [b.id, a.id];
      return null;
    },
  },
  horizontal: { need: 1, first: (r) => r.kind === "line", resolve: ([a]) => (a && a.kind === "line" ? [a.id] : null) },
  vertical: { need: 1, first: (r) => r.kind === "line", resolve: ([a]) => (a && a.kind === "line" ? [a.id] : null) },
  fix: { need: 1, first: (r) => r.kind !== "axis", resolve: ([a]) => (a && a.kind !== "axis" ? [a.id] : null) },
  parallel: {
    need: 2,
    first: (r) => r.kind === "line" || r.kind === "axis",
    resolve: ([a, b]) => lineLine(a, b),
  },
  perpendicular: {
    need: 2,
    first: (r) => r.kind === "line" || r.kind === "axis",
    resolve: ([a, b]) => lineLine(a, b),
  },
  equal: {
    need: 2,
    first: (r) => r.kind === "line" || r.kind === "circle",
    resolve: ([a, b]) => (a && b && a.kind === b.kind && (a.kind === "line" || a.kind === "circle") && distinct(a, b) ? [a.id, b.id] : null),
  },
};

function lineLine(a: Ref | undefined, b: Ref | undefined): string[] | null {
  if (!a || !b || !distinct(a, b)) return null;
  const ok = (r: Ref) => r.kind === "line" || r.kind === "axis";
  // Two fixed axes would say nothing about the sketch; one of them has to be a line.
  if (!ok(a) || !ok(b) || (a.kind === "axis" && b.kind === "axis")) return null;
  return [a.id, b.id];
}

/** The references of a constraint made from what is selected now, or null when the selection does not fit the kind. */
export function constraintFromSelection(kind: ConstraintToolId, selection: readonly string[]): string[] | null {
  const refs = selection.map(refOfId);
  if (refs.some((r) => r === null) || refs.length !== constraintSpecs[kind].need) return null;
  return constraintSpecs[kind].resolve(refs as Ref[]);
}

export class ConstraintTool extends BaseTool {
  private picks: Ref[] = [];
  private working = false;

  readonly id: ConstraintToolId;

  constructor(ctx: ToolContext, id: ConstraintToolId) {
    super(ctx);
    this.id = id;
  }

  inProgress(): boolean {
    return this.picks.length > 0;
  }

  reset(): void {
    this.picks = [];
  }

  prompt(): PromptId {
    return this.id;
  }

  override highlight(): string[] {
    return this.picks.filter((p) => p.kind !== "axis" && p.id !== SKETCH_ORIGIN).map((p) => p.id);
  }

  override async down(pointer: Pointer): Promise<void> {
    if (this.working) return;
    const ref = refOfHit(pointer.hit);
    if (!ref) return;
    const spec = constraintSpecs[this.id];
    if (this.picks.length === 0) {
      if (spec.first(ref)) this.picks = [ref];
      else return;
    } else {
      if (spec.need === 2 && spec.resolve([this.picks[0]!, ref]) === null) return;
      this.picks = [...this.picks, ref];
    }
    if (this.picks.length < spec.need) return;
    const refs = spec.resolve(this.picks);
    this.picks = [];
    if (!refs) return;
    this.working = true;
    try {
      await this.ctx.run({ kind: "constraint" }, () => this.ctx.editor.addConstraint(this.id, refs));
    } finally {
      this.working = false;
    }
  }
}
