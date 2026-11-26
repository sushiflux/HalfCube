// Line, rectangle and circle: the three tools that draw by two points (start, then end) and accept typed values while the
// rubber band follows the pointer. Click-click and press-drag-release both work. Snapping goes to existing points,
// the origin and curves only (snap.ts).
import { deg, mm } from "../../document/index.ts";
import type { LineOptions } from "../../model/index.ts";
import type { SketchPreview } from "../../viewport/sketch/types.ts";
import { liveCircle, liveLine, liveRectangle } from "./field-layout.ts";
import { angleDeg, distance, dot, length, mid, polar, sub, type P } from "./geometry.ts";
import { anchorOf, anchorOfPoint, directionAngle, inferDirection, type Anchor, type Direction } from "./snap.ts";
import { BaseTool, type LiveField, type PromptId, type Pointer } from "./tool.ts";
import { TypedFields } from "./typed-fields.ts";

/** Press-drag-release counts as a drawing gesture when the pointer moved at least this far (CSS px). */
const DRAG_DRAW_PX = 6;
const EPSILON_MM = 1e-6;

abstract class TwoPointTool extends BaseTool {
  declare readonly typed: TypedFields;
  protected start: Anchor | null = null;
  protected cursor: Pointer | null = null;
  private pressed: { x: number; y: number } | null = null;
  private working = false;

  inProgress(): boolean {
    return this.start !== null;
  }

  reset(): void {
    this.start = null;
    this.pressed = null;
    this.typed.close();
  }

  override hover(pointer: Pointer): void {
    this.cursor = pointer;
  }

  /** Where the pointer is in the sketch, snapped like the end of the shape (null before the first move). */
  protected pointerAt(): P | null {
    return this.cursor ? anchorOf(this.cursor, this.ctx.view()).at : null;
  }

  override async down(pointer: Pointer): Promise<void> {
    if (this.working) return;
    this.cursor = pointer;
    if (!this.start) {
      this.start = anchorOf(pointer, this.ctx.view());
      this.pressed = { x: pointer.x, y: pointer.y };
      return;
    }
    this.pressed = null;
    await this.finish();
  }

  override async up(pointer: Pointer): Promise<void> {
    const pressed = this.pressed;
    this.pressed = null;
    if (!pressed || !this.start || this.working) return;
    if (Math.hypot(pointer.x - pressed.x, pointer.y - pressed.y) < DRAG_DRAW_PX) return;
    this.cursor = pointer;
    await this.finish();
  }

  override async commitTyped(): Promise<void> {
    if (!this.start || this.working || !this.typed.hasValues) return;
    await this.finish();
  }

  private async finish(): Promise<void> {
    this.working = true;
    try {
      await this.commit();
    } finally {
      this.working = false;
    }
  }

  /** Sends the element to the editor and resets or continues the tool. */
  protected abstract commit(): Promise<void>;
}

// ------------------------------------------------------------------------------------------------------ line

interface LineEnd {
  anchor: Anchor;
  direction: Direction;
  length?: ReturnType<typeof mm>;
  angle?: ReturnType<typeof deg>;
}

/** Chain of segments: every click ends one segment and starts the next. Esc ends the chain. */
export class LineTool extends TwoPointTool {
  readonly id = "line" as const;
  override readonly typed = new TypedFields([
    { id: "length", kind: "length", sign: "positive" },
    { id: "angle", kind: "angle", sign: "any" },
  ]);

  prompt(): PromptId {
    return this.start ? "lineEnd" : "lineStart";
  }

  private end(): LineEnd | null {
    const start = this.start;
    const cursor = this.cursor;
    if (!start || !cursor) return null;
    const s = start.at;
    const length_ = this.typed.value("length");
    const angle = this.typed.value("angle");
    const under = anchorOf(cursor, this.ctx.view());
    if (length_ || angle) {
      const toCursor = sub(under.at, s);
      const dir = angle ? angle.value : length(toCursor) > 0 ? angleDeg(toCursor) : 0;
      const len = length_
        ? length_.value
        : dot(toCursor, polar([0, 0], 1, dir));
      if (!(len > EPSILON_MM)) return null;
      const at = polar(s, len, dir);
      return { anchor: { kind: "free", input: { x: at[0], y: at[1] }, at }, direction: null, ...(length_ ? { length: length_ } : {}), ...(angle ? { angle } : {}) };
    }
    if (under.kind === "free") {
      const inferred = inferDirection(s, under.at, this.ctx.pxPerMm());
      if (inferred.direction) {
        return { anchor: { kind: "free", input: { x: inferred.end[0], y: inferred.end[1] }, at: inferred.end }, direction: inferred.direction };
      }
    }
    return { anchor: under, direction: null };
  }

