// Contract of sketch.solve and model.sync, run against the native and the WebAssembly engine with the same
// assertions: every recorded case gives the recorded answer (native recording, so this is also the parity check
// between the engines), protocol errors name their cause, and the model layer (HalfCubeModel with its editors)
// works end to end against the real engine, including the replay after an engine crash.
import { afterAll, beforeAll, expect, it } from "vitest";
import type { CommandInput } from "../../../../app/src/engine/client.ts";
import { isCommandError } from "../../../../app/src/engine/errors.ts";
import type { ErrorMessage } from "../../../../app/src/engine/generated/protocol.ts";
import { createEmptyDocument } from "../../../../app/src/document/create.ts";
import { deg, mm } from "../../../../app/src/document/quantity.ts";
import type { EngineLink } from "../../../../app/src/model/engine-link.ts";
import type { ModelView, SketchView } from "../../../../app/src/model/editors.ts";
import { HalfCubeModelImpl } from "../../../../app/src/model/halfcube-model.ts";
import type { SketchData } from "../../../../app/src/document/types.ts";
import { documentProblems } from "../../../../app/src/document/validate.ts";
import { chain, document, ENGINE_CASES, rectangle, stress } from "../../../fixtures/engine/cases.ts";
import { answerDifferences, loadRecording } from "../../../fixtures/engine/recording.ts";
import { describeUnless } from "./builds.ts";
import { startEngine, type EngineLocation, type TestEngine } from "./harness.ts";

const SLOW = 30_000;

/** An EngineLink over a test engine; ready() tells the model layer that a (re)started engine is ready. */
export function testLink(e: TestEngine): EngineLink & { ready(): void } {
  const listeners = new Set<() => void>();
  return {
    isReady: () => e.client.state === "running",
    onReady(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request: (command, options) => e.client.request(command, options),
    cancel: (id) => {
      e.client.cancel(id).reply.catch(() => undefined);
    },
    ready: () => {
      for (const l of [...listeners]) l();
    },
  };
}

/** Resolves when the condition holds after a change (checked at once and after every notification). */
export function until<T>(subscribe: (l: () => void) => () => void, get: () => T, ok: (v: T) => boolean, what: string, ms = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const v = get();
      if (!ok(v)) return false;
      stop();
      clearTimeout(timer);
      resolve(v);
      return true;
    };
    const stop = subscribe(() => void check());
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`Timed out waiting for ${what}; last state: ${JSON.stringify(get()).slice(0, 600)}`));
    }, ms);
    check();
  });
}

function floatsClose(a: ArrayBuffer | null, b: ArrayBuffer | null): string | null {
  const x = new Uint8Array(a ?? new ArrayBuffer(0));
  const y = new Uint8Array(b ?? new ArrayBuffer(0));
  if (x.byteLength !== y.byteLength) return `payload has ${x.byteLength} bytes instead of ${y.byteLength}`;
  const fx = new Float32Array(x.buffer, x.byteOffset, x.byteLength / 4);
  const fy = new Float32Array(y.buffer, y.byteOffset, y.byteLength / 4);
  const ux = new Uint32Array(x.buffer, x.byteOffset, x.byteLength / 4);
  const uy = new Uint32Array(y.buffer, y.byteOffset, y.byteLength / 4);
  for (let i = 0; i < fx.length; i++) {
    // Indices are exact; floats (positions, normals) within 1e-5. A word is accepted when either reading matches.
    if (ux[i] === uy[i]) continue;
    if (Math.abs(fx[i]! - fy[i]!) <= 1e-5 * Math.max(1, Math.abs(fy[i]!))) continue;
    return `payload word ${i} differs (${fx[i]} / ${ux[i]} instead of ${fy[i]} / ${uy[i]})`;
  }
  return null;
}

