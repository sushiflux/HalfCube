// Groups of connected shapes are "Form N": a single shape keeps its kind's name, a group made by more than one tool is Form 1, Form 2.
// The numbers are stable: when groups merge the lowest stays and the others are retired, when a group splits the part with the most
// elements keeps it and the other gets a new number, a group that shrinks to one shape shows its kind's name again, retired numbers
// never come back, and undo, redo, saving and reloading keep them.
import { describe, expect, it } from "vitest";
import { reconcileForms, formsOf } from "../../../app/src/document/shape-names.ts";
import { DocumentStore } from "../../../app/src/document/store.ts";
import type { SketchData } from "../../../app/src/document/types.ts";
import { sketchFeature } from "../../../app/src/model/doc-edit.ts";
import { SketchEditorImpl } from "../../../app/src/model/sketch-editor.ts";
import { catalogues, formatMessage, lookup } from "../../../app/src/i18n/core.ts";
import type { MessageKey } from "../../../app/src/i18n/types.ts";
import { loadSessionDocument, saveSessionDocument, type SessionStorageLike } from "../../../app/src/screens/main/autosave.ts";
import { nameOfElements } from "../../../app/src/screens/sketch/shape-name.ts";
import { document } from "../../fixtures/engine/cases.ts";
import { solveLink } from "./solve-link.ts";

const mm = (value: number) => ({ value, unit: "mm" as const });
const t = (language: "de" | "en") => (key: MessageKey, params?: Record<string, string | number>) => formatMessage(lookup(catalogues[language], key), params);

async function open() {
  const store = new DocumentStore(document({ points: [], lines: [], circles: [], constraints: [] }));
  const editor = await SketchEditorImpl.open({ link: solveLink(), store }, "f1", () => undefined);
  return { store, editor };
}
const sketchOf = (store: DocumentStore): SketchData => sketchFeature(store.getSnapshot(), "f1")!.sketch;
const forms = (store: DocumentStore) => (sketchOf(store).forms ?? []).map((f) => `Form ${f.number}: ${f.shapes.length} shapes`);
/** The step id of the n-th shape of a kind. */
const stepOf = (store: DocumentStore, kind: string, number: number) => sketchOf(store).steps!.find((s) => s.kind === kind && s.number === number)!.id;
/** What a fact about the whole shape (all its curves) is called. */
const nameOf = (editor: SketchEditorImpl, ids: string[], language: "de" | "en" = "de") => nameOfElements(t(language), editor.getView(), ids, "?");

