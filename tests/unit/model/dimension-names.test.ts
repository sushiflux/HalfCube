// The automatic names of dimensions: d1, d2, d3 ... one counter for the whole document, stored with the dimension, never reused or
// renumbered (deleting, undo, redo, saving, reloading), reference dimensions included, old documents numbered in creation order.
import { describe, expect, it } from "vitest";
import { numberNamesInDocument } from "../../../app/src/document/migrate.ts";
import { dimensionName, highestParameterNumber, numberDimensions } from "../../../app/src/document/parameter-names.ts";
import { DocumentStore } from "../../../app/src/document/store.ts";
import type { Dimension, HalfCubeDocument, SketchFeature } from "../../../app/src/document/types.ts";
import { documentProblems, serializeDocument } from "../../../app/src/document/validate.ts";
import { sketchFeature } from "../../../app/src/model/doc-edit.ts";
import { SketchEditorImpl } from "../../../app/src/model/sketch-editor.ts";
import { loadSessionDocument, saveSessionDocument, sessionDocumentKey, type SessionStorageLike } from "../../../app/src/screens/main/autosave.ts";
import { document } from "../../fixtures/engine/cases.ts";
import { solveLink } from "./solve-link.ts";

const mm = (value: number) => ({ value, unit: "mm" as const });
const empty = { points: [], lines: [], circles: [], constraints: [] };

/** A document with two sketches, f1 and f9. */
function twoSketches(): HalfCubeDocument {
  const doc = document(empty);
  const first = doc.timeline[0] as SketchFeature;
  return { ...doc, timeline: [first, { ...first, id: "f9", name: "Skizze2" }] };
}
const open = (store: DocumentStore, id: string) => SketchEditorImpl.open({ link: solveLink(), store }, id, () => undefined);
const dims = (store: DocumentStore, id: string): Dimension[] => sketchFeature(store.getSnapshot(), id)!.sketch.constraints.filter((c): c is Dimension => "driving" in c);
const names = (store: DocumentStore, id: string) => dims(store, id).map(dimensionName);

describe("d names of dimensions", () => {
  it("count over the whole document, in creation order, across sketches; reference dimensions and the ones made with a shape count too", async () => {
    const store = new DocumentStore(twoSketches());
    const a = await open(store, "f1");
    await a.addCircle({ x: 0, y: 0 }, mm(4)); // d0: the diameter that comes with it
    await a.addLine({ x: 0, y: 20 }, { x: 10, y: 20 }, { length: mm(10) }); // d1
    expect(names(store, "f1")).toEqual(["d0", "d1"]);
    await a.finish();
    const b = await open(store, "f9");
    await b.addRectangle({ x: 0, y: 0 }, { x: 10, y: 10 });
    const l1 = sketchFeature(store.getSnapshot(), "f9")!.sketch.lines[0]!;
    expect(await b.addDimension("distance", [l1.id], mm(10), { x: 5, y: -3 })).toEqual({ ok: true }); // d2: the second sketch goes on counting
    expect(await b.addDimension("distance", [l1.id], null, { x: 5, y: -6 }, { driving: false })).toEqual({ ok: true }); // d3: a reference dimension
    expect(names(store, "f9")).toEqual(["d2", "d3"]);
    expect(store.getSnapshot().nextParameter).toBe(4);
    expect(documentProblems(store.getSnapshot())).toEqual([]);
  });

  it("are never reused or renumbered: a deleted dimension, an undone one and the one made next", async () => {
    const store = new DocumentStore(document(empty));
    const e = await open(store, "f1");
    await e.addCircle({ x: 0, y: 0 }, mm(4));
    await e.addCircle({ x: 20, y: 0 }, mm(4));
    await e.addCircle({ x: 40, y: 0 }, mm(4));
    expect(names(store, "f1")).toEqual(["d0", "d1", "d2"]);
    await e.remove([dims(store, "f1")[0]!.id]);
    expect(names(store, "f1")).toEqual(["d1", "d2"]);
    await e.addCircle({ x: 60, y: 0 }, mm(4));
    expect(names(store, "f1")).toEqual(["d1", "d2", "d3"]);
    // Undo takes d4 away; the next dimension is d5, redo cannot bring d4 back after a new commit, and nothing already there changes.
    store.undo();
    expect(names(store, "f1")).toEqual(["d1", "d2"]);
    store.redo();
    expect(names(store, "f1")).toEqual(["d1", "d2", "d3"]);
    store.undo();
    await e.addCircle({ x: 80, y: 0 }, mm(4));
    expect(names(store, "f1")).toEqual(["d1", "d2", "d4"]);
    expect(store.nextParameterValue).toBe(5);
    // A changed value and a moved label keep the name.
    const id = dims(store, "f1")[0]!.id;
    await e.setDimension(id, mm(9));
    await e.moveLabel(id, { x: 1, y: 1 });
    expect(names(store, "f1")).toEqual(["d1", "d2", "d4"]);
  });

  it("the counter is exposed by the store: a later step (the distance of an extrusion) takes the next number of the same counter", async () => {
    const store = new DocumentStore(document(empty));
    const e = await open(store, "f1");
    await e.addCircle({ x: 0, y: 0 }, mm(4));
    expect(store.newParameterNumber()).toBe(1);
    expect(store.newParameterNumber()).toBe(2);
    await e.addCircle({ x: 20, y: 0 }, mm(4));
    expect(names(store, "f1")).toEqual(["d0", "d3"]);
    expect(store.getSnapshot().nextParameter).toBe(4);
  });

  it("survive saving and reloading: the stored numbers and the counter come back, and a new dimension continues", async () => {
    const data = new Map<string, string>();
    const storage: SessionStorageLike = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
    const store = new DocumentStore(document(empty));
    const e = await open(store, "f1");
    await e.addCircle({ x: 0, y: 0 }, mm(4));
    await e.addCircle({ x: 20, y: 0 }, mm(4));
    saveSessionDocument(store.getSnapshot(), storage);
    const reloaded = new DocumentStore(loadSessionDocument(storage)!);
    expect(names(reloaded, "f1")).toEqual(["d0", "d1"]);
    const again = await open(reloaded, "f1");
    await again.addCircle({ x: 40, y: 0 }, mm(4));
    expect(names(reloaded, "f1")).toEqual(["d0", "d1", "d2"]);
  });
});

