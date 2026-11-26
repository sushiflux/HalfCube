// Stand-ins for the sketch editor and the sketch layer. The editor keeps a tiny sketch of its own (ids from one counter,
// lines appended at the end, like the real one), records every call and can be told to refuse an edit. The layer maps
// 10 px to 1 mm with the v axis pointing up and picks from the editor's sketch with the same priority as the real layer
// (point, origin, line or circle).
import type { UndoGroup } from "../../../app/src/document/store.ts";
import type { Quantity, Vec2 } from "../../../app/src/document/types.ts";
import type { ConstraintKind, DimensionKind } from "../../../app/src/document/types.ts";
import type { EditOutcome, LineOptions, PointInput, SketchDrag, SketchEditor, SketchView } from "../../../app/src/model/index.ts";
import { measureDimension } from "../../../app/src/screens/sketch/measure.ts";
import { liveDimensionGraphic } from "../../../app/src/viewport/sketch/dimensions.ts";
import type { SketchHit, SketchLayer, SketchLayerOptions, SketchPreview } from "../../../app/src/viewport/sketch/types.ts";

export interface Call {
  name: string;
  args: unknown[];
}

export const PX_PER_MM = 10;

const frame = { origin: { x: 0, y: 0, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 } };

export class FakeEditor implements SketchEditor {
  readonly sketchId = "f1";
  calls: Call[] = [];
  /** Returns an outcome to refuse the named edit, or undefined to take it. */
  refuse: (name: string, args: unknown[]) => EditOutcome | undefined = () => undefined;
  private counter = 0;
  private listeners = new Set<() => void>();
  view: SketchView = {
    sketchId: "f1",
    plane: "xy",
    frame,
    points: [],
    lines: [],
    circles: [],
    constraints: [],
    dimensions: [],
    profiles: [],
    dof: 0,
    freedom: [],
    shapes: [],
    forms: [],
    status: "solved",
    preview: false,
  };
  /**
   * Undo steps the accepted edits made, counted the way the store counts them: every accepted edit is one step, except
   * while a group is open, where only the first one is.
   */
  undoSteps = 0;
  private openGroup: { commits: number; open: boolean } | null = null;
  drags: { moves: [number, number][]; ended: boolean; cancelled: boolean; ids: string[] }[] = [];

  private id(letter: string): string {
    this.counter += 1;
    return `${letter}${this.counter}`;
  }

  private emit(): void {
    this.view = { ...this.view };
    for (const l of [...this.listeners]) l();
  }

  getView = (): SketchView => this.view;
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private record(name: string, args: unknown[]): EditOutcome | undefined {
    this.calls.push({ name, args });
    const refused = this.refuse(name, args);
    if (!refused && name !== "moveLabel") this.step();
    return refused;
  }

  /** An accepted edit: one undo step, or a join into the open group's step. */
  private step(): void {
    const g = this.openGroup;
    if (g?.open) {
      if (g.commits === 0) this.undoSteps += 1;
      g.commits += 1;
    } else this.undoSteps += 1;
  }

  /** True while an undo group is open. */
  get grouping(): boolean {
    return this.openGroup?.open === true;
  }

  beginGroup(): UndoGroup {
    if (this.openGroup?.open) throw new Error("An undo group is already open; groups cannot be nested.");
    this.calls.push({ name: "beginGroup", args: [] });
    const state = { commits: 0, open: true };
    this.openGroup = state;
    return {
      get open() {
        return state.open;
      },
      close: () => {
        if (state.open) this.calls.push({ name: "closeGroup", args: [] });
        state.open = false;
      },
    };
  }

  async group<T>(action: () => Promise<T>): Promise<T> {
    const g = this.beginGroup();
    try {
      return await action();
    } finally {
      g.close();
    }
  }

  private point(input: PointInput): string {
    if ("snap" in input) {
      if (input.snap === "@origin") {
        const id = this.id("p");
        this.view.points.push({ id, x: 0, y: 0, state: "under" });
        return id;
      }
      return input.snap;
    }
    const id = this.id("p");
    this.view.points.push({ id, x: input.x, y: input.y, state: "under" });
    return id;
  }

