// One drag of sketch points (SketchEditor.beginDrag). The engine keeps nothing between drag steps (a crash loses at most
// the drag), so every step is a sketch.solve with the sketch as the previous step solved it and the new pointer
// position as target of the dragged points; the engine pulls them there with soft constraints while every real
// constraint of the sketch still holds, and cuts a long way into short steps itself.
//
// - moveTo goes through a LatestOnly lane: at most one step is in the engine and one waits, a newer pointer position
//   replaces the waiting one and an answer that a newer request has overtaken is not shown. Every answer still
//   advances the sketch the next step starts from (so an overtaken answer is not wasted), which is why the request is
//   built when it is sent, not when moveTo is called.
// - The document is never touched here. end() hands the final sketch to the editor, which solves it once more with
//   the element states and commits exactly one undo step; cancel() just shows the committed sketch again.
// - Regions are asked for with every step while they are cheap; a step that spent more than DRAG_PROFILES_BUDGET_MS
//   on them makes the rest of the drag leave them out (the final solve brings them back).
import type { Reply } from "../engine/client.ts";
import type { DragTarget } from "../engine/generated/protocol.ts";
import type { WatchdogClock } from "../engine/watchdog.ts";
import type { SketchData, SketchFeature } from "../document/types.ts";
import type { DragView, EditOutcome, SketchDrag, SketchView } from "./editors.ts";
import { SKETCH_SOLVE_TIMEOUT_MS, type EngineLink } from "./engine-link.ts";
import { LatestOnly } from "./latest-only.ts";
import { applySolved, sketchViewOf } from "./sketch-view.ts";

/** Milliseconds one drag step may spend on regions before they are left out for the rest of the drag. */
export const DRAG_PROFILES_BUDGET_MS = 4;

type Solve = Reply<"sketch.solve">;

export interface DragSessionOptions {
  link: EngineLink;
  clock: WatchdogClock | undefined;
  /** The sketch step of the document (for its plane); read when a step is sent. */
  feature: () => SketchFeature;
  /** The committed sketch the drag starts from. */
  basis: SketchData;
  pointIds: string[];
  show: (view: SketchView) => void;
  /** end(): the solved sketch, or null when no point moved. Commits it as one undo step. */
  commit: (solved: SketchData | null) => Promise<EditOutcome>;
  /** Shows the committed sketch again. */
  restore: () => void;
  /** The drag is over (end, cancel or abort): the editor accepts edits again. */
  done: () => void;
}

interface Sent {
  sketch: SketchData;
  asked: boolean;
}

export class DragSession implements SketchDrag {
  private readonly opts: DragSessionOptions;
  private readonly lane: LatestOnly<{ x: number; y: number }, Solve>;
  /** Offsets of the dragged points from the first one at the start; the group keeps its shape. */
  private readonly offsets: { id: string; dx: number; dy: number }[];
  /** The sketch as the newest answer solved it; the next step starts here. */
  private sketch: SketchData;
  private readonly sent = new WeakMap<Solve, Sent>();
  private latest: Promise<unknown> | null = null;
  private askForProfiles = true;
  private moved = false;
  private failure: Error | null = null;
  private phase: "running" | "ending" | "over" = "running";

  constructor(opts: DragSessionOptions) {
    this.opts = opts;
    this.sketch = opts.basis;
    const at = new Map(opts.basis.points.map((p) => [p.id, p]));
    const first = at.get(opts.pointIds[0]!)!;
    this.offsets = opts.pointIds.map((id) => {
      const p = at.get(id)!;
      return { id, dx: p.x - first.x, dy: p.y - first.y };
    });
    this.lane = new LatestOnly<{ x: number; y: number }, Solve>({
      ...(opts.clock ? { clock: opts.clock } : {}),
      send: (target) => this.send(target),
      cancel: (id) => opts.link.cancel(id),
    });
  }

  moveTo(x: number, y: number): void {
    if (this.phase !== "running" || this.failure || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const submitted = this.lane.submit({ x, y });
    this.latest = submitted;
    void submitted.then((r) => {
      if (this.phase !== "running") return;
      if (r.kind === "failed") this.failure = r.error;
      else if (r.kind === "done") this.display(r.value);
    });
  }

  async end(): Promise<EditOutcome> {
    if (this.phase !== "running") return { ok: false, reason: "invalid", message: "The drag is already over." };
    this.phase = "ending";
    // The newest request always runs; wait until its answer is in (an overtaken one is followed by a newer one).
    for (;;) {
      const pending = this.latest;
      if (!pending) break;
      await pending;
      if (pending === this.latest) break;
    }
    const failure = this.failure;
    const solved = this.moved ? this.sketch : null;
    this.finish();
    if (failure) {
      this.opts.restore();
      return { ok: false, reason: "engine", error: failure };
    }
    return this.opts.commit(solved);
  }

  cancel(): void {
    if (this.phase === "over") return;
    this.finish();
    this.opts.restore();
  }

  /** The editor ends the drag from outside (undo during a drag, the sketch is finished). */
  abort(): void {
    this.cancel();
  }

  // ------------------------------------------------------------------------------------------------ internals

  private finish(): void {
    this.phase = "over";
    this.lane.reset();
    this.opts.done();
  }

  private send(target: { x: number; y: number }): { id: number; reply: Promise<Solve> } {
    const sketch = this.sketch;
    const asked = this.askForProfiles;
    const drag: { points: DragTarget[] } = {
      points: this.offsets.map((o) => ({ id: o.id, x: target.x + o.dx, y: target.y + o.dy })),
    };
    const handle = this.opts.link.request(
      { type: "sketch.solve", sketch, plane: this.opts.feature().plane, diagnose: true, profiles: asked, drag },
      { timeoutMs: SKETCH_SOLVE_TIMEOUT_MS },
    );
    const reply = handle.reply.then((r) => {
      this.sent.set(r, { sketch, asked });
      this.absorb(r, sketch);
      return r;
    });
    return { id: handle.id, reply };
  }

  /** Every answer advances the sketch, shown or not. A step that found no solution leaves it where it was. */
  private absorb(r: Solve, sent: SketchData): void {
    if (this.phase === "over") return;
    const m = r.message;
    if (m.status !== "solved" || !m.drag || m.drag.steps === 0) return;
    this.sketch = applySolved(sent, m);
    if (m.drag.points.some((p) => p.moved)) this.moved = true;
    if (m.profilesMs !== undefined && m.profilesMs > DRAG_PROFILES_BUDGET_MS) this.askForProfiles = false;
  }

  private display(r: Solve): void {
    const m = r.message;
    const sent = this.sent.get(r);
    if (!sent || m.status !== "solved" || !m.drag || m.drag.steps === 0) return;
    const drag: DragView = { points: m.drag.points, complete: m.drag.complete, profilesSkipped: !sent.asked };
    this.opts.show(sketchViewOf(this.opts.feature(), applySolved(sent.sketch, m), m, true, r.payload, drag));
  }
}
