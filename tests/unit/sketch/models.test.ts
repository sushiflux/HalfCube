// The pure parts around the sketch tools: undo inside a sketch, the status of the palette, the texts of a refused edit,
// typed values, snapping and measuring.
import { describe, expect, it } from "vitest";
import { DocumentStore, createEmptyDocument } from "../../../app/src/document/index.ts";
import { makeState } from "../../../app/src/i18n/core.ts";
import { SketchHistory } from "../../../app/src/screens/sketch/history.ts";
import { measureDimension, pointPairKind } from "../../../app/src/screens/sketch/measure.ts";
import { rejectText } from "../../../app/src/screens/sketch/reject-model.ts";
import type { Rejection } from "../../../app/src/screens/sketch/session.ts";
import { inferDirection } from "../../../app/src/screens/sketch/snap.ts";
import { sketchStatus } from "../../../app/src/screens/sketch/status-model.ts";
import { TypedFields } from "../../../app/src/screens/sketch/typed-fields.ts";
import { FakeEditor } from "./fakes.ts";

describe("sketch history (undo inside an open sketch)", () => {
  const store = () => new DocumentStore(createEmptyDocument({ rootName: "Teil" }));
  const change = (s: DocumentStore) => s.commit((d) => ({ ...d }));

  it("reaches back only as far as the steps made in the sketch", () => {
    const s = store();
    change(s); // before the sketch was opened: not ours
    const h = new SketchHistory(s);
    expect(h.getState()).toEqual({ canUndo: false, canRedo: false });
    expect(h.undo()).toBe(false);
    change(s);
    change(s);
    expect(h.getState().canUndo).toBe(true);
    expect(h.undo()).toBe(true);
    expect(h.undo()).toBe(true);
    expect(h.undo()).toBe(false);
    expect(h.getState()).toEqual({ canUndo: false, canRedo: true });
    expect(s.canUndo).toBe(true); // the step before the sketch is still there, untouched
  });

  it("redo returns the steps, a new edit ends the redo chain", () => {
    const s = store();
    const h = new SketchHistory(s);
    change(s);
    change(s);
    h.undo();
    h.undo();
    expect(h.redo()).toBe(true);
    change(s);
    expect(h.getState().canRedo).toBe(false);
    expect(h.redo()).toBe(false);
  });

  it("a group of several commits is ONE step of the sketch: counted once, undone and redone at once", () => {
    const s = store();
    const h = new SketchHistory(s);
    s.group(() => {
      change(s);
      change(s);
      change(s);
    });
    change(s); // a step of its own
    expect(h.undo()).toBe(true); // the single one
    expect(h.undo()).toBe(true); // the whole group
    expect(h.undo()).toBe(false);
    expect(h.getState()).toEqual({ canUndo: false, canRedo: true });
    expect(h.redo()).toBe(true);
    expect(h.redo()).toBe(true);
    expect(h.redo()).toBe(false);
    expect(h.getState()).toEqual({ canUndo: true, canRedo: false });
  });

  it("a group opened inside the sketch does not reach back past the sketch's start", () => {
    const s = store();
    change(s); // before the sketch was opened
    const h = new SketchHistory(s);
    s.group(() => {
      change(s);
      change(s);
    });
    expect(h.undo()).toBe(true);
    expect(h.undo()).toBe(false);
    expect(s.canUndo).toBe(true);
  });

  it("tells the listeners only when the state changes", () => {
    const s = store();
    const h = new SketchHistory(s);
    let n = 0;
    h.subscribe(() => (n += 1));
    change(s);
    change(s);
    expect(n).toBe(1);
    h.dispose();
    change(s);
    expect(n).toBe(1);
  });
});

