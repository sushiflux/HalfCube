// SketchEditor.beginDrag against a scripted link (no engine process): what every drag step carries, which answers are
// shown and which only advance the sketch, how end() and cancel() treat the document, and what the view reports.
// The real engines are exercised by the contract tests (tests/unit/engine/helpers/model-contract.ts).
import { describe, expect, it } from "vitest";
import type { Reply } from "../../../app/src/engine/client.ts";
import { EngineCrashedError } from "../../../app/src/engine/errors.ts";
import type { Region, SketchSolveResult } from "../../../app/src/engine/generated/protocol.ts";
import { DocumentStore } from "../../../app/src/document/store.ts";
import type { SketchData } from "../../../app/src/document/types.ts";
import type { EngineLink } from "../../../app/src/model/engine-link.ts";
import { DRAG_PROFILES_BUDGET_MS } from "../../../app/src/model/drag-session.ts";
import { sketchFeature } from "../../../app/src/model/doc-edit.ts";
import { SketchEditorImpl } from "../../../app/src/model/sketch-editor.ts";
import { document, rectangle } from "../../fixtures/engine/cases.ts";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type SolveCommand = Extract<Parameters<EngineLink["request"]>[0], { type: "sketch.solve" }>;

interface Pending {
  command: SolveCommand;
  resolve: (r: Reply<"sketch.solve">) => void;
  reject: (e: Error) => void;
}

interface FakeOptions {
  /** Points that never move (fully determined). */
  pinned?: string[];
  /** Milliseconds a request reports for its regions. */
  profilesMs?: number;
}

/**
 * A link whose sketch.solve answers the test releases by hand. A drag request moves its points to their targets (and
 * nothing else); a request without drag echoes the sketch. Regions: one fake region when profiles are asked for.
 */
