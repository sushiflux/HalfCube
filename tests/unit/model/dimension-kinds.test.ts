// The sketch editor and the new dimensions: an angle stores the rays of the sector the label is in, distances take what
// was clicked. Against the stand-in engine of solve-link.ts; the real engines are in the contract tests.
import { describe, expect, it } from "vitest";
import { DocumentStore } from "../../../app/src/document/store.ts";
import type { Dimension, SketchData } from "../../../app/src/document/types.ts";
import { documentProblems } from "../../../app/src/document/validate.ts";
import { sketchFeature } from "../../../app/src/model/doc-edit.ts";
import { SketchEditorImpl } from "../../../app/src/model/sketch-editor.ts";
import { document } from "../../fixtures/engine/cases.ts";
import { solveLink } from "./solve-link.ts";

const mm = (value: number) => ({ value, unit: "mm" as const });
const deg = (value: number) => ({ value, unit: "deg" as const });

const sketch: SketchData = {
  points: [
    { id: "p1", x: 0, y: 0 },
    { id: "p2", x: 40, y: 0 },
    { id: "p3", x: 40, y: 30 },
    { id: "p4", x: 0, y: 30 },
    { id: "pa", x: 0, y: 60 },
    { id: "pb", x: 40, y: 60 },
    { id: "o1", x: 20, y: 15 },
    { id: "o2", x: 30, y: 15 },
  ],
  lines: [
    { id: "l1", p1: "p1", p2: "p2", construction: false },
    { id: "l2", p1: "p2", p2: "p3", construction: false },
    { id: "l3", p1: "p3", p2: "p4", construction: false },
    { id: "l4", p1: "p4", p2: "p1", construction: false },
    { id: "l5", p1: "pa", p2: "pb", construction: false },
  ],
  circles: [
    { id: "c1", center: "o1", radius: 4, construction: false },
    { id: "c2", center: "o2", radius: 4, construction: false },
  ],
  constraints: [],
};

async function open() {
  const store = new DocumentStore(document(structuredClone(sketch)));
  const editor = await SketchEditorImpl.open({ link: solveLink(), store }, "f1", () => undefined);
  return { store, editor };
}
const dimensions = (store: DocumentStore): Dimension[] =>
  sketchFeature(store.getSnapshot(), "f1")!.sketch.constraints.filter((c): c is Dimension => "driving" in c);

describe("an angle dimension stores the rays of the sector the label is in", () => {
  it("inside the corner: east and the turned ray of l4; the label is stored relative to that corner", async () => {
    const { store, editor } = await open();
    expect(await editor.addDimension("angle", ["l1", "l4"], null, { x: 6, y: 6 })).toEqual({ ok: true });
    const [d] = dimensions(store);
    expect(d).toMatchObject({ kind: "angle", refs: ["l1", "l4"], reverse: [false, true], driving: true });
    expect(documentProblems(store.getSnapshot())).toEqual([]);
    // The view shows the label where it was set.
    expect(editor.getView().dimensions[0]!.label.x).toBeCloseTo(6, 9);
    expect(editor.getView().dimensions[0]!.label.y).toBeCloseTo(6, 9);
    expect(editor.getView().dimensions[0]!.reverse).toEqual([false, true]);
  });

  it("in the opposite sector the other rays, and in a sector that needs the lines the other way round they swap places", async () => {
    const { store, editor } = await open();
    await editor.addDimension("angle", ["l1", "l4"], null, { x: -6, y: -6 });
    await editor.addDimension("angle", ["l1", "l4"], null, { x: -6, y: 6 });
    const [outside, swapped] = dimensions(store);
    expect(outside).toMatchObject({ refs: ["l1", "l4"], reverse: [true, false] });
    expect(swapped).toMatchObject({ refs: ["l4", "l1"], reverse: [true, true] });
  });

  it("two parallel lines have no angle", async () => {
    const { store, editor } = await open();
    expect(await editor.addDimension("angle", ["l1", "l5"], null, { x: 6, y: 6 })).toMatchObject({ ok: false, reason: "invalid" });
    expect(dimensions(store)).toHaveLength(0);
  });

  it("the value of an angle between rays is from 0 to 180 degrees; the old reading takes any value", async () => {
    const { store, editor } = await open();
    expect(await editor.addDimension("angle", ["l1", "l4"], deg(200), { x: 6, y: 6 })).toMatchObject({ ok: false, reason: "invalid" });
    expect(await editor.addDimension("angle", ["l1", "l4"], deg(60), { x: 6, y: 6 })).toEqual({ ok: true });
    const id = dimensions(store)[0]!.id;
    expect(await editor.setDimension(id, deg(181))).toMatchObject({ ok: false, reason: "invalid" });
    expect(await editor.setDimension(id, deg(120))).toEqual({ ok: true });
    // An angle of a line against the axis (the old reading, no reverse) keeps its 0 to 360 range.
    expect(await editor.addLine({ x: 0, y: 100 }, { x: 10, y: 100 }, { angle: deg(300) })).toEqual({ ok: true });
    expect(dimensions(store).at(-1)!.reverse).toBeUndefined();
  });

  it("the stored flags survive the move of a label", async () => {
    const { store, editor } = await open();
    await editor.addDimension("angle", ["l1", "l4"], null, { x: 6, y: 6 });
    const id = dimensions(store)[0]!.id;
    await editor.moveLabel(id, { x: 12, y: 3 });
    expect(dimensions(store)[0]!.reverse).toEqual([false, true]);
    expect(editor.getView().dimensions[0]!.label.x).toBeCloseTo(12, 9);
    expect(editor.getView().dimensions[0]!.label.y).toBeCloseTo(3, 9);
  });
});

