// The state of the sketch as the palette tells it: a word, the line pattern of that state and a short explanation. Derived
// from the solved view only; the engine decides what "fully determined" means.
import type { SketchView } from "../../model/index.ts";

export type StatusKind = "none" | "draw" | "under" | "full" | "over" | "failed";

export interface SketchStatus {
  kind: StatusKind;
  /** Degrees of freedom to show next to the word (under-defined and fully defined sketches only). */
  dof: number | null;
}

/** drawing: a tool has begun an element but nothing is in the sketch yet. */
export function sketchStatus(view: SketchView, drawing: boolean): SketchStatus {
  if (view.status === "conflicting" || view.status === "redundant") return { kind: "over", dof: null };
  if (view.status === "failed") return { kind: "failed", dof: null };
  const empty = view.points.length === 0 && view.lines.length === 0 && view.circles.length === 0;
  if (empty) return { kind: drawing ? "draw" : "none", dof: null };
  if (view.dof === 0) return { kind: "full", dof: 0 };
  return { kind: "under", dof: view.dof };
}

/** The status kinds in the order the palette reserves room for their texts. */
export const statusKinds: readonly StatusKind[] = ["none", "draw", "under", "full", "over", "failed"];
