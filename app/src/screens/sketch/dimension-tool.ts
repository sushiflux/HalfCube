// The dimension tool ("Maß"): what the user clicks is what is measured.
//
//   one line                      its length (a click into empty space places it)
//   one circle                    its diameter (a click into empty space places it)
//   point and point               the distance, or the horizontal or vertical distance, depending on where the label is held
//   two lines                     the angle in the sector the label is held in; two parallel lines: their distance
//   point or circle centre / line, point / circle rim, line / circle rim, circle rim / circle rim
//                                 the shortest distance (a perpendicular for a line); a circle centre is a point, a click on
//                                 the rim of a circle measures from the rim
//
// After the first pick a click on another line, circle or point picks the partner; a click into empty space places what the
// first pick alone means (length, diameter). Once the pair is complete a click places the label. The value box opens with the
// measured value; typing previews the sketch and Enter commits one undo step.
//
// The dimension is added with its current value first, so typing can move the sketch live. When the sketch already fixes that
// quantity the engine refuses it as a driving dimension (it could only be redundant: the value is the measured one), and the
// tool creates it straight away as a reference dimension: no value box, no dialog, one undo step, and a calm
// notice in the hint bar. The rejection dialog stays for a typed value that contradicts the sketch.
//
// Placing, typing and Enter are ONE undo step, although placing and the typed value are two commits: the tool opens
// an undo group before it adds the dimension and hands it to the session with the value box. The session closes it when
// the box ends. Esc keeps the dimension with its measured value (one step, as placed); Enter commits the typed value into
// the same step.
import { angleSectorAt, linesParallel } from "../../document/angle-sector.ts";
import { geometryOf } from "../../document/dimension-label.ts";
import type { UndoGroup } from "../../document/store.ts";
import type { DimensionKind } from "../../document/types.ts";
import { SKETCH_ORIGIN } from "../../document/types.ts";
import type { SketchHit, SketchPreview } from "../../viewport/sketch/types.ts";
import { refOfHit } from "./constraint-tool.ts";
import type { P } from "./geometry.ts";
import { measureDimension, pointAt, pointPairKind } from "./measure.ts";
import { BaseTool, type Ghost, type Pointer, type PromptId } from "./tool.ts";

interface Pick {
  /** Engine reference: "p3", "l4", "c2" or "@origin". */
  id: string;
  kind: "point" | "line" | "circle";
}

/** What a click picks for a dimension: points (a circle's centre too), the origin, lines and circles' rims (the axes are no dimension targets). */
function pickOf(hit: SketchHit | null): Pick | null {
  const ref = refOfHit(hit);
  return ref && ref.kind !== "axis" ? { id: ref.id, kind: ref.kind } : null;
}

/** What the picks and the label position mean: the dimension to place and its measured value (mm or degrees). */
interface Plan {
  kind: DimensionKind;
  refs: string[];
  /** An angle: which ray of each line. */
  reverse?: boolean[];
  value: number;
}

export class DimensionTool extends BaseTool {
  readonly id = "dimension" as const;
  private picks: Pick[] = [];
  private cursor: Pointer | null = null;
  private working = false;

  inProgress(): boolean {
    return this.picks.length > 0;
  }

  reset(): void {
    this.picks = [];
  }

  prompt(): PromptId {
    const [a] = this.picks;
    if (!a) return "dimensionFirst";
    if (this.picks.length === 2) return "dimensionPlace";
    return a.kind === "point" ? "dimensionSecond" : a.kind === "line" ? "dimensionLine" : "dimensionCircle";
  }

  /** Whether `b` can be the partner of `a`: another thing, and not the circle's own centre or a line's own end point. */
  private canPair(a: Pick, b: Pick): boolean {
    if (a.id === b.id) return false;
    const view = this.ctx.view();
    const owns = (x: Pick, y: Pick): boolean => {
      if (x.kind === "circle" && y.kind === "point") return view.circles.find((c) => c.id === x.id)?.center === y.id;
      if (x.kind === "line" && y.kind === "point") {
        const l = view.lines.find((q) => q.id === x.id);
        return l !== undefined && (l.p1 === y.id || l.p2 === y.id);
      }
      return false;
    };
    return !owns(a, b) && !owns(b, a);
  }