  override preview(): SketchPreview | null {
    const end = this.end();
    const start = this.start;
    if (!start) return null;
    if (!end) return { points: [[start.at[0], start.at[1]]] };
    const hints: NonNullable<SketchPreview["hints"]> = [];
    const m = mid(start.at, end.anchor.at);
    if (end.direction) hints.push({ kind: end.direction, at: [m[0], m[1]] });
    if (end.anchor.kind === "point" || end.anchor.kind === "origin") hints.push({ kind: "coincident", at: [end.anchor.at[0], end.anchor.at[1]] });
    if (end.anchor.kind === "curve") hints.push({ kind: "onCurve", at: [end.anchor.at[0], end.anchor.at[1]] });
    return { lines: [{ a: [start.at[0], start.at[1]], b: [end.anchor.at[0], end.anchor.at[1]] }], points: [[start.at[0], start.at[1]]], hints };
  }

  override liveFields(): LiveField[] {
    const start = this.start;
    if (!start) return [];
    const to = this.end()?.anchor.at ?? this.pointerAt() ?? start.at;
    const v = sub(to, start.at);
    const len = length(v);
    const dir: P = len > EPSILON_MM ? [v[0] / len, v[1] / len] : [1, 0];
    const dims = liveLine(start.at, to, this.ctx.pxPerMm());
    return [
      // The length sits beside the middle of the rubber band, the angle behind the start point on the line's extension.
      { id: "length", value: len, dim: dims.length, at: mid(start.at, to), away: [-dir[1], dir[0]], either: true },
      { id: "angle", value: len > EPSILON_MM ? angleDeg(v) : 0, dim: dims.angle, at: start.at, away: [-dir[0], -dir[1]] },
    ];
  }

  protected async commit(): Promise<void> {
    const start = this.start;
    const end = this.end();
    if (!start || !end) return;
    if (distance(start.at, end.anchor.at) < EPSILON_MM || (start.ref !== undefined && start.ref === end.anchor.ref)) return;
    const opts: LineOptions = {};
    if (end.length) opts.length = end.length;
    if (end.angle) opts.angle = end.angle;
    else if (end.direction) opts.angle = deg(directionAngle(end.direction));
    const outcome = await this.ctx.run({ kind: "line" }, () => this.ctx.editor.addLine(start.input, end.anchor.input, opts));
    this.typed.close();
    if (!outcome.ok) {
      this.reset();
      return;
    }
    // An end on an existing point or the origin finishes the chain (a closed outline ends that way); otherwise the next
    // segment starts at the point just made, which is the end of the newest line.
    const lines = this.ctx.view().lines;
    const last = lines[lines.length - 1];
    const ended = end.anchor.kind === "point" || end.anchor.kind === "origin";
    const next = !ended && last ? anchorOfPoint(this.ctx.view(), last.p2) : null;
    if (next) this.start = next;
    else this.reset();
  }
}

// ------------------------------------------------------------------------------------------------- rectangle

interface RectEnd {
  anchor: Anchor;
  width?: ReturnType<typeof mm>;
  height?: ReturnType<typeof mm>;
}

/** Two opposite corners; the editor adds the four lines with horizontal and vertical constraints. */
export class RectangleTool extends TwoPointTool {
  readonly id = "rectangle" as const;
  override readonly typed = new TypedFields([
    { id: "width", kind: "length", sign: "positive" },
    { id: "height", kind: "length", sign: "positive" },
  ]);

  prompt(): PromptId {
    return this.start ? "rectangleEnd" : "rectangleStart";
  }

  private end(): RectEnd | null {
    const start = this.start;
    const cursor = this.cursor;
    if (!start || !cursor) return null;
    const s = start.at;
    const under = anchorOf(cursor, this.ctx.view());
    const width = this.typed.value("width");
    const height = this.typed.value("height");
    if (width || height) {
      const du = under.at[0] - s[0];
      const dv = under.at[1] - s[1];
      const w = width ? width.value : Math.abs(du);
      const h = height ? height.value : Math.abs(dv);
      if (!(w > EPSILON_MM) || !(h > EPSILON_MM)) return null;
      const at: P = [s[0] + (du < 0 ? -w : w), s[1] + (dv < 0 ? -h : h)];
      return { anchor: { kind: "free", input: { x: at[0], y: at[1] }, at }, ...(width ? { width } : {}), ...(height ? { height } : {}) };
    }
    if (Math.abs(under.at[0] - s[0]) < EPSILON_MM || Math.abs(under.at[1] - s[1]) < EPSILON_MM) return null;
    return { anchor: under };
  }

  override preview(): SketchPreview | null {
    const start = this.start;
    if (!start) return null;
    const end = this.end();
    if (!end) return { points: [[start.at[0], start.at[1]]] };
    const [a, c] = [start.at, end.anchor.at];
    const b: [number, number] = [c[0], a[1]];
    const d: [number, number] = [a[0], c[1]];
    const A: [number, number] = [a[0], a[1]];
    const C: [number, number] = [c[0], c[1]];
    const hints: NonNullable<SketchPreview["hints"]> = [];
    if (end.anchor.kind === "point" || end.anchor.kind === "origin") hints.push({ kind: "coincident", at: C });
    if (end.anchor.kind === "curve") hints.push({ kind: "onCurve", at: C });
    return {
      lines: [
        { a: A, b },
        { a: b, b: C },
        { a: C, b: d },
        { a: d, b: A },
      ],
      points: [A],
      hints,
    };
  }