describe("distances with what was clicked", () => {
  it("every pair of point, line and circle is a distance dimension, stored in the order given", async () => {
    const { store, editor } = await open();
    for (const refs of [["p3", "l1"], ["l1", "p3"], ["l1", "l5"], ["p3", "c1"], ["c1", "l1"], ["c1", "p3"], ["c1", "o2"]]) {
      expect(await editor.addDimension("distance", refs, mm(5), { x: 10, y: 10 })).toEqual({ ok: true });
    }
    expect(dimensions(store).map((d) => d.refs)).toEqual([["p3", "l1"], ["l1", "p3"], ["l1", "l5"], ["p3", "c1"], ["c1", "l1"], ["c1", "p3"], ["c1", "o2"]]);
    expect(documentProblems(store.getSnapshot())).toEqual([]);
  });

  it("two circles that cross have no gap to measure; a point without direction has nothing to measure", async () => {
    const { store, editor } = await open();
    // c1 and c2 (radius 4 each, centres 10 apart) do not cross; make c2 cross c1.
    const crossing = structuredClone(sketch);
    crossing.points[7] = { id: "o2", x: 26, y: 15 };
    const own = new DocumentStore(document(crossing));
    const crossEditor = await SketchEditorImpl.open({ link: solveLink(), store: own }, "f1", () => undefined);
    expect(await crossEditor.addDimension("distance", ["c1", "c2"], null, { x: 10, y: 10 })).toMatchObject({ ok: false, reason: "invalid" });
    expect(await editor.addDimension("distance", ["o1", "c1"], null, { x: 10, y: 10 })).toMatchObject({ ok: false, reason: "invalid" });
    expect(dimensions(store)).toHaveLength(0);
  });

  it("the label of such a distance moves with what it measures", async () => {
    const { store, editor } = await open();
    await editor.addDimension("distance", ["c1", "l1"], mm(11), { x: 30, y: 6 });
    const stored = dimensions(store)[0]!;
    // The measured segment runs from the rim of c1 down to the line (u = 20, v from 11 to 0), its middle is (20, 5.5). It points
    // to -v, so its left side is +u: the label at (30, 6) is 10 mm to the left of the segment and half a mm back along it (of 11).
    expect(stored.label.x).toBeCloseTo(-0.5 / 11, 9);
    expect(stored.label.y).toBeCloseTo(10, 9);
    expect(editor.getView().dimensions[0]!.label.x).toBeCloseTo(30, 9);
    expect(editor.getView().dimensions[0]!.label.y).toBeCloseTo(6, 9);
  });
});
