// Undo groups(one user action is one undo step) at the level of the sketch editor: the edits of one action stay
// separate commits with their own sketch steps, but one undo takes all of them and one redo brings them back.
import { describe, expect, it } from "vitest";
import { DocumentStore } from "../../../app/src/document/store.ts";
import type { SketchData } from "../../../app/src/document/types.ts";
import { documentProblems } from "../../../app/src/document/validate.ts";
import { sketchFeature } from "../../../app/src/model/doc-edit.ts";
import { SketchEditorImpl } from "../../../app/src/model/sketch-editor.ts";
import { document } from "../../fixtures/engine/cases.ts";
import { solveLink, type SolveLinkOptions } from "./solve-link.ts";

const mm = (value: number) => ({ value, unit: "mm" as const });
const label = { x: 0, y: 0 };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function open(options: SolveLinkOptions = {}) {
  const store = new DocumentStore(document({ points: [], lines: [], circles: [], constraints: [] }));
  const editor = await SketchEditorImpl.open({ link: solveLink(options), store }, "f1", () => undefined);
  return { store, editor };
}
const sketchOf = (store: DocumentStore): SketchData => sketchFeature(store.getSnapshot(), "f1")!.sketch;
const dimensionsOf = (s: SketchData) => s.constraints.filter((c) => "driving" in c);

/** Undo steps in the store, counted by undoing until nothing is left (and redoing back). */
function undoDepth(store: DocumentStore): number {
  let n = 0;
  while (store.undo()) n += 1;
  for (let i = 0; i < n; i++) store.redo();
  return n;
}

/** The rectangle tool's action: the rectangle, then a dimension on each of its first two edges. */
async function rectangleWithSizes(editor: SketchEditorImpl, store: DocumentStore) {
  await editor.addRectangle({ x: 0, y: 0 }, { x: 60, y: 40 });
  const [l1, l2] = sketchOf(store).lines;
  const a = await editor.addDimension("distance", [l1!.id], mm(60), label);
  const b = await editor.addDimension("distance", [l2!.id], mm(40), label);
  return [a, b] as const;
}

const refuse999 = (s: SketchData) => (s.constraints.some((c) => "driving" in c && c.driving && c.value.value === 999) ? ("conflicting" as const) : null);