describe("sketch status", () => {
  const editor = new FakeEditor();
  const view = (patch: Partial<ReturnType<FakeEditor["getView"]>>) => ({ ...editor.getView(), ...patch });
  const full = view({ points: [{ id: "p1", x: 0, y: 0, state: "full" }], lines: [], circles: [] });

  it("names the kinds", () => {
    expect(sketchStatus(view({}), false).kind).toBe("none");
    expect(sketchStatus(view({}), true).kind).toBe("draw");
    expect(sketchStatus({ ...full, dof: 2 }, false)).toEqual({ kind: "under", dof: 2 });
    expect(sketchStatus({ ...full, dof: 0 }, false)).toEqual({ kind: "full", dof: 0 });
    expect(sketchStatus({ ...full, status: "conflicting" }, false).kind).toBe("over");
    expect(sketchStatus({ ...full, status: "redundant" }, false).kind).toBe("over");
    expect(sketchStatus({ ...full, status: "failed" }, false).kind).toBe("failed");
  });
});

describe("texts of a refused edit", () => {
  const { t } = makeState("de");
  const view = new FakeEditor().getView();
  const base = (patch: Partial<Rejection>): Rejection =>
    ({
      action: { kind: "dimension", dimension: { dimKind: "distance", refs: ["l1"], label: { x: 0, y: 0 }, value: { value: 70, unit: "mm" } } },
      outcome: { ok: false, reason: "rejected", problem: { code: "sketch_conflicting", message: "The sketch was not solved.", refs: ["d3", "k4"] }, conflicting: ["d3", "k4"], redundant: [] },
      view: {
        ...view,
        shapes: [{ id: "s1", kind: "rectangle", number: 1, members: ["p1", "p2", "l1", "l2"] }],
        dimensions: [{ id: "d3", kind: "distance", refs: ["l1"], number: 3, value: { value: 60, unit: "mm" }, driving: true, label: { x: 0, y: 0 }, state: "ok" }],
        constraints: [{ id: "k4", kind: "vertical", refs: ["l2"], state: "ok" }],
      },
      ...patch,
    });

  it("a contradicting dimension: names what it contradicts, offers the reference dimension, is complete", () => {
    const r = rejectText(t, base({}), true);
    expect(r.offerReference).toBe(true);
    expect(r.code).toBe("HC-SKETCH-CONFLICTING");
    const text = r.blocks.map((b) => b.text).join("\n");
    expect(text).toContain("Länge 70 mm wurde nicht übernommen");
    // The sketch's own names: the dimension d3 with its value, the constraint with the shape it holds, never an element id.
    expect(text).toContain("d3 · 60 mm");
    expect(text).toContain("Vertikal: Rechteck 1");
    expect(text).not.toMatch(/\((?:[lkpc]\d+|d\d+)\)|\bl1\b|\bk4\b/);
    // d3 is in the sketch; an id it does not know is the refused dimension itself.
    const unknown = rejectText(t, base({ outcome: { ok: false, reason: "rejected", problem: { code: "sketch_conflicting", message: "x", refs: ["d3", "d99"] }, conflicting: ["d3", "d99"], redundant: [] } }), true);
    expect(unknown.blocks.map((b) => b.text).join(" ")).toContain("dieses Maß (Länge 70 mm)");
    expect(text).toContain("„Als Referenzmaß anlegen“");
    expect(text).not.toContain("Bedingung");
  });

  it("the engine's own sentence says the same words: names instead of ids, the refused constraint as 'diese Abhängigkeit'", () => {
    const message = "Constraints of the sketch contradict each other, among them: k4, d3, k99. The sketch was not solved.";
    const r = rejectText(
      t,
      base({
        action: { kind: "constraint" },
        outcome: { ok: false, reason: "rejected", problem: { code: "sketch_conflicting", message, refs: ["k4", "d3", "k99"] }, conflicting: ["k4", "d3", "k99"], redundant: [] },
      }),
      true,
    );
    const text = r.blocks.map((b) => b.text).join("\n");
    expect(text).toContain("Engine: Constraints of the sketch contradict each other, among them: Vertikal: Rechteck 1, d3 · 60 mm, diese Abhängigkeit. The sketch was not solved.");
    expect(text).toContain("Widerspricht: Vertikal: Rechteck 1; d3 · 60 mm; diese Abhängigkeit");
    expect(text).not.toMatch(/\b[lkpc]\d+\b|\(d\d+\)/);
  });

    it("other edits only inform", () => {
    const r = rejectText(t, base({ action: { kind: "constraint" } }), true);
    expect(r.offerReference).toBe(false);
    expect(r.title).toBe("Abhängigkeit nicht übernommen");
  });

  it("an engine failure and an invalid edit have their own codes", () => {
    expect(rejectText(t, base({ outcome: { ok: false, reason: "engine", error: new Error("worker gone") } }), true).code).toBe("HC-SKETCH-ENGINE");
    const invalid = rejectText(t, base({ outcome: { ok: false, reason: "invalid", message: "no such point" } }), true);
    expect(invalid.code).toBe("HC-SKETCH-INVALID");
    expect(invalid.blocks[0]!.text).toContain("no such point");
  });

  it("English reads English", () => {
    const en = makeState("en").t;
    expect(rejectText(en, base({}), false).title).toBe("Dimension contradicts the sketch");
  });
});