  /** What the picks measure with the label held at `label`, or null when there is no dimension (yet, or at all). */
  private plan(label: P): Plan | null {
    const view = this.ctx.view();
    const [a, b] = this.picks;
    if (!a) return null;
    const ids = this.picks.map((p) => p.id);
    const measured = (kind: DimensionKind, refs: string[]): Plan | null => {
      const value = measureDimension(view, kind, refs);
      return value === null ? null : { kind, refs, value };
    };
    if (!b) return a.kind === "circle" ? measured("diameter", ids) : a.kind === "line" ? measured("distance", ids) : null;
    if (a.kind === "point" && b.kind === "point") {
      const pa = pointAt(view, a.id);
      const pb = pointAt(view, b.id);
      if (!pa || !pb) return null;
      const kind = pointPairKind(pa, pb, label);
      // The pointer decides the direction of a horizontal or vertical distance by where it is, not by pick order.
      const swap = (kind === "distanceX" && pb[0] < pa[0]) || (kind === "distanceY" && pb[1] < pa[1]);
      return measured(kind, swap ? [b.id, a.id] : ids);
    }
    if (a.kind === "line" && b.kind === "line") {
      const g = geometryOf(view);
      if (linesParallel(ids, g)) return measured("distance", ids);
      const sector = angleSectorAt(ids, label, g);
      return sector ? { kind: "angle", refs: sector.refs, reverse: sector.reverse, value: sector.degrees } : null;
    }
    return measured("distance", ids);
  }

  override highlight(): string[] {
    return this.picks.filter((p) => p.id !== SKETCH_ORIGIN).map((p) => p.id);
  }

  override ghost(): Ghost | null {
    const cursor = this.cursor;
    if (!cursor) return null;
    const plan = this.plan(cursor.at);
    return plan ? { at: cursor.at, dimKind: plan.kind, value: plan.value, refs: plan.refs, ...(plan.reverse ? { reverse: plan.reverse } : {}) } : null;
  }

  /** The dimension's own graphics while it is placed: extension lines, dimension line with arrowheads, the angle's arc. */
  override preview(): SketchPreview | null {
    const ghost = this.ghost();
    if (!ghost) return null;
    return { dimension: { kind: ghost.dimKind, refs: ghost.refs, ...(ghost.reverse ? { reverse: ghost.reverse } : {}), label: [ghost.at[0], ghost.at[1]] } };
  }

  override hover(pointer: Pointer): void {
    this.cursor = pointer;
  }

  override async down(pointer: Pointer): Promise<void> {
    if (this.working) return;
    this.cursor = pointer;
    const pick = pickOf(pointer.hit);
    const [first] = this.picks;
    if (!first) {
      if (pick) this.picks = [pick];
      return;
    }
    if (this.picks.length === 1) {
      // A click on another thing picks the partner; into empty space places what the first pick alone means.
      if (pick && this.canPair(first, pick)) {
        this.picks.push(pick);
        return;
      }
      if (first.kind !== "point") await this.place(pointer.at);
      return;
    }
    await this.place(pointer.at);
  }

  private async place(at: P): Promise<void> {
    const plan = this.plan(at);
    if (!plan || !(plan.value > 0)) {
      // Nothing to measure: the two things have no distance (they touch, the circles cross, the point lies on the line).
      this.picks = [];
      this.ctx.notify("noDistance");
      return;
    }
    const { kind, refs } = plan;
    const label = { x: at[0], y: at[1] };
    this.working = true;
    let group: UndoGroup | null = null;
    let handedOver = false;
    try {
      group = this.ctx.editor.beginGroup();
      const outcome = await this.ctx.run(
        { kind: "dimension", dimension: { dimKind: kind, refs, label, value: null } },
        () => this.ctx.editor.addDimension(kind, refs, null, label),
        { silent: true },
      );
      this.picks = [];
      if (outcome.ok) {
        const created = this.ctx.view().dimensions.at(-1);
        this.ctx.editDimension({ id: created?.id ?? null, dimKind: kind, refs, label, initial: created ? created.value.value : plan.value, group });
        handedOver = true;
      } else if (outcome.reason === "rejected") {
        // The sketch fixes this quantity already: the dimension only measures, so it is made a reference dimension at once, in
        // the same undo group (the refused attempt left nothing behind).
        const made = await this.ctx.run(
          { kind: "dimension", dimension: { dimKind: kind, refs, label, value: null } },
          () => this.ctx.editor.addDimension(kind, refs, null, label, { driving: false }),
        );
        if (made.ok) this.ctx.notify("alreadyFixed");
      }
    } finally {
      // Not handed to a value box (a reference dimension, or refused or failed): nothing is left open.
      if (!handedOver) group?.close();
      this.working = false;
    }
  }
}
