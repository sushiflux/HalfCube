// The names of sketch shapes: a running number per kind in the sketch, stored in the document, so Rectangle 1 stays Rectangle 1 when
// another shape is deleted, is never given to a second shape, and survives undo, redo, saving and reloading.
import { describe, expect, it } from "vitest";
import { numberNamesInDocument } from "../../../app/src/document/migrate.ts";
import { numberShapes, shapesOf } from "../../../app/src/document/shape-names.ts";
import { DocumentStore } from "../../../app/src/document/store.ts";
import type { SketchData } from "../../../app/src/document/types.ts";
import { documentProblems, serializeDocument } from "../../../app/src/document/validate.ts";
import { sketchFeature } from "../../../app/src/model/doc-edit.ts";
import { SketchEditorImpl } from "../../../app/src/model/sketch-editor.ts";
import { loadSessionDocument, saveSessionDocument, sessionDocumentKey, type SessionStorageLike } from "../../../app/src/screens/main/autosave.ts";
import { document } from "../../fixtures/engine/cases.ts";
import { solveLink } from "./solve-link.ts";

const mm = (value: number) => ({ value, unit: "mm" as const });

async function open() {
  const store = new DocumentStore(document({ points: [], lines: [], circles: [], constraints: [] }));
  const editor = await SketchEditorImpl.open({ link: solveLink(), store }, "f1", () => undefined);
  return { store, editor };
}
const sketchOf = (store: DocumentStore): SketchData => sketchFeature(store.getSnapshot(), "f1")!.sketch;
const names = (s: SketchData) => shapesOf(s).map((x) => `${x.kind}${x.number}`);

describe("numbering of shapes", () => {
  it("counts per kind in creation order: Rectangle 1, Circle 1, Rectangle 2, Line 1, Circle 2", async () => {
    const { store, editor } = await open();
    await editor.addRectangle({ x: 0, y: 0 }, { x: 10, y: 10 });
    await editor.addCircle({ x: 30, y: 0 }, mm(4));
    await editor.addRectangle({ x: 50, y: 0 }, { x: 60, y: 10 });
    await editor.addLine({ x: 0, y: 40 }, { x: 10, y: 40 });
    await editor.addCircle({ x: 30, y: 30 }, mm(4));
    const s = sketchOf(store);
    expect(names(s)).toEqual(["rectangle1", "circle1", "rectangle2", "line1", "circle2"]);
    expect(s.shapeCounts).toEqual({ rectangle: 2, circle: 2, line: 1 });
    expect(documentProblems(store.getSnapshot())).toEqual([]);
  });

  it("a number is never renumbered or reused when a shape is deleted - not even the last one", async () => {
    const { store, editor } = await open();
    await editor.addCircle({ x: 0, y: 0 }, mm(4));
    await editor.addCircle({ x: 20, y: 0 }, mm(4));
    await editor.addCircle({ x: 40, y: 0 }, mm(4));
    const [c1, , c3] = sketchOf(store).circles;
    await editor.remove([c1!.id]);
    expect(names(sketchOf(store))).toEqual(["circle2", "circle3"]);
    await editor.remove([c3!.id]);
    expect(names(sketchOf(store))).toEqual(["circle2"]);
    await editor.addCircle({ x: 60, y: 0 }, mm(4));
    expect(names(sketchOf(store))).toEqual(["circle2", "circle4"]); // not circle3: it was deleted, its number stays gone
    expect(sketchOf(store).shapeCounts!.circle).toBe(4);
  });

  it("undo and redo keep the numbers: the same shape comes back under the same number", async () => {
    const { store, editor } = await open();
    await editor.addRectangle({ x: 0, y: 0 }, { x: 10, y: 10 });
    await editor.addRectangle({ x: 30, y: 0 }, { x: 40, y: 10 });
    expect(names(sketchOf(store))).toEqual(["rectangle1", "rectangle2"]);
    expect(store.undo()).toBe(true);
    expect(names(sketchOf(store))).toEqual(["rectangle1"]);
    expect(sketchOf(store).shapeCounts).toEqual({ rectangle: 1 });
    expect(store.redo()).toBe(true);
    expect(names(sketchOf(store))).toEqual(["rectangle1", "rectangle2"]);
    store.undo();
    store.undo();
    store.redo();
    expect(names(sketchOf(store))).toEqual(["rectangle1"]);
  });

  it("a changed value and a moved label add no shape and change no number", async () => {
    const { store, editor } = await open();
    await editor.addCircle({ x: 0, y: 0 }, mm(4));
    const before = names(sketchOf(store));
    const dim = sketchOf(store).constraints[0]!.id;
    await editor.setDimension(dim, mm(6));
    await editor.moveLabel(dim, { x: 3, y: 3 });
    expect(names(sketchOf(store))).toEqual(before);
    expect(sketchOf(store).shapeCounts).toEqual({ circle: 1 });
  });
});

describe("documents from before the names", () => {
  const legacy = (): SketchData => ({
    points: [],
    lines: [],
    circles: [],
    constraints: [],
    steps: [
      { id: "s1", kind: "rectangle", members: ["l1"] },
      { id: "s2", kind: "dimension", members: ["d1"] },
      { id: "s3", kind: "circle", members: ["c1"] },
      { id: "s4", kind: "rectangle", members: ["l5"] },
      { id: "s5", kind: "line", members: ["l9"] },
    ],
  });

  it("are numbered in creation order, per kind, and the counts are set", () => {
    const s = numberShapes(legacy());
    expect(names(s)).toEqual(["rectangle1", "circle1", "rectangle2", "line1"]);
    expect(s.shapeCounts).toEqual({ rectangle: 2, circle: 1, line: 1 });
  });

  it("a sketch that is numbered already is returned as it is; new steps continue the count", () => {
    const once = numberShapes(legacy());
    expect(numberShapes(once)).toBe(once);
    const more: SketchData = { ...once, steps: [...once.steps!, { id: "s6", kind: "circle", members: ["c2"] }] };
    expect(names(numberShapes(more)).at(-1)).toBe("circle2");
  });

  it("the document is migrated sketch by sketch and still passes the document check", () => {
    const migrated = numberNamesInDocument(document(legacy()));
    const f = migrated.timeline[0]!;
    expect(f.type === "sketch" && names(f.sketch)).toEqual(["rectangle1", "circle1", "rectangle2", "line1"]);
    expect(documentProblems(migrated)).toEqual([]);
    expect(numberNamesInDocument(migrated)).toBe(migrated);
  });

  it("the session loader numbers a stored document without numbers, and a reload keeps the numbers", () => {
    const data = new Map<string, string>();
    const store: SessionStorageLike = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
    data.set(sessionDocumentKey, serializeDocument(document(legacy())));
    const loaded = loadSessionDocument(store)!;
    const feature = loaded.timeline[0]!;
    expect(feature.type === "sketch" && names(feature.sketch)).toEqual(["rectangle1", "circle1", "rectangle2", "line1"]);
    saveSessionDocument(loaded, store);
    expect(loadSessionDocument(store)).toEqual(loaded);
  });
});