describe("typed values", () => {
  const fields = () =>
    new TypedFields([
      { id: "length", kind: "length", sign: "positive" },
      { id: "angle", kind: "angle", sign: "any" },
    ]);

  it("opens with the first character and reads units live", () => {
    const f = fields();
    f.open("4");
    expect(f.isOpen).toBe(true);
    f.setText("length", "4 cm");
    expect(f.value("length")).toEqual({ value: 40, unit: "mm" });
    expect(f.parse("angle")).toBeNull();
    f.setText("length", "-3");
    expect(f.hasError()).toBe(true);
    expect(f.hasValues).toBe(false);
  });

  it("Tab goes round and closing forgets everything", () => {
    const f = fields();
    f.open("1");
    f.next();
    expect(f.active).toBe("angle");
    f.next();
    expect(f.active).toBe("length");
    f.close();
    expect(f.isOpen).toBe(false);
    expect(f.text("length")).toBe("");
  });

  it("before typing opens, Tab only moves the selection; the next character lands there and locks the field", () => {
    const f = fields();
    expect(f.selected).toBe("length");
    f.next();
    expect(f.selected).toBe("angle");
    expect(f.isOpen).toBe(false);
    f.open("9");
    expect(f.active).toBe("angle");
    expect(f.isLocked("angle")).toBe(true);
    expect(f.isLocked("length")).toBe(false);
    f.setText("angle", "  ");
    expect(f.isLocked("angle")).toBe(false);
    f.close();
    expect(f.selected).toBe("length");
  });
});

describe("snapping and measuring", () => {
  it("takes a nearly horizontal or vertical end as exactly that, not a short one", () => {
    expect(inferDirection([0, 0], [30, 0.3], 10)).toEqual({ direction: "horizontal", end: [30, 0] });
    expect(inferDirection([0, 0], [0.4, 30], 10)).toEqual({ direction: "vertical", end: [0, 30] });
    expect(inferDirection([0, 0], [30, 10], 10).direction).toBeNull();
    expect(inferDirection([0, 0], [1, 0.1], 10).direction).toBeNull();
  });

  it("measures what a dimension would say", () => {
    const e = new FakeEditor();
    e.seed({ points: [["p1", 0, 0], ["p2", 30, 40], ["p3", 30, 0]], lines: [["l1", "p1", "p2"], ["l2", "p1", "p3"]], circles: [["c1", "p1", 4]] });
    const v = e.getView();
    expect(measureDimension(v, "distance", ["l1"])).toBe(50);
    expect(measureDimension(v, "distance", ["p1", "p2"])).toBe(50);
    expect(measureDimension(v, "distanceX", ["p1", "p2"])).toBe(30);
    expect(measureDimension(v, "distanceY", ["@origin", "p2"])).toBe(40);
    expect(measureDimension(v, "diameter", ["c1"])).toBe(8);
    expect(measureDimension(v, "angle", ["l2", "l1"])).toBeCloseTo(53.130102, 5);
    expect(measureDimension(v, "distance", ["l9"])).toBeNull();
  });

  it("decides the direction of a point-to-point dimension by where the label is held", () => {
    expect(pointPairKind([0, 0], [40, 30], [20, 15])).toBe("distance");
    expect(pointPairKind([0, 0], [40, 30], [20, 50])).toBe("distanceX");
    expect(pointPairKind([0, 0], [40, 30], [70, 15])).toBe("distanceY");
  });
});
