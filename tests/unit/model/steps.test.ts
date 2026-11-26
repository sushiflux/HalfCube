// Sketch steps: every SketchEditor operation records exactly one step with the ids it created; remove() shortens the
// members; undo and redo bring the steps back with the sketch; the open editor follows undo and redo.
import { describe, expect, it } from "vitest";
import type { Reply } from "../../../app/src/engine/client.ts";
import type { SketchSolveResult } from "../../../app/src/engine/generated/protocol.ts";
import { DocumentStore } from "../../../app/src/document/store.ts";
import { documentProblems } from "../../../app/src/document/validate.ts";
import type { SketchData } from "../../../app/src/document/types.ts";
import type { EngineLink } from "../../../app/src/model/engine-link.ts";
import { sketchFeature } from "../../../app/src/model/doc-edit.ts";
import { SketchEditorImpl } from "../../../app/src/model/sketch-editor.ts";
import { document } from "../../fixtures/engine/cases.ts";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
type SolveCommand = Extract<Parameters<EngineLink["request"]>[0], { type: "sketch.solve" }>;

/** A link that answers every sketch.solve at once: solved, nothing moves. */
function echoLink(): EngineLink {
  let n = 0;
  return {
    isReady: () => true,
    onReady: () => () => undefined,
    request: ((command: SolveCommand) => {
      const id = ++n;
      const message: SketchSolveResult = {
        type: "sketchSolveResult",
        replyTo: id,
        status: "solved",
        dof: 0,
        points: command.sketch.points.map((p) => ({ id: p.id, x: p.x, y: p.y })),
        circles: [],
        entities: {},
        constraints: {},
        conflicting: [],
        redundant: [],
        partiallyRedundant: [],
        freedom: [],
        reference: {},
        profiles: [],
        frame: { origin: { x: 0, y: 0, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
        timeMs: 1,
      };
      const reply: Promise<Reply<"sketch.solve">> = Promise.resolve({ message, payload: new ArrayBuffer(0) });
      return { id, reply };
    }) as unknown as EngineLink["request"],
    cancel: () => undefined,
  };
}

async function open() {
  const store = new DocumentStore(document({ points: [], lines: [], circles: [], constraints: [] }));
  const editor = await SketchEditorImpl.open({ link: echoLink(), store }, "f1", () => undefined);
  return { store, editor };
}

const sketchOf = (store: DocumentStore): SketchData => sketchFeature(store.getSnapshot(), "f1")!.sketch;
const allIds = (s: SketchData) => [...s.points, ...s.lines, ...s.circles, ...s.constraints].map((e) => e.id);

describe("sketch steps", () => {
  it("records one step per operation with every id it created, in creation order", async () => {
    const { store, editor } = await open();
    expect(await editor.addLine({ x: 0, y: 0 }, { x: 10, y: 0 }, { length: { value: 10, unit: "mm" } })).toEqual({ ok: true });
    let s = sketchOf(store);
    expect(s.steps).toHaveLength(1);
    expect(s.steps![0]).toMatchObject({ kind: "line" });
    // 2 points, the line, and the length dimension the editor added for this operation.
    expect(s.steps![0]!.members).toHaveLength(4);
    expect(new Set(s.steps![0]!.members)).toEqual(new Set(allIds(s)));

    await editor.addRectangle({ x: 20, y: 0 }, { x: 40, y: 10 });
    s = sketchOf(store);
    expect(s.steps).toHaveLength(2);
    expect(s.steps![1]).toMatchObject({ kind: "rectangle" });
    expect(s.steps![1]!.members).toHaveLength(12); // 4 points, 4 lines, 4 constraints

    await editor.addCircle({ x: 0, y: 20 }, { value: 8, unit: "mm" });
    s = sketchOf(store);
    expect(s.steps![2]).toMatchObject({ kind: "circle" });
    expect(s.steps![2]!.members).toHaveLength(3); // centre point, circle, diameter

    const line = s.lines[0]!.id;
    await editor.addConstraint("horizontal", [line]);
    s = sketchOf(store);
    expect(s.steps![3]).toMatchObject({ kind: "constraint" });
    expect(s.steps![3]!.members).toEqual([s.constraints.at(-1)!.id]);

    await editor.addDimension("distance", [line], { value: 12, unit: "mm" }, { x: 1, y: 1 });
    s = sketchOf(store);
    expect(s.steps).toHaveLength(5);
    expect(s.steps![4]).toMatchObject({ kind: "dimension", members: [s.constraints.at(-1)!.id] });

    // Step ids are unique and every element belongs to exactly one step.
    expect(new Set(s.steps!.map((x) => x.id)).size).toBe(5);
    expect(s.steps!.flatMap((x) => x.members).sort()).toEqual(allIds(s).sort());
    expect(documentProblems(store.getSnapshot())).toEqual([]);
  });

  it("a snapped point is not a member of the step that only uses it", async () => {
    const { store, editor } = await open();
    await editor.addLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    const s0 = sketchOf(store);
    await editor.addLine({ snap: s0.points[1]!.id }, { x: 10, y: 10 });
    const s = sketchOf(store);
    expect(s.steps![1]!.members).toHaveLength(2); // the new point and the new line
    expect(s.steps![1]!.members).not.toContain(s0.points[1]!.id);
  });

  it("a changed dimension value, a moved label and a rejected edit add no step", async () => {
    const { store, editor } = await open();
    await editor.addCircle({ x: 0, y: 0 }, { value: 8, unit: "mm" });
    const dim = sketchOf(store).constraints[0]!.id;
    await editor.setDimension(dim, { value: 9, unit: "mm" });
    await editor.moveLabel(dim, { x: 3, y: 3 });
    expect(await editor.addConstraint("horizontal", ["l999"])).toMatchObject({ ok: false, reason: "invalid" });
    expect(sketchOf(store).steps).toHaveLength(1);
  });

  it("remove() takes ids out of the members and drops steps that become empty", async () => {
    const { store, editor } = await open();
    await editor.addRectangle({ x: 0, y: 0 }, { x: 10, y: 5 });
    await editor.addCircle({ x: 30, y: 0 }, { value: 4, unit: "mm" });
    let s = sketchOf(store);
    const [rect, circ] = s.steps!;
    const firstLine = s.lines[0]!.id;
    await editor.remove([firstLine]);
    s = sketchOf(store);
    expect(s.steps![0]!.id).toBe(rect!.id);
    expect(s.steps![0]!.members).not.toContain(firstLine);
    expect(s.steps![0]!.members.length).toBeLessThan(rect!.members.length);
    expect(s.steps!.flatMap((x) => x.members).sort()).toEqual(allIds(s).sort());
    // Removing the circle's centre point removes the whole circle step.
    await editor.remove([circ!.members[0]!]);
    s = sketchOf(store);
    expect(s.steps!.map((x) => x.id)).not.toContain(circ!.id);
    expect(s.steps!.flatMap((x) => x.members).sort()).toEqual(allIds(s).sort());
    expect(documentProblems(store.getSnapshot())).toEqual([]);
  });

  it("removing every member of the last step leaves no empty step", async () => {
    const { store, editor } = await open();
    await editor.addLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    const s = sketchOf(store);
    await editor.remove(s.points.map((p) => p.id));
    expect(sketchOf(store).steps).toEqual([]);
  });

  it("undo and redo restore the steps with the sketch, and the open editor follows", async () => {
    const { store, editor } = await open();
    await editor.addRectangle({ x: 0, y: 0 }, { x: 10, y: 5 });
    await editor.addCircle({ x: 30, y: 0 }, { value: 4, unit: "mm" });
    expect(sketchOf(store).steps).toHaveLength(2);
    expect(store.undo()).toBe(true);
    await flush();
    expect(sketchOf(store).steps).toHaveLength(1);
    expect(editor.getView().points).toHaveLength(4);
    expect(store.redo()).toBe(true);
    await flush();
    expect(sketchOf(store).steps).toHaveLength(2);
    expect(editor.getView().points).toHaveLength(5);
    // Ids are never reused after undo, step ids included.
    const before = sketchOf(store).steps!.map((x) => x.id);
    store.undo();
    await flush();
    await editor.addCircle({ x: 50, y: 0 }, { value: 4, unit: "mm" });
    const ids = sketchOf(store).steps!.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(before[1]);
  });

  it("a document without steps stays valid and gets the first step on the next edit", async () => {
    const { store, editor } = await open();
    expect(sketchOf(store).steps).toBeUndefined();
    expect(documentProblems(store.getSnapshot())).toEqual([]);
    await editor.addCircle({ x: 0, y: 0 }, { value: 4, unit: "mm" });
    expect(sketchOf(store).steps).toHaveLength(1);
  });
});

describe("document schema for steps", () => {
  it("rejects an unknown step kind, a missing member list and an unknown field", () => {
    const base = document({ points: [], lines: [], circles: [], constraints: [], steps: [] });
    const withSteps = (steps: unknown) => ({
      ...base,
      timeline: base.timeline.map((f) => (f.type === "sketch" ? { ...f, sketch: { ...f.sketch, steps } } : f)),
    });
    expect(documentProblems(withSteps([{ id: "s1", kind: "line", members: [] }]))).toEqual([]);
    expect(documentProblems(withSteps([{ id: "s1", kind: "polygon", members: [] }]))).not.toEqual([]);
    expect(documentProblems(withSteps([{ id: "s1", kind: "line" }]))).not.toEqual([]);
    expect(documentProblems(withSteps([{ id: "s1", kind: "line", members: [], extra: 1 }]))).not.toEqual([]);
  });
});