describe("Form numbers", () => {
  it("a single shape keeps its kind's name; connected shapes of different tools are Form 1 (Shape 1)", async () => {
    const { store, editor } = await open();
    await editor.addRectangle({ x: 0, y: 0 }, { x: 10, y: 10 });
    await editor.addCircle({ x: 30, y: 0 }, mm(4));
    expect(forms(store)).toEqual([]);
    const rect = sketchOf(store).lines.map((l) => l.id);
    const circle = [sketchOf(store).circles[0]!.id];
    expect(nameOf(editor, rect)).toBe("Rechteck 1");
    expect(nameOf(editor, circle, "en")).toBe("Circle 1");
    // The circle's centre tied to a corner of the rectangle: one group.
    await editor.addConstraint("coincident", [sketchOf(store).circles[0]!.center, sketchOf(store).lines[0]!.p1]);
    expect(forms(store)).toEqual(["Form 1: 2 shapes"]);
    expect(nameOf(editor, [...rect, ...circle])).toBe("Form 1");
    expect(nameOf(editor, [...rect, ...circle], "en")).toBe("Shape 1");
    // A fact about one shape of the group still names that shape.
    expect(nameOf(editor, circle)).toBe("Kreis 1");
    expect(nameOf(editor, rect)).toBe("Rechteck 1");
  });

  it("a group grows by another shape and keeps its number; a reference dimension connects nothing", async () => {
    const { store, editor } = await open();
    await editor.addRectangle({ x: 0, y: 0 }, { x: 10, y: 10 });
    await editor.addCircle({ x: 30, y: 0 }, mm(4));
    await editor.addLine({ x: 0, y: 40 }, { x: 10, y: 40 });
    const s = sketchOf(store);
    await editor.addConstraint("coincident", [s.circles[0]!.center, s.lines[0]!.p1]);
    expect(forms(store)).toEqual(["Form 1: 2 shapes"]);
    // A reference dimension between the line and the rectangle only measures.
    expect(await editor.addDimension("distance", [s.points.at(-2)!.id, s.lines[0]!.p2], null, { x: 5, y: 20 }, { driving: false })).toEqual({ ok: true });
    expect(forms(store)).toEqual(["Form 1: 2 shapes"]);
    // A driving one ties the line to the group.
    await editor.addConstraint("coincident", [s.points.at(-2)!.id, s.lines[0]!.p2]);
    expect(forms(store)).toEqual(["Form 1: 3 shapes"]);
  });

  it("merge: the lowest number stays, the other is retired for good and not handed out again", async () => {
    const { store, editor } = await open();
    await editor.addRectangle({ x: 0, y: 0 }, { x: 10, y: 10 });
    await editor.addCircle({ x: 30, y: 0 }, mm(4)); // Form 1 with the rectangle
    await editor.addLine({ x: 0, y: 40 }, { x: 10, y: 40 });
    await editor.addLine({ x: 20, y: 40 }, { x: 30, y: 40 }); // Form 2 with the first line
    let s = sketchOf(store);
    await editor.addConstraint("coincident", [s.circles[0]!.center, s.lines[0]!.p1]);
    await editor.addConstraint("coincident", [s.lines[4]!.p2, s.lines[5]!.p1]);
    expect(forms(store)).toEqual(["Form 1: 2 shapes", "Form 2: 2 shapes"]);
    // Tie the two groups together: one group, Form 1; Form 2 is gone.
    await editor.addConstraint("coincident", [s.lines[4]!.p1, s.lines[1]!.p1]);
    expect(forms(store)).toEqual(["Form 1: 4 shapes"]);
    expect(sketchOf(store).shapeCounts!.form).toBe(2);
    // A new group is Form 3: number 2 is not given a second time.
    s = sketchOf(store);
    await editor.addLine({ x: 0, y: 90 }, { x: 10, y: 90 });
    await editor.addLine({ x: 20, y: 90 }, { x: 30, y: 90 });
    s = sketchOf(store);
    await editor.addConstraint("coincident", [s.lines.at(-2)!.p2, s.lines.at(-1)!.p1]);
    expect(forms(store)).toEqual(["Form 1: 4 shapes", "Form 3: 2 shapes"]);
  });

  it("split: the part with the most elements keeps the number, the other part gets a new one; a part of one shape is no group", () => {
    // Pure: shapes A (8 elements) and B (3) in Form 1 with C (3) and D (3); the tie between B and C goes away.
    const step = (id: string, kind: "rectangle" | "line", members: string[], number: number) => ({ id, kind, members, number });
    const base: SketchData = {
      points: ["a1", "a2", "a3", "a4", "b1", "b2", "c1", "c2", "d1", "d2"].map((id, i) => ({ id, x: i, y: 0 })),
      lines: [
        { id: "la1", p1: "a1", p2: "a2", construction: false }, { id: "la2", p1: "a2", p2: "a3", construction: false },
        { id: "la3", p1: "a3", p2: "a4", construction: false }, { id: "la4", p1: "a4", p2: "a1", construction: false },
        { id: "lb", p1: "b1", p2: "b2", construction: false }, { id: "lc", p1: "c1", p2: "c2", construction: false }, { id: "ld", p1: "d1", p2: "d2", construction: false },
      ],
      circles: [],
      constraints: [
        { id: "k1", kind: "coincident", refs: ["a1", "b1"] }, { id: "k2", kind: "coincident", refs: ["b2", "c1"] }, { id: "k3", kind: "coincident", refs: ["c2", "d1"] },
      ],
      steps: [
        step("sa", "rectangle", ["a1", "a2", "a3", "a4", "la1", "la2", "la3", "la4"], 1),
        step("sb", "line", ["b1", "b2", "lb"], 1), step("sc", "line", ["c1", "c2", "lc"], 2), step("sd", "line", ["d1", "d2", "ld"], 3),
      ],
    };
    const joined = reconcileForms(base);
    expect(formsOf(joined).map((f) => [f.number, f.shapes])).toEqual([[1, ["sa", "sb", "sc", "sd"]]]);
    const split = reconcileForms({ ...joined, constraints: joined.constraints.filter((c) => c.id !== "k2") });
    // {sa, sb} has 11 elements, {sc, sd} 6: the first keeps Form 1, the second is Form 2.
    expect(formsOf(split).map((f) => [f.number, f.shapes])).toEqual([[1, ["sa", "sb"]], [2, ["sc", "sd"]]]);
    expect(split.shapeCounts!.form).toBe(2);
    // Reconciling again changes nothing: the same object comes back.
    expect(reconcileForms(split)).toBe(split);
  });

  it("shrink: a group that is one shape again shows its kind's name, and its number is not used again", async () => {
    const { store, editor } = await open();
    await editor.addRectangle({ x: 0, y: 0 }, { x: 10, y: 10 });
    await editor.addCircle({ x: 30, y: 0 }, mm(4));
    const s = sketchOf(store);
    await editor.addConstraint("coincident", [s.circles[0]!.center, s.lines[0]!.p1]);
    expect(forms(store)).toEqual(["Form 1: 2 shapes"]);
    await editor.remove([s.circles[0]!.id]);
    expect(forms(store)).toEqual([]);
    expect(nameOf(editor, sketchOf(store).lines.map((l) => l.id))).toBe("Rechteck 1");
    // A new circle tied to the rectangle is a new group with a new number.
    await editor.addCircle({ x: 40, y: 0 }, mm(4));
    const n = sketchOf(store);
    await editor.addConstraint("coincident", [n.circles[0]!.center, n.lines[0]!.p1]);
    expect(forms(store)).toEqual(["Form 2: 2 shapes"]);
    expect(stepOf(store, "circle", 2)).toBeDefined();
  });

  it("undo and redo bring the same groups with the same numbers back", async () => {
    const { store, editor } = await open();
    await editor.addRectangle({ x: 0, y: 0 }, { x: 10, y: 10 });
    await editor.addCircle({ x: 30, y: 0 }, mm(4));
    const s = sketchOf(store);
    await editor.addConstraint("coincident", [s.circles[0]!.center, s.lines[0]!.p1]);
    expect(forms(store)).toEqual(["Form 1: 2 shapes"]);
    store.undo();
    expect(forms(store)).toEqual([]);
    store.redo();
    expect(forms(store)).toEqual(["Form 1: 2 shapes"]);
    store.undo();
    store.undo();
    store.redo();
    store.redo();
    expect(forms(store)).toEqual(["Form 1: 2 shapes"]);
  });

  it("reloading keeps the numbers; a stored document without forms gets them worked out", () => {
    const data = new Map<string, string>();
    const storage: SessionStorageLike = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
    const sketch: SketchData = {
      points: [{ id: "p1", x: 0, y: 0 }, { id: "p2", x: 5, y: 0 }, { id: "p3", x: 5, y: 0 }, { id: "p4", x: 9, y: 0 }],
      lines: [{ id: "l1", p1: "p1", p2: "p2", construction: false }, { id: "l2", p1: "p3", p2: "p4", construction: false }],
      circles: [],
      constraints: [{ id: "k1", kind: "coincident", refs: ["p2", "p3"] }],
      steps: [{ id: "s1", kind: "line", members: ["p1", "p2", "l1"] }, { id: "s2", kind: "line", members: ["p3", "p4", "l2"] }],
    };
    saveSessionDocument(document(sketch), storage);
    const loaded = loadSessionDocument(storage)!;
    const feature = loaded.timeline[0]!;
    expect(feature.type === "sketch" && (feature.sketch.forms ?? []).map((f) => f.number)).toEqual([1]);
    saveSessionDocument(loaded, storage);
    expect(loadSessionDocument(storage)).toEqual(loaded);
  });
});
