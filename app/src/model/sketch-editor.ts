// Sketch editor: every change of an open sketch follows "solve first, then commit":
//   1. build the proposed sketch (current sketch plus the change),
//   2. solve it with sketch.solve,
//   3. solved: commit the change together with the solved positions as one undo step (the solved positions are
//      written back, so an under-defined sketch does not jump on the next change and undo restores exactly);
//      not solved (conflicting, redundant, unsolvable): nothing is committed, the outcome names the constraints.
// The document therefore never holds a sketch that was contradictory when it was committed.
//
// Edits run one after the other. Typing a dimension is a live preview through LatestOnly (latest value wins, stale
// answers are dropped) and never touches the document; Enter commits, Esc restores. The model is not rebuilt while
// the sketch is open (ModelSync.hold); finish() releases it.
//
// Dimension labels: the tools and the view work with absolute points (where the pointer is, where the number is drawn); the
// document keeps each label relative to the geometry it measures (document/dimension-label.ts), so a label follows its
// geometry through every move, drag, solve and typed value. The editor converts when a label is set (addDimension, moveLabel,
// the dimensions of addLine and addCircle) and the view is built with the label points on the solved geometry (sketch-view.ts).
//
// Every solve of the editor also asks for the closed regions (view.profiles, with their "determined" flag and
// outlines): sketch mode highlights the determined ones.
//
// One user action that needs several edits (a rectangle and the dimensions typed with it) runs inside an undo group
// (beginGroup, group): the edits stay separate commits with their own sketch steps, but the store makes them one undo step.
//
// Dragging a point (beginDrag, see drag-session.ts) is a live preview too, through its own LatestOnly lane. The
// document is touched once, by end().
import type { Reply } from "../engine/client.ts";
import type { SketchSolveResult } from "../engine/generated/protocol.ts";
import type { WatchdogClock } from "../engine/watchdog.ts";
import type { DocumentStore, UndoGroup } from "../document/store.ts";
import {
  isDimension,
  SKETCH_AXIS_U,
  SKETCH_ORIGIN,
  type ConstraintKind,
  type Dimension,
  type DimensionKind,
  type GeometricConstraint,
  type IdKind,
  type Quantity,
  type SketchConstraint,
  type SketchData,
  type SketchFeature,
  type SketchPoint,
  type SketchStep,
  type Vec2,
} from "../document/types.ts";
import { angleSectorAt } from "../document/angle-sector.ts";
import { isShapeStep, nextShapeNumber, numberShapes, reconcileForms } from "../document/shape-names.ts";
import { geometryOf, labelPlacement, measuredSegment } from "../document/dimension-label.ts";
import { sketchFeature, withSketch } from "./doc-edit.ts";
import { DragSession } from "./drag-session.ts";
import type { EditOutcome, LineOptions, PointInput, SketchDrag, SketchEditor, SketchView } from "./editors.ts";
import { SKETCH_SOLVE_TIMEOUT_MS, type EngineLink } from "./engine-link.ts";
import { LatestOnly } from "./latest-only.ts";
import { applySolved, sketchViewOf } from "./sketch-view.ts";

export interface SketchEditorDeps {
  link: EngineLink;
  store: DocumentStore;
  clock?: WatchdogClock;
}

type Solve = Reply<"sketch.solve">;

/** Result of building a proposed sketch: the new sketch, or why the edit is not possible. */
type Build = { sketch: SketchData } | { invalid: string };

class Invalid extends Error {}

const LABEL_OFFSET_MM = 6;

function engineError(e: unknown): EditOutcome {
  return { ok: false, reason: "engine", error: e instanceof Error ? e : new Error(String(e)) };
}

function rejected(r: SketchSolveResult): EditOutcome {
  return {
    ok: false,
    reason: "rejected",
    problem: r.problem ?? {
      code: r.status === "redundant" ? "sketch_redundant" : r.status === "conflicting" ? "sketch_conflicting" : "sketch_unsolvable",
      message: `The sketch was not solved (status ${r.status}).`,
    },
    conflicting: r.conflicting,
    redundant: r.redundant,
  };
}

export { applySolved, sketchViewOf };

