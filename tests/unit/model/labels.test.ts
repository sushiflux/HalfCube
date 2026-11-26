// Dimension labels in the sketch editor: the tools and the view use absolute points, the document keeps the label relative
// to the measured geometry, so the view's label point goes along when the geometry moves, is dragged or re-solved.
import { describe, expect, it } from "vitest";
import { DocumentStore } from "../../../app/src/document/store.ts";
import type { Dimension, SketchData } from "../../../app/src/document/types.ts";
import { documentProblems } from "../../../app/src/document/validate.ts";
import { sketchFeature } from "../../../app/src/model/doc-edit.ts";
import { SketchEditorImpl } from "../../../app/src/model/sketch-editor.ts";
import { sketchViewOf } from "../../../app/src/model/sketch-view.ts";
import { document } from "../../fixtures/engine/cases.ts";
import { solveLink } from "./solve-link.ts";

const mm = (value: number) => ({ value, unit: "mm" as const });

async function open() {
  const store = new DocumentStore(document({ points: [], lines: [], circles: [], constraints: [] }));
  const editor = await SketchEditorImpl.open({ link: solveLink(), store }, "f1", () => undefined);
  return { store, editor };
}
const sketchOf = (store: DocumentStore): SketchData => sketchFeature(store.getSnapshot(), "f1")!.sketch;
const dimensionsOf = (s: SketchData) => s.constraints.filter((c): c is Dimension => "driving" in c);
/** A label rounded to a number of decimals (no -0), so toEqual compares positions within a tolerance. */
const rounded = (v: { x: number; y: number } | undefined, digits = 9) => (v ? { x: Number(v.x.toFixed(digits)) + 0, y: Number(v.y.toFixed(digits)) + 0 } : null);

describe("dimension labels in the sketch editor", () => {
  it("a label set at an absolute point is stored relative and shown at that point", async () => {
    const { store, editor } = await open();
    await editor.addRectangle({ x: 0, y: 0 }, { x: 60, y: 40 });
    const bottom = sketchOf(store).lines[0]!;
    expect(await editor.addDimension("distance", [bottom.id], mm(60), { x: 45, y: -8 })).toEqual({ ok: true });
    expect(rounded(dimensionsOf(sketchOf(store))[0]!.label, 9)).toEqual(rounded({ x: 0.25, y: -8 }, 9));
    expect(rounded(editor.getView().dimensions[0]!.label, 9)).toEqual(rounded({ x: 45, y: -8 }, 9));
    expect(documentProblems(store.getSnapshot())).toEqual([]);
  });

  it("moveLabel takes an absolute point too, and is no solve and no step", async () => {
    const { store, editor } = await open();
    await editor.addRectangle({ x: 0, y: 0 }, { x: 60, y: 40 });
    const bottom = sketchOf(store).lines[0]!;
    await editor.addDimension("distance", [bottom.id], mm(60), { x: 30, y: -8 });
    const id = dimensionsOf(sketchOf(store))[0]!.id;
    const steps = sketchOf(store).steps!.length;
    expect(await editor.moveLabel(id, { x: 15, y: -20 })).toEqual({ ok: true });
    expect(rounded(dimensionsOf(sketchOf(store))[0]!.label, 9)).toEqual(rounded({ x: -0.25, y: -20 }, 9));
    expect(rounded(editor.getView().dimensions[0]!.label, 9)).toEqual(rounded({ x: 15, y: -20 }, 9));
    expect(sketchOf(store).steps).toHaveLength(steps);
  });

  it("the dimensions that come with a line and a circle are stored relative as well", async () => {
    const { store, editor } = await open();
    await editor.addLine({ x: 0, y: 0 }, { x: 40, y: 0 }, { length: mm(40) });
    await editor.addCircle({ x: 100, y: 0 }, mm(10));
    const [len, dia] = dimensionsOf(sketchOf(store));
    // Line: the label sits 6 mm to the side of the middle. Circle: up and right of the centre, in radii.
    expect(rounded(len!.label, 9)).toEqual(rounded({ x: 0, y: 6 }, 9));
    expect(Math.abs(dia!.label.x)).toBeLessThan(5);
    expect(rounded(editor.getView().dimensions[1]!.label, 9)).toEqual(rounded({
      x: 100 + dia!.label.x * 5,
      y: dia!.label.y * 5,
    }, 9));
  });

  it("the view puts the label where the geometry is now: moved points take the label along", async () => {
    const { store, editor } = await open();
    await editor.addRectangle({ x: 0, y: 0 }, { x: 60, y: 40 });
    const bottom = sketchOf(store).lines[0]!;
    await editor.addDimension("distance", [bottom.id], mm(60), { x: 45, y: -8 });
    const feature = sketchFeature(store.getSnapshot(), "f1")!;
    const solved = { ...feature.sketch, points: feature.sketch.points.map((p) => ({ ...p, x: p.x + 100, y: p.y + 30 })) };
    const view = sketchViewOf(feature, solved, { entities: {}, constraints: {}, reference: {}, profiles: [], frame: editor.getView().frame, status: "solved", dof: 0 } as never, false);
    expect(rounded(view.dimensions[0]!.label, 9)).toEqual(rounded({ x: 145, y: 22 }, 9));
    // Stretched to 100 mm: the label stays a quarter of the length right of the middle and 8 mm below.
    const longer = { ...feature.sketch, points: feature.sketch.points.map((p) => (p.x > 30 ? { ...p, x: p.x + 40 } : p)) };
    const stretched = sketchViewOf(feature, longer, { entities: {}, constraints: {}, reference: {}, profiles: [], frame: editor.getView().frame, status: "solved", dof: 0 } as never, false);
    expect(rounded(stretched.dimensions[0]!.label, 9)).toEqual(rounded({ x: 50 + 25, y: -8 }, 9));
  });

  it("a label whose geometry is gone still gives a view (at the origin), never an error", async () => {
    const { store, editor } = await open();
    await editor.addRectangle({ x: 0, y: 0 }, { x: 60, y: 40 });
    const bottom = sketchOf(store).lines[0]!;
    await editor.addDimension("distance", [bottom.id], mm(60), { x: 45, y: -8 });
    const feature = sketchFeature(store.getSnapshot(), "f1")!;
    const broken = { ...feature.sketch, lines: [] };
    const view = sketchViewOf(feature, broken, { entities: {}, constraints: {}, reference: {}, profiles: [], frame: editor.getView().frame, status: "solved", dof: 0 } as never, false);
    expect(view.dimensions[0]!.label).toEqual({ x: 0, y: 0 });
  });
});