function fakeLink(options: FakeOptions = {}) {
  const pending: Pending[] = [];
  const requests: SolveCommand[] = [];
  const cancelled: number[] = [];
  const link: EngineLink = {
    isReady: () => true,
    onReady: () => () => undefined,
    request: ((command: SolveCommand) => {
      requests.push(command);
      const id = requests.length;
      const reply = new Promise<Reply<"sketch.solve">>((resolve, reject) => pending.push({ command, resolve, reject }));
      return { id, reply };
    }) as unknown as EngineLink["request"],
    cancel: (id) => cancelled.push(id),
  };

  const answerOf = (command: SolveCommand, id: number): Reply<"sketch.solve"> => {
    const pinned = new Set(options.pinned ?? []);
    const targets = new Map((command.drag?.points ?? []).map((p) => [p.id, p]));
    const points = command.sketch.points.map((p) => {
      const t = targets.get(p.id);
      return t && !pinned.has(p.id) ? { id: p.id, x: t.x, y: t.y } : { id: p.id, x: p.x, y: p.y };
    });
    const profiles: Region[] = [];
    if (command.profiles) {
      profiles.push({
        key: "l1,l2,l3,l4",
        outer: ["l1", "l2", "l3", "l4"],
        holes: [],
        area: 1,
        determined: true,
        fill: { positions: { offset: 0, byteLength: 0 }, indices: { offset: 0, byteLength: 0 }, triangleCount: 0 },
        loops: [{ offset: 0, byteLength: 0 }],
      });
    }
    const message: SketchSolveResult = {
      type: "sketchSolveResult",
      replyTo: id,
      status: "solved",
      dof: 4,
      points,
      circles: [],
      entities: Object.fromEntries(command.sketch.points.map((p) => [p.id, "under"] as const)),
      constraints: {},
      conflicting: [],
      redundant: [],
      partiallyRedundant: [],
      freedom: [],
      reference: {},
      profiles,
      frame: { origin: { x: 0, y: 0, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
      timeMs: 1,
      ...(command.profiles ? { profilesMs: options.profilesMs ?? 0.5 } : {}),
      ...(command.drag
        ? {
            drag: {
              points: command.drag.points.map((p) => {
                const at = points.find((q) => q.id === p.id)!;
                const before = command.sketch.points.find((q) => q.id === p.id)!;
                return { id: p.id, error: Math.hypot(at.x - p.x, at.y - p.y), moved: Math.hypot(at.x - before.x, at.y - before.y) > 1e-9 };
              }),
              steps: 1,
              complete: true,
            },
          }
        : {}),
    };
    return { message, payload: new ArrayBuffer(0) };
  };

  /** Answers the i-th request (0 based). */
  const answer = (i: number) => pending[i]!.resolve(answerOf(pending[i]!.command, i + 1));
  const crash = (i: number) => pending[i]!.reject(new EngineCrashedError({ kind: "exit", message: "The engine process ended with exit code 3." }));
  return { link, requests, pending, cancelled, answer, crash };
}

async function open(options: FakeOptions = {}, sketch: SketchData = rectangle(1)) {
  const f = fakeLink(options);
  const store = new DocumentStore(document(sketch));
  let released = false;
  // The editor opens with one solve; the test answers it at once.
  const opening = SketchEditorImpl.open({ link: f.link, store }, "f1", () => {
    released = true;
  });
  await flush();
  f.answer(0);
  const editor = await opening;
  return { ...f, store, editor, released: () => released };
}

const pointOf = (s: SketchData, id: string) => s.points.find((p) => p.id === id)!;
const committed = (store: DocumentStore) => sketchFeature(store.getSnapshot(), "f1")!.sketch;

describe("SketchEditor.beginDrag", () => {
  it("sends every step with the previous step's sketch and the pointer, shows only current answers, and still advances on stale ones", async () => {
    const t = await open();
    const drag = t.editor.beginDrag(["p3"]);
    drag.moveTo(10, 10); // request 1 goes out at once
    drag.moveTo(20, 20); // waits
    drag.moveTo(30, 30); // replaces the waiting one, which is never sent
    await flush();
    expect(t.requests).toHaveLength(2); // opening + the first step
    expect(t.requests[1]!.drag).toEqual({ points: [{ id: "p3", x: 10, y: 10 }] });
    expect(t.requests[1]!.profiles).toBe(true);
    expect(t.requests[1]!.diagnose).toBe(true);

    t.answer(1); // the first step answers; a newer pointer position waits, so this answer is not shown
    await flush();
    expect(t.editor.getView().drag).toBeUndefined();
    expect(t.requests).toHaveLength(3);
    // The next step starts from where the first one ended and aims at the newest pointer position.
    expect(pointOf(t.requests[2]!.sketch, "p3")).toMatchObject({ x: 10, y: 10 });
    expect(t.requests[2]!.drag).toEqual({ points: [{ id: "p3", x: 30, y: 30 }] });

    t.answer(2);
    await flush();
    const view = t.editor.getView();
    expect(view.preview).toBe(true);
    expect(view.points.find((p) => p.id === "p3")).toMatchObject({ x: 30, y: 30 });
    expect(view.drag).toMatchObject({ complete: true, profilesSkipped: false, points: [{ id: "p3", error: 0, moved: true }] });
    expect(view.profiles.map((p) => p.key)).toEqual(["l1,l2,l3,l4"]);
    // The document has not been touched.
    expect(t.store.changeCount).toBe(0);
    drag.cancel();
  });

  it("end() waits for the last step, solves the result once more and commits exactly one undo step", async () => {
    const t = await open();
    const before = committed(t.store);
    const drag = t.editor.beginDrag(["p3"]);
    drag.moveTo(40, 30);
    drag.moveTo(50, 35);
    const ended = drag.end();
    await flush();
    t.answer(1); // first step: overtaken by the second
    await flush();
    t.answer(2); // second step
    await flush();
    // Then the final solve: no drag, element states and regions.
    expect(t.requests).toHaveLength(4);
    expect(t.requests[3]!.drag).toBeUndefined();
    expect(t.requests[3]!.profiles).toBe(true);
    expect(t.requests[3]!.diagnose).toBe(true);
    expect(pointOf(t.requests[3]!.sketch, "p3")).toMatchObject({ x: 50, y: 35 });
    t.answer(3);
    expect(await ended).toEqual({ ok: true });
    expect(t.store.changeCount).toBe(1);
    expect(pointOf(committed(t.store), "p3")).toMatchObject({ x: 50, y: 35 });
    expect(t.editor.getView().preview).toBe(false);
    expect(t.editor.getView().drag).toBeUndefined();
    // One undo brings the sketch back; the editor shows it again.
    expect(t.store.undo()).toBe(true);
    expect(committed(t.store)).toEqual(before);
    expect(t.store.canUndo).toBe(false);
  });

  it("cancel() leaves the document and the committed view alone and ignores late answers", async () => {
    const t = await open();
    const view = t.editor.getView();
    const drag = t.editor.beginDrag(["p3"]);
    drag.moveTo(70, 70);
    await flush();
    drag.cancel();
    expect(t.editor.getView()).toBe(view);
    t.answer(1);
    await flush();
    expect(t.editor.getView()).toBe(view);
    expect(t.store.changeCount).toBe(0);
    // The drag is over: other edits work again, and a second end() says so.
    expect(await drag.end()).toMatchObject({ ok: false, reason: "invalid" });
    const next = t.editor.beginDrag(["p3"]);
    next.cancel();
  });

  it("a point that cannot move reports moved false with its distance, and end() commits nothing", async () => {
    const t = await open({ pinned: ["p3"] });
    const drag = t.editor.beginDrag(["p3"]);
    drag.moveTo(100, 100);
    await flush();
    t.answer(1);
    await flush();
    const report = t.editor.getView().drag!.points[0]!;
    expect(report.id).toBe("p3");
    expect(report.moved).toBe(false);
    expect(report.error).toBeGreaterThan(50);
    expect(t.editor.getView().drag!.complete).toBe(true);
    expect(await drag.end()).toEqual({ ok: true });
    expect(t.requests).toHaveLength(2); // no final solve
    expect(t.store.changeCount).toBe(0);
    expect(t.editor.getView().preview).toBe(false);
  });

  it("several points move as a group and keep their offsets from the first", async () => {
    const t = await open();
    const p3 = pointOf(committed(t.store), "p3");
    const p1 = pointOf(committed(t.store), "p1");
    const drag = t.editor.beginDrag(["p3", "p1"]);
    drag.moveTo(p3.x + 5, p3.y + 7);
    await flush();
    const sent = t.requests[1]!.drag!.points;
    expect(sent.map((p) => p.id)).toEqual(["p3", "p1"]);
    expect(sent[0]!.x).toBeCloseTo(p3.x + 5, 12);
    expect(sent[0]!.y).toBeCloseTo(p3.y + 7, 12);
    expect(sent[1]!.x).toBeCloseTo(p1.x + 5, 12);
    expect(sent[1]!.y).toBeCloseTo(p1.y + 7, 12);
    drag.cancel();
  });

  it("refuses other edits while a drag runs, and a change of the sketch in the document ends the drag", async () => {
    const t = await open();
    const drag = t.editor.beginDrag(["p3"]);
    expect(await t.editor.addCircle({ x: 5, y: 5 }, { value: 4, unit: "mm" })).toMatchObject({ ok: false, reason: "invalid" });
    expect(await t.editor.beginDrag(["p2"]).end()).toMatchObject({ ok: false, reason: "invalid", message: expect.stringContaining("Another drag") });
    drag.moveTo(10, 10);
    await flush();
    t.answer(1);
    await flush();
    expect(t.editor.getView().drag).toBeDefined();
    // Undo or redo of a sketch change under the drag voids it: the editor shows the document's sketch again.
    const changed = { ...committed(t.store), points: committed(t.store).points.map((p) => (p.id === "p4" ? { ...p, x: -9 } : p)) };
    t.store.commit((d) => ({ ...d, timeline: d.timeline.map((feature) => (feature.type === "sketch" ? { ...feature, sketch: changed } : feature)) }));
    await flush();
    t.answer(2); // the editor solves the sketch it now has
    await flush();
    expect(t.editor.getView().drag).toBeUndefined();
    expect(await drag.end()).toMatchObject({ ok: false, reason: "invalid" });
    // Edits are accepted again.
    const added = t.editor.addCircle({ x: 5, y: 5 }, { value: 4, unit: "mm" });
    await flush();
    t.answer(3);
    expect(await added).toEqual({ ok: true });
  });

  it("leaves the regions out for the rest of the drag when a step spent too long on them, and the final solve brings them back", async () => {
    const t = await open({ profilesMs: DRAG_PROFILES_BUDGET_MS + 3 });
    const drag = t.editor.beginDrag(["p3"]);
    drag.moveTo(10, 10);
    await flush();
    t.answer(1);
    await flush();
    expect(t.editor.getView().drag!.profilesSkipped).toBe(false); // the first step asked for them and showed them
    expect(t.editor.getView().profiles).toHaveLength(1);
    drag.moveTo(12, 12);
    await flush();
    expect(t.requests[2]!.profiles).toBe(false);
    t.answer(2);
    await flush();
    expect(t.editor.getView().drag!.profilesSkipped).toBe(true);
    expect(t.editor.getView().profiles).toEqual([]);
    const ended = drag.end();
    await flush();
    expect(t.requests[3]!.profiles).toBe(true);
    t.answer(3);
    await ended;
    expect(t.editor.getView().profiles).toHaveLength(1);
  });

  it("an engine failure during the drag is reported by end() and the committed sketch is shown again", async () => {
    const t = await open();
    const view = t.editor.getView();
    const drag = t.editor.beginDrag(["p3"]);
    drag.moveTo(10, 10);
    await flush();
    t.crash(1);
    await flush();
    const outcome = await drag.end();
    expect(outcome).toMatchObject({ ok: false, reason: "engine" });
    expect(t.editor.getView()).toBe(view);
    expect(t.store.changeCount).toBe(0);
  });

  it("refuses an unknown point, a repeated point and an empty list; the handle then only answers invalid", async () => {
    const t = await open();
    for (const ids of [["nope"], ["p1", "p1"], []]) {
      const drag = t.editor.beginDrag(ids);
      drag.moveTo(1, 1);
      expect(await drag.end()).toMatchObject({ ok: false, reason: "invalid" });
    }
    expect(t.requests).toHaveLength(1);
    await t.editor.finish();
    expect(t.released()).toBe(true);
    expect(await t.editor.beginDrag(["p1"]).end()).toMatchObject({ ok: false, reason: "invalid" });
  });
});