export class SketchEditorImpl implements SketchEditor {
  readonly sketchId: string;
  private view: SketchView;
  /** View of the committed sketch, restored by cancelPreview(). */
  private committedView: SketchView;
  /** The sketch the committed view shows (to notice undo and redo). */
  private basis: SketchData;
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly preview: LatestOnly<SketchData, Solve>;
  private lastPreview: { id: string; value: Quantity } | null = null;
  private readonly cleanup: (() => void)[] = [];
  private finished = false;
  private readonly deps: SketchEditorDeps;
  private readonly release: () => void;
  /** The drag in progress, if any; other edits answer invalid while it runs. */
  private activeDrag: DragSession | null = null;
  /** The undo group this editor opened and has not closed yet (finish() closes it). */
  private editGroup: UndoGroup | null = null;

  private constructor(deps: SketchEditorDeps, feature: SketchFeature, view: SketchView, release: () => void) {
    this.deps = deps;
    this.release = release;
    this.sketchId = feature.id;
    this.basis = feature.sketch;
    this.view = view;
    this.committedView = view;
    this.preview = new LatestOnly<SketchData, Solve>({
      clock: deps.clock,
      send: (sketch) => this.request(sketch),
      cancel: (id) => deps.link.cancel(id),
    });
    this.cleanup.push(deps.store.subscribe(() => this.onDocumentChange()));
    this.cleanup.push(
      deps.link.onReady(() => {
        // A restarted engine: the open preview is sent again; the committed view needs nothing.
        if (this.lastPreview) this.previewDimension(this.lastPreview.id, this.lastPreview.value);
      }),
    );
  }

  /** Opens the sketch: one solve with diagnosis for the element states. release is called by finish(). */
  static async open(deps: SketchEditorDeps, sketchId: string, release: () => void): Promise<SketchEditorImpl> {
    const feature = sketchFeature(deps.store.getSnapshot(), sketchId);
    if (!feature) {
      release();
      throw new Error(`The document has no sketch "${sketchId}".`);
    }
    let reply: Solve;
    try {
      reply = await deps.link.request(
        { type: "sketch.solve", sketch: feature.sketch, plane: feature.plane, diagnose: true, profiles: true },
        { timeoutMs: SKETCH_SOLVE_TIMEOUT_MS },
      ).reply;
    } catch (e) {
      release();
      throw e;
    }
    return new SketchEditorImpl(deps, feature, sketchViewOf(feature, feature.sketch, reply.message, false, reply.payload), release);
  }

  getView = (): SketchView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  // ------------------------------------------------------------------------------------------------ edits

  addLine(a: PointInput, b: PointInput, opts: LineOptions = {}): Promise<EditOutcome> {
    return this.edit((s) => {
      const draft = new Draft(s, this.deps.store);
      const p1 = draft.point(a);
      const p2 = draft.point(b);
      if (p1 === p2) throw new Invalid("A line needs two different points.");
      const id = draft.id("l");
      draft.sketch.lines.push({ id, p1, p2, construction: opts.construction ?? false });
      const A = draft.position(p1);
      const B = draft.position(p2);
      const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
      const len = Math.hypot(B.x - A.x, B.y - A.y) || 1;
      const normal = { x: -(B.y - A.y) / len, y: (B.x - A.x) / len };
      if (opts.length) {
        if (opts.length.unit !== "mm" || !(opts.length.value > 0)) throw new Invalid("A line length must be a positive length in mm.");
        draft.dimension("distance", [id], opts.length, { x: mid.x + normal.x * LABEL_OFFSET_MM, y: mid.y + normal.y * LABEL_OFFSET_MM });
      }
      if (opts.angle) {
        if (opts.angle.unit !== "deg") throw new Invalid("A line angle must be an angle in deg.");
        const a360 = ((opts.angle.value % 360) + 360) % 360;
        if (a360 === 0 || a360 === 180) draft.constraint("horizontal", [id]);
        else if (a360 === 90 || a360 === 270) draft.constraint("vertical", [id]);
        else draft.dimension("angle", [SKETCH_AXIS_U, id], opts.angle, { x: A.x + LABEL_OFFSET_MM * 2, y: A.y + LABEL_OFFSET_MM });
      }
      return { sketch: draft.finish("line") };
    });
  }

