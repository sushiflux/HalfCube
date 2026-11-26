// The browser tree as a flat list of rows, built from the document and the step states of the last rebuild. Pure and
// testable. One component for now (the root); the structure already has the component as its top row, so more of them
// slot in later. Origin planes and axes are fixed: they are not stored in the document.
import type { StepStatus } from "../../engine/generated/protocol.ts";
import type { PartcraftDocument, OriginPlane } from "../../document/types.ts";

export type TreeRowKind = "component" | "origin" | "plane" | "axis" | "folder" | "sketch" | "body";
export type StepState = "ok" | "warning" | "error" | "skipped";

export interface TreeRow {
  /** Unique and stable, e.g. "component:root", "plane:xy", "sketch:f1", "folder:sketches". */
  id: string;
  kind: TreeRowKind;
  label: string;
  /** 0 for the component. */
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  plane?: OriginPlane;
  axis?: "x" | "y" | "z";
  /** The timeline step behind a sketch or body row. */
  featureId?: string;
  bodyId?: string;
  state?: StepState;
}

export interface TreeText {
  origin: string;
  planes: Record<OriginPlane, string>;
  axes: Record<"x" | "y" | "z", string>;
  sketches: string;
  bodies: string;
}

export interface TreeInput {
  doc: PartcraftDocument;
  steps: readonly StepStatus[];
  /** Ids of folders and rows that are open. Rows that are not listed are closed. */
  expanded: ReadonlySet<string>;
  text: TreeText;
}

export const planeOrder: readonly OriginPlane[] = ["xy", "xz", "yz"];

/** Rows that are open when the window starts. */
export const initiallyExpanded: readonly string[] = ["component:root", "folder:sketches", "folder:bodies"];

export function buildTree({ doc, steps, expanded, text }: TreeInput): TreeRow[] {
  const stateOf = new Map(steps.map((s) => [s.featureId, s.state]));
  const rows: TreeRow[] = [];
  const open = (id: string) => expanded.has(id);
  const component = doc.components[0];
  const sketches = doc.timeline.filter((f) => f.type === "sketch");
  const bodies = component?.bodies ?? [];

  rows.push({ id: "component:root", kind: "component", label: component?.name ?? "", depth: 0, hasChildren: true, expanded: open("component:root") });
  if (!open("component:root")) return rows;

  rows.push({ id: "origin", kind: "origin", label: text.origin, depth: 1, hasChildren: true, expanded: open("origin") });
  if (open("origin")) {
    for (const plane of planeOrder) rows.push({ id: `plane:${plane}`, kind: "plane", label: text.planes[plane], depth: 2, hasChildren: false, expanded: false, plane });
    for (const axis of ["x", "y", "z"] as const) rows.push({ id: `axis:${axis}`, kind: "axis", label: text.axes[axis], depth: 2, hasChildren: false, expanded: false, axis });
  }

  if (sketches.length > 0) {
    rows.push({ id: "folder:sketches", kind: "folder", label: text.sketches, depth: 1, hasChildren: true, expanded: open("folder:sketches") });
    if (open("folder:sketches")) {
      for (const f of sketches) {
        const state = stateOf.get(f.id);
        rows.push({ id: `sketch:${f.id}`, kind: "sketch", label: f.name, depth: 2, hasChildren: false, expanded: false, featureId: f.id, ...(state ? { state } : {}) });
      }
    }
  }

  if (bodies.length > 0) {
    rows.push({ id: "folder:bodies", kind: "folder", label: text.bodies, depth: 1, hasChildren: true, expanded: open("folder:bodies") });
    if (open("folder:bodies")) {
      for (const b of bodies) {
        const state = stateOf.get(b.createdBy);
        rows.push({ id: `body:${b.id}`, kind: "body", label: b.name, depth: 2, hasChildren: false, expanded: false, bodyId: b.id, featureId: b.createdBy, ...(state ? { state } : {}) });
      }
    }
  }
  return rows;
}