  override liveFields(): LiveField[] {
    const start = this.start;
    if (!start) return [];
    const to = this.end()?.anchor.at ?? this.pointerAt() ?? start.at;
    const du = to[0] - start.at[0];
    const dv = to[1] - start.at[1];
    const centre = mid(start.at, to);
    // The width sits outside the edge through the start point, the height outside the edge through the opposite corner
    // (the same sides the dimensions of a typed rectangle get).
    const dims = liveRectangle(start.at, to);
    return [
      { id: "width", value: Math.abs(du), dim: dims.width, at: [centre[0], start.at[1]], away: [0, dv >= 0 ? -1 : 1] },
      { id: "height", value: Math.abs(dv), dim: dims.height, at: [to[0], centre[1]], away: [du >= 0 ? 1 : -1, 0] },
    ];
  }

  protected async commit(): Promise<void> {
    const start = this.start;
    const end = this.end();
    if (!start || !end) return;
    // The rectangle and the dimensions typed with it are ONE undo step: one group around the three edits. A
    // refused dimension leaves the rectangle (and the other dimension) standing; the step covers what went through.
    const ok = await this.ctx.editor.group(async () => {
      const outcome = await this.ctx.run({ kind: "rectangle" }, () => this.ctx.editor.addRectangle(start.input, end.anchor.input));
      this.typed.close();
      if (!outcome.ok) return false;
      // Typed sizes become dimensions of the first two edges (the editor adds the four lines last, in the order bottom
      // or top edge, right or left side, ...).
      const lines = this.ctx.view().lines;
      const base = lines.length - 4;
      const first = lines[base];
      const second = lines[base + 1];
      const offset = 24 / this.ctx.pxPerMm();
      if (end.width && first) {
        const above = end.anchor.at[1] < start.at[1] ? -1 : 1;
        const label = { x: (start.at[0] + end.anchor.at[0]) / 2, y: start.at[1] - above * offset };
        await this.ctx.run({ kind: "dimension", dimension: { dimKind: "distance", refs: [first.id], label, value: end.width } }, () =>
          this.ctx.editor.addDimension("distance", [first.id], end.width!, label),
        );
      }
      if (end.height && second) {
        const right = end.anchor.at[0] < start.at[0] ? -1 : 1;
        const label = { x: end.anchor.at[0] + right * offset, y: (start.at[1] + end.anchor.at[1]) / 2 };
        await this.ctx.run({ kind: "dimension", dimension: { dimKind: "distance", refs: [second.id], label, value: end.height } }, () =>
          this.ctx.editor.addDimension("distance", [second.id], end.height!, label),
        );
      }
      return true;
    });
    this.reset();
    if (ok) this.ctx.done();
  }
}

// ------------------------------------------------------------------------------------------------- circle

/** Centre first, then the size. The editor adds the diameter as a dimension. */
export class CircleTool extends TwoPointTool {
  readonly id = "circle" as const;
  override readonly typed = new TypedFields([{ id: "diameter", kind: "length", sign: "positive" }]);

  prompt(): PromptId {
    return this.start ? "circleSize" : "circleCentre";
  }

  private diameter(): { value: number; typed: boolean } | null {
    const start = this.start;
    const cursor = this.cursor;
    if (!start || !cursor) return null;
    const typed = this.typed.value("diameter");
    if (typed) return { value: typed.value, typed: true };
    const d = 2 * distance(start.at, anchorOf(cursor, this.ctx.view()).at);
    return d > EPSILON_MM ? { value: d, typed: false } : null;
  }

  override preview(): SketchPreview | null {
    const start = this.start;
    if (!start) return null;
    const d = this.diameter();
    const c: [number, number] = [start.at[0], start.at[1]];
    if (!d) return { points: [c] };
    return { circles: [{ c, r: d.value / 2 }], points: [c] };
  }

  override liveFields(): LiveField[] {
    const start = this.start;
    if (!start) return [];
    const d = this.diameter()?.value ?? 0;
    // Along the diameter towards the pointer (to the right while the pointer is on the centre), beyond the rim.
    const pointer = this.pointerAt();
    const towards: P = pointer ? sub(pointer, start.at) : [1, 0];
    const dim = liveCircle(start.at, d, towards);
    const dir = dim.shape === "diameter" ? dim.dir : ([1, 0] as const);
    return [{ id: "diameter", value: d, dim, at: [start.at[0] + (dir[0] * d) / 2, start.at[1] + (dir[1] * d) / 2], away: dir }];
  }

  protected async commit(): Promise<void> {
    const start = this.start;
    const d = this.diameter();
    if (!start || !d) return;
    await this.ctx.run({ kind: "circle" }, () => this.ctx.editor.addCircle(start.input, mm(d.value)));
    this.typed.close();
    this.reset();
    this.ctx.done();
  }
}