  addRectangle(corner1: PointInput, corner2: PointInput): Promise<EditOutcome> {
    return this.edit((s) => {
      const draft = new Draft(s, this.deps.store);
      const a = draft.point(corner1);
      const c = draft.point(corner2);
      const A = draft.position(a);
      const C = draft.position(c);
      if (A.x === C.x || A.y === C.y) throw new Invalid("The two corners of a rectangle must differ in both directions.");
      const b = draft.newPoint(C.x, A.y);
      const d = draft.newPoint(A.x, C.y);
      const l1 = draft.line(a, b);
      const l2 = draft.line(b, c);
      const l3 = draft.line(c, d);
      const l4 = draft.line(d, a);
      draft.constraint("horizontal", [l1]);
      draft.constraint("horizontal", [l3]);
      draft.constraint("vertical", [l2]);
      draft.constraint("vertical", [l4]);
      return { sketch: draft.finish("rectangle") };
    });
  }

  addCircle(center: PointInput, diameter: Quantity, opts: { construction?: boolean } = {}): Promise<EditOutcome> {
    return this.edit((s) => {
      if (diameter.unit !== "mm" || !(diameter.value > 0)) throw new Invalid("A circle diameter must be a positive length in mm.");
      const draft = new Draft(s, this.deps.store);
      const m = draft.point(center);
      const id = draft.id("c");
      const r = diameter.value / 2;
      draft.sketch.circles.push({ id, center: m, radius: r, construction: opts.construction ?? false });
      const M = draft.position(m);
      draft.dimension("diameter", [id], diameter, { x: M.x + r * 0.7071 + LABEL_OFFSET_MM, y: M.y + r * 0.7071 + LABEL_OFFSET_MM });
      return { sketch: draft.finish("circle") };
    });
  }

  addConstraint(kind: ConstraintKind, refs: string[]): Promise<EditOutcome> {
    return this.edit((s) => {
      const draft = new Draft(s, this.deps.store);
      for (const r of refs) draft.requireRef(r);
      draft.constraint(kind, refs);
      return { sketch: draft.finish("constraint") };
    });
  }

  addDimension(kind: DimensionKind, refs: string[], value: Quantity | null, label: Vec2, opts: { driving?: boolean } = {}): Promise<EditOutcome> {
    const driving = opts.driving ?? true;
    return this.serial(async () => {
      const current = this.current();
      const draft = new Draft(current.sketch, this.deps.store);
      let ordered = [...refs];
      let q = value;
      let reverse: boolean[] | undefined;
      try {
        for (const r of ordered) draft.requireRef(r);
        if (kind === "angle" && ordered.length === 2) {
          // Which of the four angles between the two lines: the one in the sector the label lies in.
          const sector = angleSectorAt(ordered, [label.x, label.y], geometryOf(draft.sketch));
          if (!sector) throw new Invalid("The two lines run parallel: they have no angle.");
          ordered = sector.refs;
          reverse = sector.reverse;
        }
        if (kind === "distance" && ordered.length === 2) {
          const segment = measuredSegment(ordered, geometryOf(draft.sketch));
          if (!segment) throw new Invalid("There is nothing to measure between these two: the distance has no direction.");
          if (segment.crossing) throw new Invalid("The two circles cross: there is no gap between them to measure.");
        }
        if (q === null) {
          // Measure first: the same dimension as a reference dimension, which never moves anything.
          const probe = new Draft(current.sketch, this.deps.store, false);
          const probeId = "d0";
          probe.sketch.constraints.push({ id: probeId, kind, refs: ordered, value: unitFor(kind, 1), driving: false, label: { x: 0, y: 0 }, ...(reverse ? { reverse } : {}) }); // the engine does not read labels
          const measured = await this.solveRaw(current, probe.sketch, false);
          const m = measured.message.reference[probeId];
          if (measured.message.status !== "solved" || m === undefined) return rejected(measured.message);
          q = unitFor(kind, m);
        }
        if ((kind === "distanceX" || kind === "distanceY") && q.value < 0) {
          // The sign carries the direction: keep the typed size positive by naming the points the other way round.
          ordered = [...ordered].reverse();
          q = { ...q, value: -q.value };
        }
        checkValue(kind, q, reverse !== undefined);
      } catch (e) {
        if (e instanceof Invalid) return { ok: false, reason: "invalid", message: e.message } as const;
        return engineError(e);
      }
      const id = draft.id("d");
      draft.sketch.constraints.push({
        id, kind, refs: ordered, value: q, driving, number: this.deps.store.newParameterNumber(),
        label: labelPlacement(kind, ordered, label, geometryOf(draft.sketch), reverse),
        ...(reverse ? { reverse } : {}),
      });
      return this.solveAndCommit(current, draft.finish("dimension"));
    });
  }

