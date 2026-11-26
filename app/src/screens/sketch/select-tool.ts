// The default tool: a click selects, a click on nothing clears, Shift adds or removes, and pressing on a point, a line or a
// circle and moving drags it (a line moves both its end points, a circle its centre). The sketch follows the drag through
// the editor's drag session; lifting the button commits one undo step and Esc puts everything back.
import type { SketchDrag, SketchView } from "../../model/index.ts";
import { pointAt } from "./measure.ts";
import type { P } from "./geometry.ts";
import { BaseTool, type PromptId, type Pointer } from "./tool.ts";
import type { SketchHit } from "../../viewport/sketch/types.ts";

/** The pointer must move this far (CSS px) before a press becomes a drag. */
export const DRAG_START_PX = 4;

/** The id a hit selects, or null. */
export function selectableId(hit: SketchHit | null): string | null {
  if (!hit) return null;
  if (hit.kind === "point" || hit.kind === "line" || hit.kind === "circle" || hit.kind === "dimension") return hit.id;
  return null;
}

/** The points a press on this hit would drag. */
export function dragTargets(hit: SketchHit | null, view: SketchView): string[] {
  if (!hit) return [];
  if (hit.kind === "point") return [hit.id];
  if (hit.kind === "line") {
    const l = view.lines.find((q) => q.id === hit.id);
    return l ? [l.p1, l.p2] : [];
  }
  if (hit.kind === "circle") {
    const c = view.circles.find((q) => q.id === hit.id);
    return c ? [c.center] : [];
  }
  return [];
}

interface Press {
  x: number;
  y: number;
  /** Where the pointer was when pressed (sketch coordinates). */
  grab: P;
  targets: string[];
  /** Where the first dragged point was then. */
  base: P | null;
}

export class SelectTool extends BaseTool {
  readonly id = "select" as const;
  private press: Press | null = null;
  private drag: SketchDrag | null = null;
  private working = false;

  inProgress(): boolean {
    return this.drag !== null;
  }

  prompt(): PromptId {
    return "select";
  }

  reset(): void {
    this.drag?.cancel();
    this.drag = null;
    this.press = null;
  }

  override async down(pointer: Pointer): Promise<void> {
    if (this.working) return;
    const view = this.ctx.view();
    const id = selectableId(pointer.hit);
    const current = this.ctx.selection();
    if (pointer.shift) {
      if (id) this.ctx.setSelection(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
      return;
    }
    this.ctx.setSelection(id ? [id] : []);
    const targets = dragTargets(pointer.hit, view);
    if (targets.length === 0) return;
    this.press = { x: pointer.x, y: pointer.y, grab: pointer.at, targets, base: pointAt(view, targets[0]!) };
  }

  override hover(pointer: Pointer): void {
    const press = this.press;
    if (!press || !press.base) return;
    if (!this.drag) {
      if (Math.hypot(pointer.x - press.x, pointer.y - press.y) < DRAG_START_PX) return;
      this.drag = this.ctx.editor.beginDrag(press.targets);
    }
    this.drag.moveTo(press.base[0] + (pointer.at[0] - press.grab[0]), press.base[1] + (pointer.at[1] - press.grab[1]));
  }

  override async up(_pointer: Pointer): Promise<void> {
    const drag = this.drag;
    this.press = null;
    this.drag = null;
    if (!drag) return;
    this.working = true;
    try {
      await this.ctx.run({ kind: "drag" }, () => drag.end());
    } finally {
      this.working = false;
    }
  }
}