describe("documents from before the d names", () => {
  const legacy = (): HalfCubeDocument => {
    const doc = twoSketches();
    const dim = (id: string, number?: number): Dimension => ({ id, kind: "radius", refs: ["c1"], value: mm(5), driving: true, label: { x: 0, y: 0 }, ...(number !== undefined ? { number } : {}) });
    const [one, two] = doc.timeline as SketchFeature[];
    return {
      ...doc,
      timeline: [
        { ...one!, sketch: { ...one!.sketch, constraints: [dim("d0"), dim("d1")] } },
        { ...two!, sketch: { ...two!.sketch, constraints: [dim("d2"), { ...dim("d3"), driving: false }] } },
      ],
    };
  };
  const numbers = (doc: HalfCubeDocument) => (doc.timeline as SketchFeature[]).flatMap((f) => f.sketch.constraints.filter((c): c is Dimension => "driving" in c).map(dimensionName));

  it("are numbered in creation order (timeline, then the sketch's list) and the counter is set", () => {
    const migrated = numberDimensions(legacy());
    expect(numbers(migrated)).toEqual(["d0", "d1", "d2", "d3"]);
    expect(migrated.nextParameter).toBe(4);
    expect(documentProblems(migrated)).toEqual([]);
    expect(numberDimensions(migrated)).toBe(migrated);
  });

  it("numbers already in the document are kept, the rest continue after the highest one", () => {
    const doc = legacy();
    const f = doc.timeline[0] as SketchFeature;
    const partly: HalfCubeDocument = { ...doc, timeline: [{ ...f, sketch: { ...f.sketch, constraints: [{ ...(f.sketch.constraints[0] as Dimension), number: 7 }, f.sketch.constraints[1]!] } }, doc.timeline[1]!] };
    expect(highestParameterNumber(partly)).toBe(7);
    expect(numbers(numberDimensions(partly))).toEqual(["d7", "d8", "d9", "d10"]);
  });

  it("the session loader and the shape migration give a stored document its names once", () => {
    const data = new Map<string, string>();
    const storage: SessionStorageLike = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
    data.set(sessionDocumentKey, serializeDocument(legacy()));
    const loaded = loadSessionDocument(storage)!;
    expect(numbers(loaded)).toEqual(["d0", "d1", "d2", "d3"]);
    expect(numberNamesInDocument(loaded)).toBe(loaded);
  });

  it("a dimension that has no number shows its id", () => {
    expect(dimensionName({ id: "d6" })).toBe("d6");
    expect(dimensionName({ id: "d6", number: 3 })).toBe("d3");
  });
});