  previewDimension(id: string, value: Quantity): void {
    if (this.finished) return;
    const d = this.basis.constraints.find((c): c is Dimension => c.id === id && isDimension(c));
    if (!d || !d.driving) return;
    try {
      checkValue(d.kind, value, d.reverse !== undefined);
    } catch {
      return; // not a valid intermediate value: the sketch stays where it was
    }
    this.lastPreview = { id, value };
    const sketch = withDimensionValue(this.basis, id, value);
    const feature = this.current();
    void this.preview.submit(sketch).then((r) => {
      if (r.kind !== "done" || this.lastPreview === null) return;
      const m = r.value.message;
      if (m.status === "solved") {
        this.setView(sketchViewOf(feature, applySolved(sketch, m), m, true, r.value.payload));
      } else {
        // Keep the last shown geometry; show why this value does not work.
        this.setView({ ...this.view, status: m.status, ...(m.problem ? { problem: m.problem } : {}), preview: true });
      }
    });
  }

  cancelPreview(): void {
    this.lastPreview = null;
    this.preview.reset();
    this.setView(this.committedView);
  }

  setDimension(id: string, value: Quantity): Promise<EditOutcome> {
    return this.edit((s) => {
      const d = s.constraints.find((c): c is Dimension => c.id === id && isDimension(c));
      if (!d) throw new Invalid(`The sketch has no dimension "${id}".`);
      checkValue(d.kind, value, d.reverse !== undefined);
      return { sketch: withDimensionValue(s, id, value) };
    });
  }

  setDriving(id: string, driving: boolean): Promise<EditOutcome> {
    return this.edit((s) => {
      const d = s.constraints.find((c): c is Dimension => c.id === id && isDimension(c));
      if (!d) throw new Invalid(`The sketch has no dimension "${id}".`);
      if (d.driving === driving) return { sketch: s };
      // A reference dimension that becomes driving takes the measured value, so nothing moves.
      const measured = this.committedView.dimensions.find((x) => x.id === id)?.measured;
      const value = driving && measured !== undefined ? unitFor(d.kind, measured) : d.value;
      return { sketch: replaceConstraint(s, { ...d, driving, value }) };
    });
  }

  moveLabel(id: string, label: Vec2): Promise<EditOutcome> {
    return this.serial(async () => {
      const current = this.current();
      const d = current.sketch.constraints.find((c): c is Dimension => c.id === id && isDimension(c));
      if (!d) return { ok: false, reason: "invalid", message: `The sketch has no dimension "${id}".` } as const;
      // The label is display only; the engine does not read it, so no solve is needed.
      const sketch = replaceConstraint(current.sketch, { ...d, label: labelPlacement(d.kind, d.refs, label, geometryOf(current.sketch), d.reverse) });
      this.basis = sketch;
      this.deps.store.commit((doc) => withSketch(doc, this.sketchId, sketch));
      const view: SketchView = {
        ...this.committedView,
        dimensions: this.committedView.dimensions.map((x) => (x.id === id ? { ...x, label } : x)),
      };
      this.committedView = view;
      this.setView(view);
      return { ok: true } as const;
    });
  }

  remove(ids: string[]): Promise<EditOutcome> {
    return this.edit((s) => ({ sketch: removeElements(s, new Set(ids)) }));
  }

  beginDrag(pointIds: string[]): SketchDrag {
    const refuse = (message: string): SketchDrag => ({
      moveTo: () => undefined,
      end: () => Promise.resolve({ ok: false, reason: "invalid", message }),
      cancel: () => undefined,
    });
    if (this.finished) return refuse("The sketch editor is finished.");
    if (this.activeDrag) return refuse("Another drag is still in progress.");
    if (pointIds.length === 0) return refuse("A drag needs at least one point.");
    const known = new Set(this.basis.points.map((p) => p.id));
    for (const id of pointIds) if (!known.has(id)) return refuse(`The sketch has no point "${id}".`);
    if (new Set(pointIds).size !== pointIds.length) return refuse("A point can only be dragged once.");
    // A pending dimension preview is dropped: the drag starts from the committed sketch.
    this.lastPreview = null;
    this.preview.reset();
    this.setView(this.committedView);
    const session = new DragSession({
      link: this.deps.link,
      clock: this.deps.clock,
      feature: () => this.current(),
      basis: this.basis,
      pointIds,
      // The engine leaves the facts of what is still free out of drag steps: the ones of the committed sketch stay while it runs.
      show: (view) => this.setView({ ...view, freedom: this.committedView.freedom }),
      commit: (solved) => this.endDrag(solved),
      restore: () => this.setView(this.committedView),
      done: () => {
        this.activeDrag = null;
      },
    });
    this.activeDrag = session;
    return session;
  }