export function defineModelContract(label: string, where: EngineLocation, skip: string | false): void {
  describeUnless(skip, `${label} engine: sketch.solve and model.sync`, () => {
    let e: TestEngine;
    let revision = 0;
    beforeAll(async () => {
      e = await startEngine(where);
    }, SLOW);
    afterAll(async () => {
      await e.client.stop();
      expect(e.schemaErrors, "every message and command matches the JSON Schema").toEqual([]);
    });

    const send = (command: CommandInput) =>
      e.client.request(command.type === "model.sync" ? { ...command, revision: ++revision } : command).reply;

    for (const c of ENGINE_CASES) {
      it(`case ${c.name} gives the recorded answer`, async () => {
        const { recorded, payload } = loadRecording(c.name);
        const reply = await send(c.command);
        expect(answerDifferences(reply.message, recorded.reply)).toEqual([]);
        expect(floatsClose(reply.payload, payload)).toBeNull();
      });
    }

    it("sketch.solve and model.sync answer within the time the design aims for", async () => {
      const times: Record<string, number[]> = { solve: [], sync: [], syncCached: [] };
      for (let i = 0; i < 20; i++) {
        const doc = document(rectangle(3, 60 + i));
        let t = performance.now();
        await send({ type: "sketch.solve", sketch: rectangle(3, 60 + i), plane: { kind: "originPlane", plane: "xy" } });
        times.solve!.push(performance.now() - t);
        t = performance.now();
        await send({ type: "model.sync", revision: 0, document: doc, purpose: "commit" });
        times.sync!.push(performance.now() - t);
        t = performance.now();
        await send({ type: "model.sync", revision: 0, document: doc, purpose: "commit" });
        times.syncCached!.push(performance.now() - t);
      }
      const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
      console.log(
        `[${label}] round trip median: sketch.solve ${median(times.solve!).toFixed(2)} ms, model.sync (sketch + extrude + mesh) ` +
          `${median(times.sync!).toFixed(2)} ms, model.sync unchanged (cache) ${median(times.syncCached!).toFixed(2)} ms`,
      );
      expect(median(times.solve!)).toBeLessThan(50);
      expect(median(times.sync!)).toBeLessThan(200);
    });

    it("refuses an old revision with stale_revision", async () => {
      const doc = document(rectangle(3));
      await send({ type: "model.sync", revision: 0, document: doc, purpose: "commit" });
      const err = await e.client.request({ type: "model.sync", revision: revision, document: doc, purpose: "commit" }).reply.catch((x: unknown) => x);
      expect(isCommandError(err) && err.code).toBe("stale_revision");
    });

    it("names the path of a malformed document field and refuses newer documents", async () => {
      const doc = document(rectangle(3)) as unknown as Record<string, unknown> & { timeline: { sketch?: { points: { x: unknown }[] } }[] };
      doc.timeline[0]!.sketch!.points[1]!.x = "a";
      const bad = await e.unchecked(() => e.client.request({ type: "model.sync", revision: ++revision, document: doc as never, purpose: "commit" }).reply).catch((x: unknown) => x);
      expect(isCommandError(bad) && bad.code).toBe("bad_document");
      expect((bad as Error).message).toMatch(/document\.timeline\[0\]\.sketch\.points\[1\]\.x/);
      const newer = { ...document(rectangle(3)), format: 2 };
      const refused = await e.unchecked(() => e.client.request({ type: "model.sync", revision: ++revision, document: newer, purpose: "commit" }).reply).catch((x: unknown) => x);
      expect(isCommandError(refused) && refused.code).toBe("unsupported_document");
      const unknown = await e.unchecked(() =>
        e.client.request({ type: "sketch.solve", sketch: { ...rectangle(0), extra: 1 } as never, plane: { kind: "originPlane", plane: "xy" } }).reply,
      ).catch((x: unknown) => x);
      expect(isCommandError(unknown) && unknown.code).toBe("bad_document");
      expect((unknown as ErrorMessage & Error).message).toMatch(/sketch/);
    });

    it("HalfCubeModel: sketch, dimensions, conflict, reference dimension, extrude, undo, redo and replay after a crash", async () => {
      // Its own engine: ModelSync counts revisions from 1, as the app does with the engine it starts.
      const own = await startEngine(where);
      const link = testLink(own);
      const model = new HalfCubeModelImpl(link, createEmptyDocument({ rootName: "Teil", documentId: "doc-contract" }), {
        names: { sketch: (n) => `Skizze${n}`, extrude: (n) => `Extrusion${n}`, body: (n) => `Körper${n}` },
      });
      const sketch = await model.startSketch("xy");
      expect(sketch.getView().status).toBe("solved");
      expect(await sketch.addRectangle({ snap: "@origin" }, { x: 58, y: 41 })).toEqual({ ok: true });
      let view: SketchView = sketch.getView();
      expect(view.dof).toBe(2);
      const [bottom, right, top] = view.lines;
      expect(await sketch.addDimension("distance", [bottom!.id], mm(60), { x: 30, y: -8 })).toEqual({ ok: true });
      expect(await sketch.addDimension("distance", [right!.id], null, { x: 70, y: 20 })).toEqual({ ok: true });
      view = sketch.getView();
      expect(view.dof).toBe(0);
      expect(view.points.every((p) => p.state === "full")).toBe(true);
      const corner = view.points.find((p) => p.id === top!.p1)!;
      expect(corner.x).toBeCloseTo(60, 9);
      expect(corner.y).toBeCloseTo(41, 9);

      // A contradicting dimension is not applied; the outcome names the constraints. As a reference it is measured.
      const undoDepth = model.document.changeCount;
      const conflict = await sketch.addDimension("distance", [top!.id], mm(50), { x: 30, y: 50 });
      expect(conflict.ok).toBe(false);
      expect(conflict.ok === false && conflict.reason === "rejected" && conflict.problem.code).toBe("sketch_conflicting");
      expect(model.document.changeCount).toBe(undoDepth);
      expect(await sketch.addDimension("distance", [top!.id], mm(50), { x: 30, y: 50 }, { driving: false })).toEqual({ ok: true });
      const ref = sketch.getView().dimensions.find((d) => !d.driving)!;
      expect(ref.measured).toBeCloseTo(60, 9);

      // Live typing follows every value; Esc restores, Enter commits one undo step.
      const width = sketch.getView().dimensions.find((d) => d.driving && d.refs[0] === bottom!.id)!;
      sketch.previewDimension(width.id, mm(80));
      const previewed = await until(sketch.subscribe, sketch.getView, (v) => v.preview, "the preview");
      expect(previewed.points.find((p) => p.id === top!.p1)!.x).toBeCloseTo(80, 9);
      sketch.cancelPreview();
      expect(sketch.getView().preview).toBe(false);
      expect(sketch.getView().points.find((p) => p.id === top!.p1)!.x).toBeCloseTo(60, 9);
      await sketch.finish();

      const extrude = model.startExtrude({ sketch: sketch.sketchId, distance: mm(10) });
      const profiles = (await until(extrude.subscribe, extrude.getView, (v) => v.profiles !== null, "the profiles")).profiles!;
      expect(profiles.map((p) => p.key)).toHaveLength(1);
      expect(profiles[0]!.area).toBeCloseTo(2460, 6);
      extrude.set({ region: profiles[0]!.key });
      expect(await extrude.commit()).toEqual({ ok: true });
      const built: ModelView = await until(
        model.subscribeModel,
        model.getModelView,
        (v) => v.purpose === "commit" && v.bodies.length === 1 && !v.pending,
        "the committed body",
      );
      expect(built.bodies[0]!.volume).toBeCloseTo(24600, 6);
      expect(built.bodies[0]!.preview).toBe(false);
      expect(built.bodies[0]!.mesh.indices.length).toBe(36);

      model.undo();
      await until(model.subscribeModel, model.getModelView, (v) => v.bodies.length === 0 && !v.pending, "no body after undo");
      model.redo();
      await until(model.subscribeModel, model.getModelView, (v) => v.bodies.length === 1 && !v.pending, "the body after redo");

      // Engine crash (test build): the model layer sends the document again once a new engine is ready; same body.
      await own.client.request({ type: "diagnostics.crash", mode: "abort" }).reply.catch(() => null);
      expect(own.client.state).toBe("down");
      await own.client.restart();
      const before = model.getModelView().revision;
      link.ready();
      const replayed = await until(model.subscribeModel, model.getModelView, (v) => v.revision > before && !v.pending, "the replay");
      expect(replayed.bodies[0]!.volume).toBeCloseTo(24600, 6);
      expect(model.sync.lastRevision).toBeGreaterThan(before);
      model.dispose();
      await own.client.stop();
      expect(own.schemaErrors).toEqual([]);
    }, SLOW);

    it("sketch mode: determined regions with outlines, dragging a point, a point that cannot move, cancel and end as one undo step", async () => {
      const own = await startEngine(where);
      const link = testLink(own);
      const model = new HalfCubeModelImpl(link, createEmptyDocument({ rootName: "Teil", documentId: "doc-drag" }), {
        names: { sketch: (n) => `Skizze${n}`, extrude: (n) => `Extrusion${n}`, body: (n) => `Körper${n}` },
      });
      const sketch = await model.startSketch("xy");
      expect(sketch.getView().profiles).toEqual([]);
      expect(await sketch.addRectangle({ x: 0, y: 0 }, { x: 60, y: 40 })).toEqual({ ok: true });
      let view = sketch.getView();
      expect(view.profiles).toHaveLength(1);
      expect(view.profiles[0]!.determined).toBe(false); // sizes and position are still free
      expect(view.profiles[0]!.loops).toHaveLength(1);
      expect(view.profiles[0]!.loops[0]!.length).toBe(8); // four corners (u, v), the first not repeated
      const [bottom, right] = view.lines;
      expect(await sketch.addDimension("distance", [bottom!.id], mm(60), { x: 30, y: -8 })).toEqual({ ok: true });
      expect(await sketch.addDimension("distance", [right!.id], mm(40), { x: 70, y: 20 })).toEqual({ ok: true });
      expect(sketch.getView().profiles[0]!.determined).toBe(false);
      expect(await sketch.addConstraint("coincident", [bottom!.p1, "@origin"])).toEqual({ ok: true }); // the last one
      view = sketch.getView();
      expect(view.dof).toBe(0);
      expect(view.profiles[0]!.determined).toBe(true);

      // A circle inside: a hole of the frame. Its centre is free until it is fixed.
      expect(await sketch.addCircle({ x: 30, y: 20 }, mm(10))).toEqual({ ok: true });
      view = sketch.getView();
      expect(view.profiles.map((p) => [p.holes.length, p.determined])).toEqual(
        expect.arrayContaining([
          [0, false],
          [1, false],
        ]),
      );
      const frame = view.profiles.find((p) => p.holes.length === 1)!;
      expect(frame.loops).toHaveLength(2);
      expect(frame.loops[1]!.length).toBeGreaterThanOrEqual(16);
      // Per loop: the rectangle is fully determined, the circle is not; the frame region keeps its determined outer loop,
      // and the whole-region flag never disagrees with its loops.
      expect(frame.loopsDetermined).toEqual([true, false]);
      expect(view.profiles.find((p) => p.holes.length === 0)!.loopsDetermined).toEqual([false]);
      for (const p of view.profiles) expect(p.determined).toBe(p.loopsDetermined.every(Boolean));
      expect(await sketch.addConstraint("fix", [view.circles[0]!.center])).toEqual({ ok: true });
      expect(sketch.getView().profiles.every((p) => p.determined)).toBe(true);
      expect(sketch.getView().profiles.every((p) => p.loopsDetermined.every(Boolean))).toBe(true);

      // A free line away from the rectangle: its end point follows the pointer.
      expect(await sketch.addLine({ x: 100, y: 0 }, { x: 120, y: 10 })).toEqual({ ok: true });
      const line = sketch.getView().lines.at(-1)!;
      const committedView = sketch.getView();
      const changes = model.document.changeCount;
      const xOf = (v: SketchView) => v.points.find((p) => p.id === line.p2)!.x;

      const drag = sketch.beginDrag([line.p2]);
      drag.moveTo(130, 30);
      const moving = await until(sketch.subscribe, sketch.getView, (v) => v.drag !== undefined, "the first drag step");
      expect(moving.preview).toBe(true);
      drag.moveTo(140, 35);
      const moved = await until(sketch.subscribe, sketch.getView, (v) => v.drag !== undefined && xOf(v) > 139.999999, "the last drag step");
      expect(moved.points.find((p) => p.id === line.p2)!.y).toBeCloseTo(35, 6);
      expect(moved.drag!.points[0]).toMatchObject({ id: line.p2, moved: true });
      expect(moved.drag!.points[0]!.error).toBeLessThan(1e-6);
      expect(moved.profiles).toHaveLength(committedView.profiles.length); // regions come with every step while they are cheap
      drag.cancel();
      expect(sketch.getView()).toBe(committedView);
      expect(model.document.changeCount).toBe(changes);

      const second = sketch.beginDrag([line.p2]);
      second.moveTo(125, 15);
      await until(sketch.subscribe, sketch.getView, (v) => v.drag !== undefined, "the drag step");
      expect(await second.end()).toEqual({ ok: true });
      expect(model.document.changeCount).toBe(changes + 1); // exactly one undo step
      expect(sketch.getView().preview).toBe(false);
      expect(sketch.getView().drag).toBeUndefined();
      expect(xOf(sketch.getView())).toBeCloseTo(125, 6);
      expect(sketch.getView().profiles.every((p) => p.determined)).toBe(true);
      model.undo();
      await until(sketch.subscribe, sketch.getView, (v) => xOf(v) === 120, "undo of the drag");

      // A corner of the fully determined rectangle cannot move: the answer says so, nothing is committed.
      const corner = sketch.getView().points.find((p) => p.id === right!.p2)!;
      const stuck = sketch.beginDrag([corner.id]);
      stuck.moveTo(corner.x + 30, corner.y + 30);
      const report = await until(sketch.subscribe, sketch.getView, (v) => v.drag !== undefined, "the report of the fixed point");
      expect(report.drag!.points[0]).toMatchObject({ id: corner.id, moved: false });
      expect(report.drag!.points[0]!.error).toBeGreaterThan(40);
      expect(report.drag!.complete).toBe(true);
      const before = model.document.changeCount;
      expect(await stuck.end()).toEqual({ ok: true });
      expect(model.document.changeCount).toBe(before);
      await sketch.finish();
      model.dispose();
      await own.client.stop();
      expect(own.schemaErrors).toEqual([]);
    }, SLOW);

    it("per loop: a fully dimensioned rectangle with two free circles inside has its outer loop determined and the holes not", async () => {
      const own = await startEngine(where);
      const link = testLink(own);
      const model = new HalfCubeModelImpl(link, createEmptyDocument({ rootName: "Teil", documentId: "doc-loops" }), {
        names: { sketch: (n) => `Skizze${n}`, extrude: (n) => `Extrusion${n}`, body: (n) => `Körper${n}` },
      });
      const sketch = await model.startSketch("xy");
      expect(await sketch.addRectangle({ snap: "@origin" }, { x: 40, y: 30 })).toEqual({ ok: true });
      const [bottom, right] = sketch.getView().lines;
      expect(await sketch.addDimension("distance", [bottom!.id], mm(40), { x: 20, y: -6 })).toEqual({ ok: true });
      expect(await sketch.addDimension("distance", [right!.id], mm(30), { x: 46, y: 15 })).toEqual({ ok: true });
      expect(await sketch.addCircle({ x: 12, y: 15 }, mm(6))).toEqual({ ok: true });
      expect(await sketch.addCircle({ x: 28, y: 15 }, mm(6))).toEqual({ ok: true });
      let view = sketch.getView();
      const [first, second] = view.circles;
      const frameOf = (v: SketchView) => v.profiles.find((p) => p.holes.length === 2)!;
      // The owner's case: the rectangle is fully determined, both circles are free (their centres can move).
      expect(view.dof).toBeGreaterThan(0);
      expect(frameOf(view).loops).toHaveLength(3);
      expect(frameOf(view).loopsDetermined).toEqual([true, false, false]);
      expect(frameOf(view).determined).toBe(false);
      for (const c of [first!, second!]) expect(view.profiles.find((p) => p.key === c.id)!.loopsDetermined).toEqual([false]);
      // Fix one centre: that hole's loop is determined too, the other stays free, whatever the order of the holes.
      expect(await sketch.addConstraint("fix", [first!.center])).toEqual({ ok: true });
      view = sketch.getView();
      const byHole = new Map(frameOf(view).holes.map((ids, i) => [ids[0], frameOf(view).loopsDetermined[i + 1]]));
      expect(frameOf(view).loopsDetermined[0]).toBe(true);
      expect(byHole.get(first!.id)).toBe(true);
      expect(byHole.get(second!.id)).toBe(false);
      expect(view.profiles.find((p) => p.key === first!.id)!.loopsDetermined).toEqual([true]);
      await sketch.finish();
      model.dispose();
      await own.client.stop();
      expect(own.schemaErrors).toEqual([]);
    }, SLOW);

    it("dimension labels follow their geometry: a drag, a typed value and an undo keep them where they were relative to it", async () => {
      const own = await startEngine(where);
      const link = testLink(own);
      const model = new HalfCubeModelImpl(link, createEmptyDocument({ rootName: "Teil", documentId: "doc-labels" }), {
        names: { sketch: (n) => `Skizze${n}`, extrude: (n) => `Extrusion${n}`, body: (n) => `Körper${n}` },
      });
      const sketch = await model.startSketch("xy");
      expect(await sketch.addRectangle({ x: 0, y: 0 }, { x: 60, y: 40 })).toEqual({ ok: true });
      const [bottom, right] = sketch.getView().lines;
      // The bottom edge's label a quarter of its length right of the middle and 8 mm below; the right edge's 10 mm to its right.
      expect(await sketch.addDimension("distance", [bottom!.id], mm(60), { x: 45, y: -8 })).toEqual({ ok: true });
      expect(await sketch.addDimension("distance", [right!.id], mm(40), { x: 70, y: 20 })).toEqual({ ok: true });
      const [d1, d2] = sketch.getView().dimensions;
      const point = (v: SketchView, id: string) => v.points.find((p) => p.id === id)!;
      /** The bottom edge's label relative to its two points as the view shows it: the share along the edge and mm to its left. */
      const bottomLabel = (v: SketchView) => {
        const a = point(v, bottom!.p1), b = point(v, bottom!.p2);
        const label = v.dimensions.find((d) => d.id === d1!.id)!.label;
        const mx = label.x - (a.x + b.x) / 2, my = label.y - (a.y + b.y) / 2;
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        return { along: (mx * (b.x - a.x) + my * (b.y - a.y)) / (length * length), side: (-mx * (b.y - a.y) + my * (b.x - a.x)) / length };
      };
      expect(bottomLabel(sketch.getView()).along).toBeCloseTo(0.25, 6);
      expect(bottomLabel(sketch.getView()).side).toBeCloseTo(-8, 6);
      // The document keeps it relative, not the point that was clicked.
      const stored = () => {
        const f = model.document.getSnapshot().timeline[0];
        return f && f.type === "sketch" ? f.sketch.constraints.flatMap((c) => ("driving" in c ? [c] : [])) : [];
      };
      expect(stored()[0]!.label.x).toBeCloseTo(0.25, 6);
      expect(stored()[0]!.label.y).toBeCloseTo(-8, 6);

      // Dragging a corner: both sizes are dimensioned, so the rectangle moves as a whole, and the labels with it.
      const labelsBefore = sketch.getView().dimensions.map((d) => d.label);
      const corner = right!.p2;
      const cornerAt = point(sketch.getView(), corner);
      const drag = sketch.beginDrag([corner]);
      drag.moveTo(cornerAt.x + 50, cornerAt.y + 30);
      await until(sketch.subscribe, sketch.getView, (v) => v.drag !== undefined && point(v, corner).x > cornerAt.x + 49.99, "the drag step");
      expect(bottomLabel(sketch.getView()).along).toBeCloseTo(0.25, 6); // live, while the drag is still a preview
      expect(await drag.end()).toEqual({ ok: true });
      const dragged = sketch.getView();
      const dx = point(dragged, corner).x - cornerAt.x, dy = point(dragged, corner).y - cornerAt.y;
      expect(Math.hypot(dx, dy)).toBeGreaterThan(10);
      dragged.dimensions.forEach((d, i) => {
        expect(d.label.x).toBeCloseTo(labelsBefore[i]!.x + dx, 6);
        expect(d.label.y).toBeCloseTo(labelsBefore[i]!.y + dy, 6);
      });

      // A typed value: 60 -> 100 mm stretches the edge; the label keeps its share of the length and its 8 mm.
      expect(await sketch.setDimension(d1!.id, mm(100))).toEqual({ ok: true });
      const longer = sketch.getView();
      expect(Math.hypot(point(longer, bottom!.p2).x - point(longer, bottom!.p1).x, point(longer, bottom!.p2).y - point(longer, bottom!.p1).y)).toBeCloseTo(100, 6);
      expect(bottomLabel(longer).along).toBeCloseTo(0.25, 6);
      expect(bottomLabel(longer).side).toBeCloseTo(-8, 6);
      // The right edge's label stays 10 mm beside its edge and at the height of its middle.
      const r1 = point(longer, right!.p1), r2 = point(longer, right!.p2);
      const rl = longer.dimensions.find((d) => d.id === d2!.id)!.label;
      expect(rl.x - r1.x).toBeCloseTo(10, 6);
      expect(rl.y).toBeCloseTo((r1.y + r2.y) / 2, 6);

      // Undo of the typed value brings the geometry back, and the label goes with it.
      model.undo();
      await until(sketch.subscribe, sketch.getView, (v) => Math.hypot(point(v, bottom!.p2).x - point(v, bottom!.p1).x, point(v, bottom!.p2).y - point(v, bottom!.p1).y) < 61, "the undo of the value");
      expect(bottomLabel(sketch.getView()).along).toBeCloseTo(0.25, 6);
      expect(bottomLabel(sketch.getView()).side).toBeCloseTo(-8, 6);
      expect(documentProblems(model.document.getSnapshot())).toEqual([]);
      await sketch.finish();
      model.dispose();
      await own.client.stop();
      expect(own.schemaErrors).toEqual([]);
    }, SLOW);

    it("distances measure what was clicked - point, line and circle in every pair - as references and as driving dimensions", async () => {
      const own = await startEngine(where);
      const link = testLink(own);
      const model = new HalfCubeModelImpl(link, createEmptyDocument({ rootName: "Teil", documentId: "doc-dimension-segment" }), {
        names: { sketch: (n) => `Skizze${n}`, extrude: (n) => `Extrusion${n}`, body: (n) => `Körper${n}` },
      });
      const sketch = await model.startSketch("xy");
      expect(await sketch.addRectangle({ snap: "@origin" }, { x: 40, y: 30 })).toEqual({ ok: true });
      const [bottom, , top] = sketch.getView().lines;
      expect(await sketch.addCircle({ x: 20, y: 15 }, mm(8))).toEqual({ ok: true });
      expect(await sketch.addCircle({ x: 60, y: 15 }, mm(6))).toEqual({ ok: true });
      const [c1, c2] = sketch.getView().circles;
      const p3 = sketch.getView().lines[1]!.p2;
      const at = { x: 30, y: 8 };
      const measured = async (refs: string[]): Promise<number> => {
        expect(await sketch.addDimension("distance", refs, null, at, { driving: false })).toEqual({ ok: true });
        return sketch.getView().dimensions.at(-1)!.measured!;
      };
      expect(await measured([c1!.center, bottom!.id])).toBeCloseTo(15, 9); // from the centre: a point of the sketch
      expect(await measured([bottom!.id, c1!.center])).toBeCloseTo(15, 9);
      expect(await measured([c1!.id, bottom!.id])).toBeCloseTo(11, 9); // from the rim: 15 - 4
      expect(await measured([bottom!.id, c1!.id])).toBeCloseTo(11, 9);
      expect(await measured([c1!.id, c2!.id])).toBeCloseTo(33, 9); // 40 between the centres, minus 4 and 3
      expect(await measured([c1!.id, c2!.center])).toBeCloseTo(36, 9); // rim of c1 to the centre of c2
      expect(await measured([p3, c1!.id])).toBeCloseTo(Math.hypot(20, 15) - 4, 9);
      expect(await measured([bottom!.id, top!.id])).toBeCloseTo(30, 9); // two parallel lines
      expect(await measured([p3, bottom!.id])).toBeCloseTo(30, 9);
      expect(documentProblems(model.document.getSnapshot())).toEqual([]);

      // Driving: the rim 6 mm from the bottom line moves the circle up to centre height 10; the second circle's centre 20 mm up.
      const before = model.document.changeCount;
      expect(await sketch.addDimension("distance", [c1!.id, bottom!.id], mm(6), at)).toEqual({ ok: true });
      expect(model.document.changeCount).toBe(before + 1);
      const y = (id: string) => sketch.getView().points.find((q) => q.id === id)!.y;
      expect(y(c1!.center)).toBeCloseTo(10, 9);
      expect(await sketch.addDimension("distance", [c2!.center, bottom!.id], mm(20), at)).toEqual({ ok: true });
      expect(y(c2!.center)).toBeCloseTo(20, 9);
      // Rim to rim: 5 mm of room between the circles, along the line through the centres.
      expect(await sketch.addDimension("distance", [c1!.id, c2!.id], mm(5), at)).toEqual({ ok: true });
      const a = sketch.getView().points.find((q) => q.id === c1!.center)!;
      const b = sketch.getView().points.find((q) => q.id === c2!.center)!;
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(4 + 3 + 5, 9);

      // A quantity the sketch already fixes is refused as a driving dimension (the tool then makes it a reference at once)
      // and taken as a reference dimension in the same breath: still one undo step for the tool's group.
      const fixed = await sketch.addDimension("distance", [c1!.id, bottom!.id], null, at);
      expect(fixed).toMatchObject({ ok: false, reason: "rejected" });
      const group = sketch.beginGroup();
      const steps = model.document.changeCount;
      expect(await sketch.addDimension("distance", [c1!.id, bottom!.id], null, at)).toMatchObject({ ok: false, reason: "rejected" });
      expect(await sketch.addDimension("distance", [c1!.id, bottom!.id], null, at, { driving: false })).toEqual({ ok: true });
      group.close();
      expect(model.document.changeCount).toBe(steps + 1);
      expect(sketch.getView().dimensions.at(-1)!.measured).toBeCloseTo(6, 9);
      expect(sketch.getView().dimensions.at(-1)!.driving).toBe(false);
      await sketch.finish();
      model.dispose();
      await own.client.stop();
      expect(own.schemaErrors).toEqual([]);
    }, SLOW);

    it("an angle measures the sector the label is in - at a fixed rectangle corner 90, never 270 - and the sector survives a drag", async () => {
      const own = await startEngine(where);
      const link = testLink(own);
      const model = new HalfCubeModelImpl(link, createEmptyDocument({ rootName: "Teil", documentId: "doc-angle-sector" }), {
        names: { sketch: (n) => `Skizze${n}`, extrude: (n) => `Extrusion${n}`, body: (n) => `Körper${n}` },
      });
      const sketch = await model.startSketch("xy");
      // The corner of a rectangle drawn round: the lines run p1 -> p2 (east) and p4 -> p1 (south) at p1, the origin.
      expect(await sketch.addRectangle({ snap: "@origin" }, { x: 60, y: 40 })).toEqual({ ok: true });
      const lines = sketch.getView().lines;
      const [l1, , , l4] = lines;
      const reference = async (refs: string[], label: { x: number; y: number }) => {
        expect(await sketch.addDimension("angle", refs, null, label, { driving: false })).toEqual({ ok: true });
        return sketch.getView().dimensions.at(-1)!;
      };
      // The rectangle is square by its horizontal and vertical constraints: a driving angle there is only redundant, so it is
      // refused (and the tool makes a reference of it at once).
      expect(await sketch.addDimension("angle", [l1!.id, l4!.id], null, { x: 5, y: 5 })).toMatchObject({ ok: false, reason: "rejected" });
      for (const label of [{ x: 5, y: 5 }, { x: -5, y: -5 }, { x: -5, y: 5 }, { x: 5, y: -5 }]) {
        const d = await reference([l1!.id, l4!.id], label);
        expect(d.measured, `label at ${label.x}, ${label.y}`).toBeCloseTo(90, 9);
        expect(d.reverse).toBeDefined();
      }
      // The flags are the rays of the sector: inside the rectangle east and (l4 turned round) north.
      expect(sketch.getView().dimensions[0]!.reverse).toEqual([false, true]);
      expect(sketch.getView().dimensions[0]!.refs).toEqual([l1!.id, l4!.id]);
      await sketch.finish();

      // Two free lines from the origin that are not square: the sector decides which of the four angles it is.
      const free = await model.startSketch("xy");
      expect(await free.addLine({ snap: "@origin" }, { x: 30, y: 5 })).toEqual({ ok: true });
      expect(await free.addLine({ snap: "@origin" }, { x: 5, y: 40 })).toEqual({ ok: true });
      const [m1, m2] = free.getView().lines;
      const direction = (id: string) => {
        const l = free.getView().lines.find((q) => q.id === id)!;
        const a = free.getView().points.find((q) => q.id === l.p1)!;
        const b = free.getView().points.find((q) => q.id === l.p2)!;
        return Math.atan2(b.y - a.y, b.x - a.x) * (180 / Math.PI);
      };
      const between = direction(m2!.id) - direction(m1!.id); // about 73.4
      for (const [label, expected] of [[{ x: 12, y: 12 }, between], [{ x: -12, y: -12 }, between], [{ x: -12, y: 12 }, 180 - between], [{ x: 12, y: -12 }, 180 - between]] as const) {
        expect(await free.addDimension("angle", [m1!.id, m2!.id], null, label, { driving: false })).toEqual({ ok: true });
        expect(free.getView().dimensions.at(-1)!.measured!, `label at ${label.x}, ${label.y}`).toBeCloseTo(expected, 6);
      }
      // Driving, in the inner sector: 60 degrees between the rays.
      expect(await free.addDimension("angle", [m1!.id, m2!.id], deg(60), { x: 12, y: 12 })).toEqual({ ok: true });
      expect(direction(m2!.id) - direction(m1!.id)).toBeCloseTo(60, 6);
      const driving = free.getView().dimensions.at(-1)!;
      // The sector survives dragging the free end of the first line round: the lines turn, the angle between the rays stays 60.
      const end = free.getView().lines.find((q) => q.id === m1!.id)!.p2;
      const endAt = free.getView().points.find((q) => q.id === end)!;
      const drag = free.beginDrag([end]);
      drag.moveTo(endAt.x - 20, endAt.y + 25);
      await until(free.subscribe, free.getView, (v) => v.drag !== undefined && v.points.find((q) => q.id === end)!.x < endAt.x - 19.99, "the drag step");
      expect(await drag.end()).toEqual({ ok: true });
      expect(direction(m2!.id) - direction(m1!.id)).toBeCloseTo(60, 6);
      expect(Math.abs(direction(m1!.id) - Math.atan2(endAt.y, endAt.x) * (180 / Math.PI))).toBeGreaterThan(5); // it did turn
      // The label of the angle went with the corner (it sits at the same share of the swept angle and distance).
      const label = free.getView().dimensions.find((d) => d.id === driving.id)!.label;
      const apex = free.getView().points.find((q) => q.id === free.getView().lines.find((l) => l.id === m1!.id)!.p1)!;
      expect(Math.hypot(label.x - apex.x, label.y - apex.y)).toBeCloseTo(Math.hypot(12, 12), 6);
      // A typed value out of 0 to 180 is refused before the engine is asked.
      expect(await free.setDimension(driving.id, deg(200))).toMatchObject({ ok: false, reason: "invalid" });
      await free.finish();
      model.dispose();
      await own.client.stop();
      expect(own.schemaErrors).toEqual([]);
    }, SLOW);

    it("what is still free (the palette's list): a free rectangle is one fact, the owner's 12 x 55 rectangle only needs its place, a circle without diameter has a free diameter", async () => {
      const own = await startEngine(where);
      const link = testLink(own);
      const model = new HalfCubeModelImpl(link, createEmptyDocument({ rootName: "Teil", documentId: "doc-freedom" }), {
        names: { sketch: (n) => `Skizze${n}`, extrude: (n) => `Extrusion${n}`, body: (n) => `Körper${n}` },
      });
      const sketch = await model.startSketch("xy");
      const facts = () => sketch.getView().freedom.map((f) => `${f.kind}${f.moves ?? ""}:${f.shape}`);
      // A rectangle somewhere, no sizes: it can be moved (one fact for the whole rectangle) and has a width and a height to give.
      expect(await sketch.addRectangle({ x: 5, y: 5 }, { x: 17, y: 60 })).toEqual({ ok: true });
      expect(sketch.getView().dof).toBe(4);
      expect(facts()).toEqual(["position2:rectangle", "length:rectangle", "length:rectangle"]);
      const lines = sketch.getView().lines;
      expect(sketch.getView().freedom[0]!.elements).toEqual(lines.map((l) => l.id));
      // The owner's rectangle: 12 x 55 dimensioned, not on the origin: only the position is left, and it is said as one fact.
      expect(await sketch.addDimension("distance", [lines[0]!.id], mm(12), { x: 11, y: 0 })).toEqual({ ok: true });
      expect(await sketch.addDimension("distance", [lines[1]!.id], mm(55), { x: 24, y: 30 })).toEqual({ ok: true });
      expect(sketch.getView().dof).toBe(2);
      expect(facts()).toEqual(["position2:rectangle"]);
      expect(sketch.getView().profiles[0]!.determined).toBe(false);
      // "Fest" on one corner fixes the position: nothing is free, the region is determined.
      expect(await sketch.addConstraint("fix", [lines[0]!.p1])).toEqual({ ok: true });
      expect(sketch.getView().dof).toBe(0);
      expect(sketch.getView().freedom).toEqual([]);
      expect(sketch.getView().profiles[0]!.determined).toBe(true);
      expect(sketch.getView().profiles[0]!.loopsDetermined).toEqual([true]);
      await sketch.finish();

      // A rectangle on the origin with sizes: nothing free. A circle whose diameter was taken away: its diameter is free.
      const second = await model.startSketch("xy");
      expect(await second.addRectangle({ snap: "@origin" }, { x: 12, y: 55 })).toEqual({ ok: true });
      const l = second.getView().lines;
      expect(await second.addDimension("distance", [l[0]!.id], mm(12), { x: 6, y: -6 })).toEqual({ ok: true });
      expect(await second.addDimension("distance", [l[1]!.id], mm(55), { x: 20, y: 27 })).toEqual({ ok: true });
      expect(second.getView().dof).toBe(0);
      expect(second.getView().freedom).toEqual([]);
      expect(await second.addCircle({ x: 6, y: 20 }, mm(8))).toEqual({ ok: true });
      expect(await second.addConstraint("fix", [second.getView().circles[0]!.center])).toEqual({ ok: true });
      expect(second.getView().freedom).toEqual([]);
      const diameter = second.getView().dimensions.find((d) => d.kind === "diameter")!;
      expect(await second.remove([diameter.id])).toEqual({ ok: true });
      expect(second.getView().freedom.map((f) => [f.kind, f.shape, f.elements])).toEqual([["radius", "circle", [second.getView().circles[0]!.id]]]);
      await second.finish();
      model.dispose();
      await own.client.stop();
      expect(own.schemaErrors).toEqual([]);
    }, SLOW);

    it("drag: 100 steps along a path with a chain of 40 links keep every link length (P04, native and WebAssembly alike)", async () => {
      const plane = { kind: "originPlane", plane: "xy" } as const;
      let sketch = chain();
      let worst = 0;
      for (let step = 1; step <= 100; step++) {
        const angle = (0.9 * Math.PI * step) / 100;
        const r = await e.client.request({
          type: "sketch.solve",
          sketch,
          plane,
          diagnose: false,
          drag: { points: [{ id: "q40", x: 150 * Math.cos(angle), y: 150 * Math.sin(angle) }] },
        }).reply;
        expect(r.message.status, `step ${step}`).toBe("solved");
        expect(r.message.drag!.complete).toBe(true);
        const at = new Map(r.message.points.map((p) => [p.id, p]));
        sketch = { ...sketch, points: sketch.points.map((p) => ({ ...p, x: at.get(p.id)!.x, y: at.get(p.id)!.y })) };
        for (let i = 0; i < 40; i++) {
          const a = at.get(`q${i}`)!;
          const b = at.get(`q${i + 1}`)!;
          worst = Math.max(worst, Math.abs(Math.hypot(b.x - a.x, b.y - a.y) - 5));
        }
      }
      expect(worst).toBeLessThan(1e-6);
    }, SLOW);

    it("drag steps and solves with regions: speed on the rectangle with a circle and on a sketch of 200 curves", async () => {
      const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
      const plane = { kind: "originPlane", plane: "xy" } as const;
      const solveWith = (command: Extract<CommandInput, { type: "sketch.solve" }>) => e.client.request(command).reply;
      const measure = async (name: string, sketch: SketchData, dragPoint: string, profilesInDrag: boolean) => {
        const rows = { solve: [] as number[], solveEngine: [] as number[], solveProfiles: [] as number[], drag: [] as number[], dragEngine: [] as number[], dragProfiles: [] as number[] };
        const solvedFrom = (s: SketchData, points: { id: string; x: number; y: number }[]): SketchData => ({
          ...s,
          points: s.points.map((p) => {
            const q = points.find((x) => x.id === p.id)!;
            return { ...p, x: q.x, y: q.y };
          }),
        });
        const first = await solveWith({ type: "sketch.solve", sketch, plane, profiles: true });
        let solved = solvedFrom(sketch, first.message.points);
        for (let i = 0; i < 20; i++) {
          const t = performance.now();
          const r = await solveWith({ type: "sketch.solve", sketch: solved, plane, profiles: true });
          rows.solve.push(performance.now() - t);
          rows.solveEngine.push(r.message.timeMs);
          rows.solveProfiles.push(r.message.profilesMs ?? 0);
        }
        // Drag steps of 1.5 mm, each from the sketch the previous step solved (as the editor sends them).
        let at = solved.points.find((p) => p.id === dragPoint)!;
        for (let i = 0; i < 20; i++) {
          const t = performance.now();
          const r = await solveWith({
            type: "sketch.solve",
            sketch: solved,
            plane,
            profiles: profilesInDrag,
            drag: { points: [{ id: dragPoint, x: at.x + 1.2, y: at.y + 0.9 }] },
          });
          rows.drag.push(performance.now() - t);
          rows.dragEngine.push(r.message.timeMs);
          rows.dragProfiles.push(r.message.profilesMs ?? 0);
          expect(r.message.status).toBe("solved");
          expect(r.message.drag!.complete).toBe(true);
          solved = solvedFrom(solved, r.message.points);
          at = solved.points.find((p) => p.id === dragPoint)!;
        }
        const ms = (k: keyof typeof rows) => median(rows[k]).toFixed(2);
        console.log(
          `[${label}] ${name}: sketch.solve with regions ${ms("solve")} ms round trip (engine ${ms("solveEngine")}, regions ${ms("solveProfiles")}); ` +
            `drag step ${profilesInDrag ? "with" : "without"} regions ${ms("drag")} ms round trip (engine ${ms("dragEngine")}, regions ${ms("dragProfiles")})`,
        );
        return { solve: median(rows.solve), drag: median(rows.drag) };
      };

      // (a) a rectangle with sizes and a circle inside; the corner p3 is dragged (the rectangle moves with it).
      const small: SketchData = rectangle(2);
      small.points.push({ id: "pc", x: 20, y: 20 });
      small.circles.push({ id: "c1", center: "pc", radius: 5, construction: false });
      small.constraints.push(
        { id: "k6", kind: "fix", refs: ["pc"] },
        { id: "d3", kind: "radius", refs: ["c1"], value: mm(5), driving: true, label: { x: 0, y: 0 } },
      );
      const a = await measure("(a) rectangle with a circle", small, "p3", true);
      // (b) 40 rectangles with a circle each (200 curves, 80 regions); the last rectangle is free and gets dragged.
      const b = await measure("(b) 200 curves", stress(), "p39_3", true);
      await measure("(b) 200 curves", stress(), "p39_3", false);
      expect(a.drag).toBeLessThan(8); // the aim of the design for a drag step on the small sketch
      expect(b.solve).toBeLessThan(500);
    }, SLOW);
  });
}