  addLine(a: PointInput, b: PointInput, opts?: LineOptions): Promise<EditOutcome> {
    const refused = this.record("addLine", [a, b, opts]);
    if (refused) return Promise.resolve(refused);
    const p1 = this.point(a);
    const p2 = this.point(b);
    this.view.lines.push({ id: this.id("l"), p1, p2, construction: false, state: "under" });
    this.emit();
    return Promise.resolve({ ok: true });
  }

  addRectangle(c1: PointInput, c2: PointInput): Promise<EditOutcome> {
    const refused = this.record("addRectangle", [c1, c2]);
    if (refused) return Promise.resolve(refused);
    const a = this.point(c1);
    const c = this.point(c2);
    const A = this.view.points.find((p) => p.id === a)!;
    const C = this.view.points.find((p) => p.id === c)!;
    const b = this.point({ x: C.x, y: A.y });
    const d = this.point({ x: A.x, y: C.y });
    for (const [p1, p2] of [[a, b], [b, c], [c, d], [d, a]] as const) this.view.lines.push({ id: this.id("l"), p1, p2, construction: false, state: "under" });
    this.emit();
    return Promise.resolve({ ok: true });
  }

  addCircle(center: PointInput, diameter: Quantity): Promise<EditOutcome> {
    const refused = this.record("addCircle", [center, diameter]);
    if (refused) return Promise.resolve(refused);
    const m = this.point(center);
    this.view.circles.push({ id: this.id("c"), center: m, radius: diameter.value / 2, construction: false, state: "under" });
    this.emit();
    return Promise.resolve({ ok: true });
  }

  addConstraint(kind: ConstraintKind, refs: string[]): Promise<EditOutcome> {
    const refused = this.record("addConstraint", [kind, refs]);
    if (refused) return Promise.resolve(refused);
    this.view.constraints.push({ id: this.id("k"), kind, refs, state: "ok" });
    this.emit();
    return Promise.resolve({ ok: true });
  }

  addDimension(kind: DimensionKind, refs: string[], value: Quantity | null, label: Vec2, opts?: { driving?: boolean }): Promise<EditOutcome> {
    const refused = this.record("addDimension", [kind, refs, value, label, opts]);
    if (refused) return Promise.resolve(refused);
    const measured = measureDimension(this.view, kind, refs) ?? 1;
    this.view.dimensions.push({ id: this.id("d"), kind, refs, value: value ?? { value: measured, unit: kind === "angle" ? "deg" : "mm" }, driving: opts?.driving ?? true, label, state: "ok" });
    this.emit();
    return Promise.resolve({ ok: true });
  }

  previewDimension(id: string, value: Quantity): void {
    this.calls.push({ name: "previewDimension", args: [id, value] });
  }
  cancelPreview(): void {
    this.calls.push({ name: "cancelPreview", args: [] });
  }
  setDimension(id: string, value: Quantity): Promise<EditOutcome> {
    const refused = this.record("setDimension", [id, value]);
    return Promise.resolve(refused ?? { ok: true });
  }
  setDriving(id: string, driving: boolean): Promise<EditOutcome> {
    const refused = this.record("setDriving", [id, driving]);
    return Promise.resolve(refused ?? { ok: true });
  }
  moveLabel(id: string, label: Vec2): Promise<EditOutcome> {
    const refused = this.record("moveLabel", [id, label]);
    return Promise.resolve(refused ?? { ok: true });
  }
  remove(ids: string[]): Promise<EditOutcome> {
    const refused = this.record("remove", [ids]);
    return Promise.resolve(refused ?? { ok: true });
  }
  beginDrag(ids: string[]): SketchDrag {
    this.calls.push({ name: "beginDrag", args: [ids] });
    const d = { moves: [] as [number, number][], ended: false, cancelled: false, ids };
    this.drags.push(d);
    return {
      moveTo: (x, y) => void d.moves.push([x, y]),
      end: () => {
        d.ended = true;
        const refused = this.refuse("dragEnd", [ids]);
        if (!refused) this.step();
        return Promise.resolve(refused ?? { ok: true });
      },
      cancel: () => {
        d.cancelled = true;
      },
    };
  }
  finish(): Promise<void> {
    return Promise.resolve();
  }