  /** end() of a drag: one solve with states and regions, then one undo step; nothing when no point moved. */
  private endDrag(sketch: SketchData | null): Promise<EditOutcome> {
    return this.serial(async () => {
      if (sketch === null || sketch === this.basis) {
        this.setView(this.committedView);
        return { ok: true } as const;
      }
      return this.solveAndCommit(this.current(), sketch);
    }, true);
  }

  beginGroup(): UndoGroup {
    if (this.finished) throw new Error("The sketch editor is finished.");
    const group = this.deps.store.beginGroup();
    this.editGroup = group;
    return group;
  }

  async group<T>(action: () => Promise<T>): Promise<T> {
    const group = this.beginGroup();
    try {
      return await action();
    } finally {
      group.close();
    }
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    await this.queue.catch(() => undefined);
    this.finished = true;
    this.editGroup?.close();
    this.editGroup = null;
    this.lastPreview = null;
    this.preview.reset();
    this.activeDrag?.abort();
    for (const c of this.cleanup.splice(0)) c();
    this.release();
  }

  // ------------------------------------------------------------------------------------------------ internals

  private current(): SketchFeature {
    const f = sketchFeature(this.deps.store.getSnapshot(), this.sketchId);
    if (!f) throw new Invalid(`The sketch "${this.sketchId}" is no longer in the document.`);
    return f;
  }

  private request(sketch: SketchData) {
    const f = this.current();
    return this.deps.link.request(
      { type: "sketch.solve", sketch, plane: f.plane, diagnose: true, profiles: true },
      { timeoutMs: SKETCH_SOLVE_TIMEOUT_MS },
    );
  }

  /** profiles default to the same as diagnose: the regions are only useful with the element states. */
  private solveRaw(feature: SketchFeature, sketch: SketchData, diagnose: boolean, profiles = diagnose): Promise<Solve> {
    return this.deps.link.request(
      { type: "sketch.solve", sketch, plane: feature.plane, diagnose, profiles },
      { timeoutMs: SKETCH_SOLVE_TIMEOUT_MS },
    ).reply;
  }