describe("undo groups in the sketch editor", () => {
  it("without a group a rectangle with two dimensions is three undo steps", async () => {
    const { store, editor } = await open();
    await rectangleWithSizes(editor, store);
    expect(undoDepth(store)).toBe(3);
  });

  it("a group makes the rectangle and its two dimensions ONE undo step; one redo brings all back", async () => {
    const { store, editor } = await open();
    const outcomes = await editor.group(() => rectangleWithSizes(editor, store));
    expect(outcomes).toEqual([{ ok: true }, { ok: true }]);
    expect(undoDepth(store)).toBe(1);
    // The sketch steps stay: a rectangle step and one step per dimension.
    const before = sketchOf(store);
    expect(before.steps!.map((s) => s.kind)).toEqual(["rectangle", "dimension", "dimension"]);
    expect(dimensionsOf(before)).toHaveLength(2);

    expect(store.undo()).toBe(true);
    expect(sketchOf(store).lines).toHaveLength(0);
    expect(sketchOf(store).constraints).toHaveLength(0);
    expect(store.canUndo).toBe(false);
    expect(store.redo()).toBe(true);
    expect(sketchOf(store)).toEqual(before);
    expect(documentProblems(store.getSnapshot())).toEqual([]);
    // After the group the next edit is a step of its own again.
    await editor.addCircle({ x: 90, y: 0 }, mm(8));
    expect(undoDepth(store)).toBe(2);
  });

  it("the open editor follows an undo of a whole group", async () => {
    const { store, editor } = await open();
    await editor.group(() => rectangleWithSizes(editor, store));
    expect(editor.getView().lines).toHaveLength(4);
    store.undo();
    await flush();
    expect(editor.getView().lines).toHaveLength(0);
    expect(editor.getView().dimensions).toHaveLength(0);
  });

  it("a refused edit inside a group is not committed; what went through stays in the one step", async () => {
    const { store, editor } = await open({ refuse: refuse999 });
    const [a, b] = await editor.group(async () => {
      await editor.addRectangle({ x: 0, y: 0 }, { x: 60, y: 40 });
      const [l1, l2] = sketchOf(store).lines;
      return [await editor.addDimension("distance", [l1!.id], mm(60), label), await editor.addDimension("distance", [l2!.id], mm(999), label)] as const;
    });
    expect(a).toEqual({ ok: true });
    expect(b).toMatchObject({ ok: false, reason: "rejected" });
    const s = sketchOf(store);
    expect(dimensionsOf(s)).toHaveLength(1);
    expect(s.steps!.map((x) => x.kind)).toEqual(["rectangle", "dimension"]);
    expect(undoDepth(store)).toBe(1);
  });

  it("a group in which nothing is committed leaves no undo step", async () => {
    const { store, editor } = await open({ refuse: () => "conflicting" });
    const outcome = await editor.group(() => editor.addRectangle({ x: 0, y: 0 }, { x: 60, y: 40 }));
    expect(outcome).toMatchObject({ ok: false, reason: "rejected" });
    expect(store.canUndo).toBe(false);
    expect(sketchOf(store).lines).toHaveLength(0);
    expect(store.grouping).toBe(false);
  });

  it("a thrown error ends the group; the commits made so far stay as one step", async () => {
    const { store, editor } = await open();
    await expect(
      editor.group(async () => {
        await editor.addCircle({ x: 0, y: 0 }, mm(8));
        await editor.addCircle({ x: 30, y: 0 }, mm(8));
        throw new Error("the action failed");
      }),
    ).rejects.toThrow("the action failed");
    expect(store.grouping).toBe(false);
    expect(undoDepth(store)).toBe(1);
  });

  it("groups do not nest: a second one is a clear error, and a new one works after the first ended", async () => {
    const { store, editor } = await open();
    const first = editor.beginGroup();
    expect(() => editor.beginGroup()).toThrow(/already open; groups cannot be nested/);
    await expect(editor.group(() => Promise.resolve(1))).rejects.toThrow(/cannot be nested/);
    expect(first.open).toBe(true); // the failed attempts did not end the group that was open
    first.close();
    first.close(); // closing again is harmless
    expect(first.open).toBe(false);
    await expect(editor.group(() => Promise.resolve(1))).resolves.toBe(1);
    expect(store.grouping).toBe(false);
  });

  it("a dimension placed with its measured value and then given the typed value is one step (the dimension tool)", async () => {
    const { store, editor } = await open();
    await editor.addLine({ x: 0, y: 0 }, { x: 40, y: 0 });
    const line = sketchOf(store).lines[0]!.id;
    const depth = undoDepth(store);

    const group = editor.beginGroup();
    expect(await editor.addDimension("distance", [line], null, label)).toEqual({ ok: true }); // the measured value
    const id = sketchOf(store).constraints.at(-1)!.id;
    expect(await editor.setDimension(id, mm(55))).toEqual({ ok: true }); // Enter with a typed value
    group.close();

    expect(undoDepth(store)).toBe(depth + 1);
    expect(sketchOf(store).steps!.map((s) => s.kind)).toEqual(["line", "dimension"]);
    store.undo();
    expect(sketchOf(store).constraints).toHaveLength(0);
    expect(sketchOf(store).lines).toHaveLength(1);
  });

  it("a refused typed value keeps the placed dimension; the reference dimension that follows joins the same step", async () => {
    const { store, editor } = await open({ refuse: refuse999 });
    await editor.addLine({ x: 0, y: 0 }, { x: 40, y: 0 });
    const line = sketchOf(store).lines[0]!.id;
    const depth = undoDepth(store);

    const group = editor.beginGroup();
    await editor.addDimension("distance", [line], null, label);
    const id = sketchOf(store).constraints.at(-1)!.id;
    expect(await editor.setDimension(id, mm(999))).toMatchObject({ ok: false, reason: "rejected" });
    expect(await editor.setDriving(id, false)).toEqual({ ok: true }); // "Als Referenzmaß anlegen"
    group.close();

    expect(undoDepth(store)).toBe(depth + 1);
    expect(sketchOf(store).constraints.at(-1)).toMatchObject({ driving: false });
  });

  it("finish() closes an open group; undo ends it too", async () => {
    const { store, editor } = await open();
    editor.beginGroup();
    expect(store.grouping).toBe(true);
    await editor.finish();
    expect(store.grouping).toBe(false);

    const second = await open();
    second.editor.beginGroup();
    await second.editor.addCircle({ x: 0, y: 0 }, mm(8));
    second.store.undo();
    expect(second.store.grouping).toBe(false);
  });

  it("a finished editor refuses a new group with a clear message", async () => {
    const { editor } = await open();
    await editor.finish();
    expect(() => editor.beginGroup()).toThrow(/finished/);
    await expect(editor.group(() => Promise.resolve(1))).rejects.toThrow(/finished/);
  });
});