  /** Seeds the sketch with points, lines and circles for a test. */
  seed(parts: { points?: [string, number, number][]; lines?: [string, string, string][]; circles?: [string, string, number][] }): void {
    for (const [id, x, y] of parts.points ?? []) this.view.points.push({ id, x, y, state: "under" });
    for (const [id, p1, p2] of parts.lines ?? []) this.view.lines.push({ id, p1, p2, construction: false, state: "under" });
    for (const [id, center, radius] of parts.circles ?? []) this.view.circles.push({ id, center, radius, construction: false, state: "under" });
    this.counter = 50;
    this.emit();
  }
}

export class FakeLayer implements SketchLayer {
  preview: SketchPreview | null = null;
  selection: string[] = [];
  hover: SketchHit | null = null;
  sketch: SketchView | null = null;
  options: SketchLayerOptions | null = null;
  private readonly editor: { readonly view: SketchView };
  constructor(editor: { readonly view: SketchView }) {
    this.editor = editor;
  }

  setSketch(view: SketchView | null, options: SketchLayerOptions): void {
    this.sketch = view;
    this.options = options;
  }
  setPreview(preview: SketchPreview | null): void {
    this.preview = preview;
  }
  setHover(hit: SketchHit | null): void {
    this.hover = hit;
  }
  setSelection(ids: string[]): void {
    this.selection = ids;
  }
  pick(x: number, y: number, tolerancePx = 8): SketchHit | null {
    const u = x / PX_PER_MM;
    const v = -y / PX_PER_MM;
    const tol = tolerancePx / PX_PER_MM;
    const view = this.editor.view;
    for (const p of view.points) if (Math.hypot(p.x - u, p.y - v) <= tol) return { kind: "point", id: p.id };
    if (Math.hypot(u, v) <= tol) return { kind: "origin" };
    const at = (id: string) => view.points.find((p) => p.id === id)!;
    for (const l of view.lines) {
      const a = at(l.p1);
      const b = at(l.p2);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((u - a.x) * dx + (v - a.y) * dy) / (dx * dx + dy * dy)));
      const px = a.x + t * dx;
      const py = a.y + t * dy;
      if (Math.hypot(px - u, py - v) <= tol) return { kind: "line", id: l.id, u: px, v: py };
    }
    for (const c of view.circles) {
      const m = at(c.center);
      const d = Math.hypot(u - m.x, v - m.y);
      if (Math.abs(d - c.radius) <= tol) return { kind: "circle", id: c.id, u: m.x + ((u - m.x) / d) * c.radius, v: m.y + ((v - m.y) / d) * c.radius };
    }
    return null;
  }
  toSketch(x: number, y: number): { u: number; v: number } | null {
    return { u: x / PX_PER_MM, v: -y / PX_PER_MM };
  }
  toScreen(u: number, v: number): { x: number; y: number } {
    return { x: u * PX_PER_MM, y: -v * PX_PER_MM };
  }
  pxPerMm(): number {
    return PX_PER_MM;
  }
  dimensionAnchors(): { id: string; x: number; y: number }[] {
    return [];
  }
  /** Where the value of each live dimension of the preview sits: the label point of its graphics, as the real layer reports it. */
  liveAnchors(): { id: string; x: number; y: number }[] {
    return (this.preview?.live ?? []).map((item) => {
      const g = liveDimensionGraphic(item.id, item.dim, 1 / PX_PER_MM, item.tone === "invalid");
      return { id: item.id, ...this.toScreen(g.label[0], g.label[1]) };
    });
  }
  constraintAnchors(): { id: string; x: number; y: number }[] {
    return [];
  }
  subscribe(): () => void {
    return () => undefined;
  }
  alignToSketch(): void {}
  focused: string[][] = [];
  focusOn(ids: readonly string[]): boolean {
    this.focused.push([...ids]);
    return true;
  }
}

/** Screen position of a sketch point of the fake layer. */
export const px = (u: number, v: number): [number, number] => [u * PX_PER_MM, -v * PX_PER_MM];