  /** Runs fn after every earlier edit. */
  private serial(fn: () => Promise<EditOutcome>, duringDrag = false): Promise<EditOutcome> {
    if (this.finished) return Promise.resolve({ ok: false, reason: "invalid", message: "The sketch editor is finished." });
    if (this.activeDrag && !duringDrag) {
      return Promise.resolve({ ok: false, reason: "invalid", message: "A drag is in progress; end or cancel it first." });
    }
    const run = this.queue.then(async () => {
      this.lastPreview = null;
      this.preview.reset();
      try {
        return await fn();
      } catch (e) {
        if (e instanceof Invalid) return { ok: false, reason: "invalid", message: e.message } as const;
        return engineError(e);
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private edit(build: (s: SketchData) => Build): Promise<EditOutcome> {
    return this.serial(async () => {
      const feature = this.current();
      let b: Build;
      try {
        b = build(feature.sketch);
      } catch (e) {
        if (e instanceof Invalid || e instanceof RangeError) return { ok: false, reason: "invalid", message: e.message } as const;
        throw e;
      }
      if ("invalid" in b) return { ok: false, reason: "invalid", message: b.invalid } as const;
      if (b.sketch === feature.sketch) return { ok: true } as const;
      return this.solveAndCommit(feature, b.sketch);
    });
  }

  private async solveAndCommit(feature: SketchFeature, proposed: SketchData): Promise<EditOutcome> {
    let reply: Solve;
    try {
      reply = await this.solveRaw(feature, proposed, true);
    } catch (e) {
      this.setView(this.committedView);
      return engineError(e);
    }
    const m = reply.message;
    if (m.status !== "solved") {
      this.setView(this.committedView);
      return rejected(m);
    }
    // The Form numbers follow the sketch: groups of shapes may have merged, split or shrunk with this edit.
    const solved = reconcileForms(applySolved(proposed, m));
    const view = sketchViewOf(feature, solved, m, false, reply.payload);
    this.basis = solved;
    this.committedView = view;
    this.deps.store.commit((doc) => withSketch(doc, this.sketchId, solved));
    this.setView(view);
    return { ok: true };
  }

  /** Undo or redo changed the sketch under the editor: show the document's sketch again. */
  private onDocumentChange(): void {
    if (this.finished) return;
    const f = sketchFeature(this.deps.store.getSnapshot(), this.sketchId);
    if (!f || f.sketch === this.basis) return;
    const sketch = f.sketch;
    this.basis = sketch;
    // The document changed under a running drag (undo, redo): the drag is void.
    this.activeDrag?.abort();
    void this.serial(async () => {
      const reply = await this.solveRaw(f, sketch, true);
      if (this.basis !== sketch) return { ok: true } as const;
      const view = sketchViewOf(f, sketch, reply.message, false, reply.payload);
      this.committedView = view;
      this.setView(view);
      return { ok: true } as const;
    });
  }

  private setView(view: SketchView): void {
    if (view === this.view) return;
    this.view = view;
    for (const l of [...this.listeners]) l();
  }
}

// ---------------------------------------------------------------------------------------------------- helpers

/** A mutable copy of a sketch for one edit; ids come from the store's counter (never reused). */
class Draft {
  readonly sketch: SketchData;
  private readonly store: DocumentStore;
  private readonly allocate: boolean;
  /** Every element id this draft handed out, in creation order: the members of the step finish() records. */
  private readonly created: string[] = [];

  constructor(s: SketchData, store: DocumentStore, allocate = true) {
    // A document written before sketch steps existed has no steps; the first new step starts the list.
    // A sketch from before the shape numbers is numbered first (in creation order), so a new shape never takes a number twice.
    const n = numberShapes(s);
    this.sketch = {
      points: [...n.points], lines: [...n.lines], circles: [...n.circles], constraints: [...n.constraints], steps: [...(n.steps ?? [])],
      ...(n.shapeCounts ? { shapeCounts: n.shapeCounts } : {}),
      ...(n.forms ? { forms: n.forms } : {}),
    };
    this.store = store;
    this.allocate = allocate;
  }

  id(kind: IdKind): string {
    if (!this.allocate) throw new Error("This draft does not allocate ids.");
    const id = this.store.newId(kind);
    this.created.push(id);
    return id;
  }

  /** Closes the edit: appends exactly one step with every element created since the draft was opened. */
  finish(kind: SketchStep["kind"]): SketchData {
    const step: SketchStep = { id: this.store.newId("s"), kind, members: [...this.created] };
    if (isShapeStep(step)) {
      // The shape's name for good: the next number of its kind, counted in the sketch so deleting never frees one.
      const next = nextShapeNumber(this.sketch, step.kind);
      step.number = next.number;
      this.sketch.shapeCounts = next.shapeCounts;
    }
    this.sketch.steps = [...(this.sketch.steps ?? []), step];
    return this.sketch;
  }

  newPoint(x: number, y: number): string {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Invalid("A point needs finite coordinates.");
    const id = this.id("p");
    this.sketch.points.push({ id, x, y });
    return id;
  }

  point(input: PointInput): string {
    if ("snap" in input) {
      if (input.snap === SKETCH_ORIGIN) {
        const id = this.newPoint(0, 0);
        this.constraint("coincident", [id, SKETCH_ORIGIN]);
        return id;
      }
      if (!this.sketch.points.some((p) => p.id === input.snap)) throw new Invalid(`The sketch has no point "${input.snap}".`);
      return input.snap;
    }
    const id = this.newPoint(input.x, input.y);
    if ("onCurve" in input) {
      if (!this.isCurve(input.onCurve)) throw new Invalid(`The sketch has no line or circle "${input.onCurve}".`);
      this.constraint("pointOnCurve", [id, input.onCurve]);
    }
    return id;
  }

  position(id: string): SketchPoint {
    const p = this.sketch.points.find((q) => q.id === id);
    if (!p) throw new Invalid(`The sketch has no point "${id}".`);
    return p;
  }

  line(p1: string, p2: string): string {
    const id = this.id("l");
    this.sketch.lines.push({ id, p1, p2, construction: false });
    return id;
  }

  constraint(kind: ConstraintKind, refs: string[]): string {
    const id = this.id("k");
    const c: GeometricConstraint = { id, kind, refs };
    this.sketch.constraints.push(c);
    return id;
  }

  /** label: the absolute point the number is to sit at on the geometry of this draft; it is stored relative to it. */
  dimension(kind: DimensionKind, refs: string[], value: Quantity, label: Vec2): string {
    const id = this.id("d");
    this.sketch.constraints.push({ id, kind, refs, value, driving: true, number: this.store.newParameterNumber(), label: labelPlacement(kind, refs, label, geometryOf(this.sketch)) });
    return id;
  }

  isCurve(id: string): boolean {
    return this.sketch.lines.some((l) => l.id === id) || this.sketch.circles.some((c) => c.id === id);
  }

  requireRef(id: string): void {
    if (id.startsWith("@")) return;
    const s = this.sketch;
    if (s.points.some((p) => p.id === id) || this.isCurve(id)) return;
    throw new Invalid(`The sketch has no point, line or circle "${id}".`);
  }
}

function unitFor(kind: DimensionKind, value: number): Quantity {
  return { value, unit: kind === "angle" ? "deg" : "mm" };
}

function checkValue(kind: DimensionKind, q: Quantity, rays = false): void {
  const unit = kind === "angle" ? "deg" : "mm";
  if (q.unit !== unit) throw new Invalid(`A ${kind} dimension needs a value in ${unit}, got ${q.unit}.`);
  if (!Number.isFinite(q.value)) throw new Invalid(`A ${kind} dimension needs a finite value.`);
  if (rays && (q.value < 0 || q.value > 180)) throw new Invalid(`An angle between two lines is from 0 to 180 degrees, got ${q.value}.`);
  if ((kind === "distance" || kind === "diameter" || kind === "radius") && !(q.value > 0)) {
    throw new Invalid(`A ${kind} dimension needs a value greater than 0, got ${q.value}.`);
  }
}

function replaceConstraint(s: SketchData, c: SketchConstraint): SketchData {
  return { ...s, constraints: s.constraints.map((x) => (x.id === c.id ? c : x)) };
}

function withDimensionValue(s: SketchData, id: string, value: Quantity): SketchData {
  return { ...s, constraints: s.constraints.map((c) => (c.id === id && isDimension(c) ? { ...c, value } : c)) };
}

/**
 * Removes elements and everything that depends on them: lines and circles on a removed point, the end points that
 * only the removed curves used, and every constraint or dimension that refers to something removed. List order of
 * the rest is kept.
 */
export function removeElements(s: SketchData, ids: Set<string>): SketchData {
  const removed = new Set(ids);
  const lines = s.lines.filter((l) => !removed.has(l.id) && !removed.has(l.p1) && !removed.has(l.p2));
  const circles = s.circles.filter((c) => !removed.has(c.id) && !removed.has(c.center));
  const used = new Set<string>();
  for (const l of lines) used.add(l.p1).add(l.p2);
  for (const c of circles) used.add(c.center);
  const freed = new Set<string>();
  for (const l of s.lines) if (!lines.includes(l)) [l.p1, l.p2].forEach((p) => freed.add(p));
  for (const c of s.circles) if (!circles.includes(c)) freed.add(c.center);
  for (const l of s.lines) if (!lines.includes(l)) removed.add(l.id);
  for (const c of s.circles) if (!circles.includes(c)) removed.add(c.id);
  for (const p of freed) if (!used.has(p)) removed.add(p);
  const points = s.points.filter((p) => !removed.has(p.id));
  const constraints = s.constraints.filter((c) => !removed.has(c.id) && !c.refs.some((r) => removed.has(r)));
  const counts = { ...(s.shapeCounts ? { shapeCounts: s.shapeCounts } : {}), ...(s.forms ? { forms: s.forms } : {}) };
  if (!s.steps) return { points, lines, circles, constraints, ...counts };
  // Take the removed ids out of the steps; a step that has lost all its members is dropped.
  const alive = new Set<string>();
  for (const list of [points, lines, circles, constraints]) for (const x of list) alive.add(x.id);
  const steps: SketchStep[] = [];
  for (const st of s.steps) {
    const members = st.members.filter((m) => alive.has(m));
    if (members.length === st.members.length) steps.push(st);
    else if (members.length > 0) steps.push({ ...st, members });
  }
  return { points, lines, circles, constraints, steps, ...counts };
}

