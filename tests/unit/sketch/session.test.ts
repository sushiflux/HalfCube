// The sketch tools and the session, driven the way the page drives them: pointer positions in, editor calls out. The editor
// and the layer are fakes (fakes.ts), so every tool state machine runs without a browser or an engine.
import { beforeEach, describe, expect, it } from "vitest";
import { SketchSession, type RejectChoice, type Rejection } from "../../../app/src/screens/sketch/session.ts";
import { constraintFromSelection, constraintSpecs } from "../../../app/src/screens/sketch/constraint-tool.ts";
import type { ToolId } from "../../../app/src/screens/sketch/tool.ts";
import type { EditOutcome } from "../../../app/src/model/index.ts";
import { FakeEditor, FakeLayer, px } from "./fakes.ts";

const rejected = (code: "sketch_conflicting" | "sketch_redundant" = "sketch_redundant"): EditOutcome => ({
  ok: false,
  reason: "rejected",
  problem: { code, message: "The sketch was not solved." },
  conflicting: code === "sketch_conflicting" ? ["k9"] : [],
  redundant: code === "sketch_redundant" ? ["d3"] : [],
});

let editor: FakeEditor;
let layer: FakeLayer;
let session: SketchSession;
let rejections: Rejection[];
let choice: RejectChoice;

function start(): void {
  editor = new FakeEditor();
  layer = new FakeLayer(editor);
  rejections = [];
  choice = "cancel";
  session = new SketchSession({
    editor,
    layer,
    options: { highlight: "band", colour: "green", showConstraints: true, showDimensions: true },
    reject: (r) => {
      rejections.push(r);
      return Promise.resolve(choice);
    },
    decimalComma: false,
  });
}

async function move(u: number, v: number, shift = false): Promise<void> {
  const [x, y] = px(u, v);
  session.pointerMove(x, y, shift);
}
async function click(u: number, v: number, shift = false): Promise<void> {
  const [x, y] = px(u, v);
  session.pointerMove(x, y, shift);
  await session.pointerDown(x, y, shift);
  await session.pointerUp(x, y, shift);
}
const key = (k: string, extra: Partial<{ ctrl: boolean; shift: boolean }> = {}) =>
  session.key({ key: k, ctrl: extra.ctrl ?? false, alt: false, meta: false, shift: extra.shift ?? false });
const calls = (name: string) => editor.calls.filter((c) => c.name === name);

beforeEach(start);

describe("line tool", () => {
  it("draws a chain of segments; a click on the origin snaps; a nearly vertical segment becomes vertical", async () => {
    session.setTool("line");
    await click(0, 0);
    await click(20, 5);
    expect(calls("addLine")[0]!.args).toEqual([{ snap: "@origin" }, { x: 20, y: 5 }, {}]);
    // The chain goes on from the point just made; 0.4 mm off the vertical (4 px) is vertical.
    await click(20.4, 25);
    const second = calls("addLine")[1]!;
    expect(second.args[0]).toEqual({ snap: editor.view.lines[0]!.p2 });
    expect(second.args[1]).toEqual({ x: 20, y: 25 });
    expect(second.args[2]).toEqual({ angle: { value: 90, unit: "deg" } });
    expect(session.getState().inProgress).toBe(true);
  });

  it("shows the rubber band and a horizontal hint in the preview", async () => {
    session.setTool("line");
    await click(5, 5);
    await move(30, 5.3);
    expect(layer.preview?.lines).toEqual([{ a: [5, 5], b: [30, 5] }]);
    expect(layer.preview?.hints?.map((h) => h.kind)).toContain("horizontal");
    await move(30, 15);
    expect(layer.preview?.hints ?? []).toEqual([]);
  });

  it("ends the chain on an existing point and snaps onto curves", async () => {
    editor.seed({ points: [["p1", 40, 0], ["p2", 40, 30]], lines: [["l1", "p1", "p2"]] });
    session.setTool("line");
    await click(10, 10);
    await click(40, 15); // on the line l1
    expect(calls("addLine")[0]!.args[1]).toEqual({ x: 40, y: 15, onCurve: "l1" });
    await click(50, 15);
    // new chain segment starts at the point just made; end on p2 closes and ends
    await click(40, 30);
    expect(calls("addLine")[2]!.args[1]).toEqual({ snap: "p2" });
    expect(session.getState().inProgress).toBe(false);
  });

  it("Esc ends the chain, a second Esc leaves the tool, a third clears the selection", async () => {
    session.setTool("line");
    await click(5, 5);
    expect(session.getState().inProgress).toBe(true);
    expect(session.escape()).toBe(true);
    expect(session.getState().inProgress).toBe(false);
    expect(session.getState().tool).toBe("line");
    expect(session.escape()).toBe(true);
    expect(session.getState().tool).toBe("select");
    expect(session.escape()).toBe(false);
  });

  it("typed length and angle follow in the preview, Tab changes the field, Enter commits, Esc discards the typing only", async () => {
    session.setTool("line");
    await click(5, 5);
    await move(30, 5);
    expect(key("2")).toBe(true);
    expect(session.getState().typed?.active).toBe("length");
    session.setTyped("length", "20");
    expect(layer.preview?.lines?.[0]).toEqual({ a: [5, 5], b: [25, 5] });
    session.nextTyped();
    expect(session.getState().typed?.active).toBe("angle");
    session.setTyped("angle", "90");
    const b = layer.preview!.lines![0]!.b;
    expect(b[0]).toBeCloseTo(5, 9);
    expect(b[1]).toBeCloseTo(25, 9);
    session.setTyped("length", "2x");
    expect(session.getState().typed?.fields[0]?.error?.error).toBe("unknownUnit");
    await session.commitTyped();
    expect(calls("addLine")).toHaveLength(0);
    session.setTyped("length", "20");
    await session.commitTyped();
    const args = calls("addLine")[0]!.args;
    expect(args[0]).toEqual({ x: 5, y: 5 });
    expect((args[1] as { x: number; y: number }).y).toBeCloseTo(25, 9);
    expect(args[2]).toEqual({ length: { value: 20, unit: "mm" }, angle: { value: 90, unit: "deg" } });
  });

  it("Esc while typing discards the typing but keeps the start point", async () => {
    session.setTool("line");
    await click(5, 5);
    key("3");
    expect(session.getState().typed?.typing).toBe(true);
    session.escape();
    // The typing is gone; the fields stay (they are live from the first point on) and follow the pointer again.
    expect(session.getState().typed?.typing).toBe(false);
    expect(session.getState().typed?.fields.every((f) => !f.locked && f.text === "")).toBe(true);
    expect(session.getState().inProgress).toBe(true);
  });

  it("a refused line opens the message and resets the tool", async () => {
    editor.refuse = (name) => (name === "addLine" ? rejected("sketch_conflicting") : undefined);
    session.setTool("line");
    await click(5, 5);
    await click(30, 20);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.action.kind).toBe("line");
    expect(session.getState().inProgress).toBe(false);
  });
});

describe("rectangle and circle tools", () => {
  it("draws a rectangle from two corners", async () => {
    session.setTool("rectangle");
    await click(0, 0);
    await click(40, 25);
    expect(calls("addRectangle")[0]!.args).toEqual([{ snap: "@origin" }, { x: 40, y: 25 }]);
    expect(calls("addDimension")).toHaveLength(0);
    expect(session.getState().inProgress).toBe(false);
    expect(session.getState().tool).toBe("select");
  });

  it("typed width and height make the corner and then two dimensions on the first two edges", async () => {
    session.setTool("rectangle");
    await click(10, 10);
    await move(-5, 0); // towards the lower left
    key("6");
    session.setTyped("width", "60");
    session.nextTyped();
    session.setTyped("height", "30");
    expect(layer.preview?.lines).toHaveLength(4);
    await session.commitTyped();
    expect(calls("addRectangle")[0]!.args).toEqual([{ x: 10, y: 10 }, { x: -50, y: -20 }]);
    const dims = calls("addDimension");
    expect(dims.map((d) => [d.args[0], (d.args[2] as { value: number }).value])).toEqual([
      ["distance", 60],
      ["distance", 30],
    ]);
    const lines = editor.view.lines;
    expect(dims[0]!.args[1]).toEqual([lines[lines.length - 4]!.id]);
    expect(dims[1]!.args[1]).toEqual([lines[lines.length - 3]!.id]);
  });

  it("draws a circle by centre and size; a typed diameter wins", async () => {
    session.setTool("circle");
    await click(10, 10);
    await move(25, 10);
    expect(layer.preview?.circles).toEqual([{ c: [10, 10], r: 15 }]);
    await click(25, 10);
    expect(calls("addCircle")[0]!.args).toEqual([{ x: 10, y: 10 }, { value: 30, unit: "mm" }]);
    expect(session.getState().tool).toBe("select"); // one element, then back to selecting
    session.setTool("circle");
    await click(30, 30);
    key("4");
    session.setTyped("diameter", "40");
    await session.commitTyped();
    expect(calls("addCircle")[1]!.args[1]).toEqual({ value: 40, unit: "mm" });
  });

  it("press-drag-release draws a rectangle in one gesture", async () => {
    session.setTool("rectangle");
    const [x1, y1] = px(10, 10);
    const [x2, y2] = px(50, 40);
    session.pointerMove(x1, y1);
    await session.pointerDown(x1, y1);
    session.pointerMove(x2, y2);
    await session.pointerUp(x2, y2);
    expect(calls("addRectangle")).toHaveLength(1);
  });
});

describe("dimension tool", () => {
  beforeEach(() => {
    editor.seed({ points: [["p1", 0, 0], ["p2", 40, 0], ["p3", 40, 30]], lines: [["l1", "p1", "p2"], ["l2", "p2", "p3"]], circles: [["c1", "p1", 5]] });
    layer.setSketch(editor.view, { highlight: "band", colour: "green", showConstraints: true, showDimensions: true });
  });

  it("measures a line: pick, place, the value box opens with the measured value; typing previews, Enter commits", async () => {
    session.setTool("dimension");
    await click(20, 0); // the line l1 (the points p1 and p2 are 20 mm away)
    expect(layer.selection).toContain("l1");
    await move(20, 8);
    expect(session.getState().ghost).toMatchObject({ dimKind: "distance", value: 40 });
    await click(20, 8);
    expect(calls("addDimension")[0]!.args).toEqual(["distance", ["l1"], null, { x: 20, y: 8 }, undefined]);
    const edit = session.getState().dimEdit!;
    expect(edit.text).toBe("40");
    session.setDimText("55");
    expect(calls("previewDimension").at(-1)!.args).toEqual([edit.id, { value: 55, unit: "mm" }]);
    session.setDimText("5x");
    expect(session.getState().dimEdit?.error).not.toBeNull();
    await session.commitDimEdit();
    expect(calls("setDimension")).toHaveLength(0);
    session.setDimText("55");
    await session.commitDimEdit();
    expect(calls("setDimension")[0]!.args).toEqual([edit.id, { value: 55, unit: "mm" }]);
    expect(session.getState().dimEdit).toBeNull();
  });

  it("Esc restores the old value and leaves the dimension as it was", async () => {
    session.setTool("dimension");
    await click(20, 0);
    await click(20, 8);
    session.setDimText("99");
    session.escape();
    expect(calls("cancelPreview")).not.toHaveLength(0);
    expect(calls("setDimension")).toHaveLength(0);
    expect(session.getState().dimEdit).toBeNull();
  });

  it("Enter without a changed value changes nothing", async () => {
    session.setTool("dimension");
    await click(20, 0);
    await click(20, 8);
    await session.commitDimEdit();
    expect(calls("setDimension")).toHaveLength(0);
  });

  it("two points: above the points the horizontal distance, beside them the vertical one, inside the aligned one", async () => {
    session.setTool("dimension");
    await click(0, 0);
    await click(40, 0); // p1, p2 are points: the second pick
    await move(20, 12);
    expect(session.getState().ghost).toMatchObject({ dimKind: "distanceX", value: 40 });
    session.escape();
    session.setTool("dimension");
    await click(0, 0);
    await click(40, 30);
    await move(55, 10);
    expect(session.getState().ghost).toMatchObject({ dimKind: "distanceY", value: 30 });
    await move(10, 10);
    expect(session.getState().ghost).toMatchObject({ dimKind: "distance", value: 50 });
  });

  it("two lines measure the angle, a circle its diameter", async () => {
    session.setTool("dimension");
    await click(20, 0);
    await click(40, 15); // the second line l2
    await move(50, 5);
    expect(session.getState().ghost).toMatchObject({ dimKind: "angle", value: 90 });
    session.escape();
    session.escape();
    session.setTool("dimension");
    await click(0, 5); // the circle c1 passes through (0, 5)
    await click(8, 8);
    expect(calls("addDimension").at(-1)!.args.slice(0, 2)).toEqual(["diameter", ["c1"]]);
  });

  it("when the sketch already fixes the quantity the dimension becomes a reference dimension at once: no box, no dialog, a calm notice", async () => {
    editor.refuse = (name, args) => (name === "addDimension" && (args[4] as { driving?: boolean } | undefined)?.driving !== false ? rejected("sketch_redundant") : undefined);
    session.setTool("dimension");
    await click(20, 0);
    await click(20, 8);
    expect(rejections).toHaveLength(0);
    expect(session.getState().dimEdit).toBeNull();
    expect(session.getState().notice).toBe("alreadyFixed");
    // The refused try as a driving dimension, then the same dimension as a reference dimension with the measured value.
    const tries = calls("addDimension");
    expect(tries.map((c) => (c.args[4] as { driving?: boolean } | undefined)?.driving)).toEqual([undefined, false]);
    expect(tries.at(-1)!.args[2]).toBeNull();
    expect(editor.view.dimensions.at(-1)).toMatchObject({ kind: "distance", refs: ["l1"], driving: false });
    // The notice goes with the next click, and stays while the pointer only moves.
    await move(5, 5);
    expect(session.getState().notice).toBe("alreadyFixed");
    await click(0, 0);
    expect(session.getState().notice).toBeNull();
  });

  it("a refused new value of an existing dimension: the reference choice turns that dimension into a reference", async () => {
    session.setTool("dimension");
    await click(20, 0);
    await click(20, 8);
    const id = session.getState().dimEdit!.id!;
    session.setDimText("70");
    editor.refuse = (name) => (name === "setDimension" ? rejected("sketch_conflicting") : undefined);
    choice = "reference";
    await session.commitDimEdit();
    expect(calls("setDriving").at(-1)!.args).toEqual([id, false]);
    expect(calls("cancelPreview")).not.toHaveLength(0);
  });

  it("Abbrechen leaves the sketch alone", async () => {
    session.setTool("dimension");
    await click(20, 0);
    await click(20, 8);
    session.setDimText("70");
    editor.refuse = (name) => (name === "setDimension" ? rejected("sketch_conflicting") : undefined);
    choice = "cancel";
    await session.commitDimEdit();
    expect(calls("setDriving")).toHaveLength(0);
  });
});

describe("constraint tools", () => {
  beforeEach(() => {
    editor.seed({ points: [["p1", 0, 0], ["p2", 40, 0], ["p3", 40, 30]], lines: [["l1", "p1", "p2"], ["l2", "p2", "p3"]], circles: [["c1", "p3", 5]] });
  });

  it("horizontal needs one line", async () => {
    session.setTool("horizontal");
    await click(40, 0 + 0); // p2, not a line: ignored
    expect(calls("addConstraint")).toHaveLength(0);
    await click(20, 0);
    expect(calls("addConstraint")[0]!.args).toEqual(["horizontal", ["l1"]]);
  });

  it("coincident takes two points, the origin counts", async () => {
    session.setTool("coincident");
    await click(40, 0);
    expect(session.getState().inProgress).toBe(true);
    await click(0, 0); // p1 sits on the origin; the point wins over the origin
    expect(calls("addConstraint")[0]!.args).toEqual(["coincident", ["p2", "p1"]]);
  });

  it("point on curve takes the two in either order", async () => {
    session.setTool("pointOnCurve");
    await click(20, 0);
    await click(40, 30);
    expect(calls("addConstraint")[0]!.args).toEqual(["pointOnCurve", ["p3", "l1"]]);
  });

  it("equal does not mix a line with a circle", async () => {
    session.setTool("equal");
    await click(20, 0);
    await click(45, 30); // the circle c1 around p3
    expect(calls("addConstraint")).toHaveLength(0);
    await click(40, 15);
    expect(calls("addConstraint")[0]!.args).toEqual(["equal", ["l1", "l2"]]);
  });

  it("what is selected already gets the constraint at once and the select tool stays", async () => {
    await click(20, 0);
    expect(session.getState().selection).toEqual(["l1"]);
    session.setTool("vertical");
    await Promise.resolve();
    await Promise.resolve();
    expect(calls("addConstraint")[0]!.args).toEqual(["vertical", ["l1"]]);
    expect(session.getState().tool).toBe("select");
  });

  it("the specs resolve references in the order the engine wants them", () => {
    expect(constraintFromSelection("parallel", ["l1", "l2"])).toEqual(["l1", "l2"]);
    expect(constraintFromSelection("parallel", ["l1", "p1"])).toBeNull();
    expect(constraintFromSelection("fix", ["c1"])).toEqual(["c1"]);
    expect(constraintFromSelection("pointOnCurve", ["c1", "p1"])).toEqual(["p1", "c1"]);
    expect(constraintFromSelection("horizontal", ["l1", "l2"])).toBeNull();
    expect(constraintSpecs.perpendicular.resolve([{ id: "@axisU", kind: "axis" }, { id: "@axisV", kind: "axis" }])).toBeNull();
    expect(constraintSpecs.perpendicular.resolve([{ id: "l1", kind: "line" }, { id: "@axisV", kind: "axis" }])).toEqual(["l1", "@axisV"]);
  });
});

describe("select tool", () => {
  beforeEach(() => {
    editor.seed({ points: [["p1", 0, 0], ["p2", 40, 0], ["p3", 40, 30]], lines: [["l1", "p1", "p2"], ["l2", "p2", "p3"]] });
  });

  it("selects, adds with Shift, clears on empty space", async () => {
    await click(40, 30);
    expect(session.getState().selection).toEqual(["p3"]);
    await click(20, 0, true);
    expect(session.getState().selection).toEqual(["p3", "l1"]);
    await click(20, 0, true);
    expect(session.getState().selection).toEqual(["p3"]);
    await click(100, 100);
    expect(session.getState().selection).toEqual([]);
  });

  it("drags a point: the editor follows the pointer and one click-up ends it", async () => {
    const [x, y] = px(40, 30);
    session.pointerMove(x, y);
    await session.pointerDown(x, y);
    session.pointerMove(x + 2, y); // below the threshold
    expect(calls("beginDrag")).toHaveLength(0);
    session.pointerMove(x + 30, y - 20);
    expect(calls("beginDrag")[0]!.args).toEqual([["p3"]]);
    expect(editor.drags[0]!.moves.at(-1)).toEqual([43, 32]);
    await session.pointerUp(x + 30, y - 20);
    expect(editor.drags[0]!.ended).toBe(true);
  });

  it("dragging a line moves both end points, the first one follows the pointer's offset", async () => {
    const [x, y] = px(20, 0);
    session.pointerMove(x, y);
    await session.pointerDown(x, y);
    session.pointerMove(x, y - 50);
    expect(calls("beginDrag")[0]!.args).toEqual([["p1", "p2"]]);
    expect(editor.drags[0]!.moves.at(-1)).toEqual([0, 5]);
    await session.pointerUp(x, y - 50);
  });

  it("Esc during a drag restores the sketch", async () => {
    const [x, y] = px(40, 30);
    session.pointerMove(x, y);
    await session.pointerDown(x, y);
    session.pointerMove(x + 40, y);
    expect(session.escape()).toBe(true);
    expect(editor.drags[0]!.cancelled).toBe(true);
  });

  it("Delete removes the selection; a refusal opens the message", async () => {
    await click(40, 30);
    expect(key("Delete")).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls("remove")[0]!.args).toEqual([["p3"]]);
    editor.refuse = (name) => (name === "remove" ? rejected("sketch_conflicting") : undefined);
    await click(40, 0);
    key("Delete");
    await new Promise((r) => setTimeout(r, 0));
    expect(rejections[0]!.action.kind).toBe("delete");
  });

  it("keeps only selected ids that still exist after the sketch changed", async () => {
    await click(40, 30);
    editor.view.points = editor.view.points.filter((p) => p.id !== "p3");
    editor.view = { ...editor.view };
    editor.subscribe(() => undefined);
    await editor.addConstraint("fix", ["p1"]);
    expect(session.getState().selection).toEqual([]);
  });
});

describe("keys and the layer", () => {
  it("L, R, C and D pick the drawing tools and dimension", () => {
    const ids: [string, ToolId][] = [["l", "line"], ["R", "rectangle"], ["c", "circle"], ["d", "dimension"]];
    for (const [k, id] of ids) {
      expect(key(k)).toBe(true);
      expect(session.getState().tool).toBe(id);
    }
  });

  it("digits only open typing when a tool waits for its next point", () => {
    expect(key("5")).toBe(false);
    session.setTool("line");
    expect(key("5")).toBe(false);
  });

  it("hands the layer the sketch, the hover and the selection, and clears them on dispose", async () => {
    await click(0, 0);
    expect(layer.sketch).not.toBeNull();
    session.dispose();
    expect(layer.sketch).toBeNull();
    expect(layer.preview).toBeNull();
    expect(layer.selection).toEqual([]);
  });

  it("the second click on the running tool goes back to selecting", () => {
    session.toggleTool("line");
    expect(session.getState().tool).toBe("line");
    session.toggleTool("line");
    expect(session.getState().tool).toBe("select");
  });
});

describe("live value fields (shown from the first point on)", () => {
  const typed = () => session.getState().typed;
  const field = (id: string) => typed()!.fields.find((f) => f.id === id)!;

  it("there are no fields before the first point and none after the shape is finished", async () => {
    session.setTool("circle");
    expect(typed()).toBeNull();
    await click(10, 10);
    expect(typed()?.fields.map((f) => f.id)).toEqual(["diameter"]);
    await click(25, 10);
    expect(typed()).toBeNull();
  });

  it("circle: the diameter is there after the centre click and follows the pointer; nothing is locked", async () => {
    session.setTool("circle");
    await click(10, 10);
    expect(field("diameter")).toMatchObject({ live: 0, locked: false, text: "", kind: "length" });
    expect(typed()).toMatchObject({ typing: false, active: "diameter" });
    await move(25, 10);
    expect(field("diameter").live).toBeCloseTo(30, 9);
    expect(field("diameter").at).toEqual([25, 10]); // beside the right end of the circle
    await move(20, 10);
    expect(field("diameter").live).toBeCloseTo(20, 9);
  });

  it("line: length and angle follow the pointer; the angle sits at the start, the length at the middle", async () => {
    session.setTool("line");
    await click(5, 5);
    await move(5, 35); // straight up, 30 mm
    expect(field("length").live).toBeCloseTo(30, 9);
    expect(field("angle").live).toBeCloseTo(90, 9);
    expect(field("length").at).toEqual([5, 20]);
    expect(field("angle").at).toEqual([5, 5]);
    await move(-15, 5); // to the left, 20 mm
    expect(field("length").live).toBeCloseTo(20, 9);
    expect(field("angle").live).toBeCloseTo(180, 9);
  });

  it("rectangle: width at the horizontal edge, height at the vertical edge, both follow", async () => {
    session.setTool("rectangle");
    await click(10, 10);
    await move(70, 40);
    expect(field("width").live).toBeCloseTo(60, 9);
    expect(field("height").live).toBeCloseTo(30, 9);
    expect(field("width").at).toEqual([40, 10]);
    expect(field("height").at).toEqual([70, 25]);
    await move(-10, -20); // to the lower left
    expect(field("width").live).toBeCloseTo(20, 9);
    expect(field("height").live).toBeCloseTo(30, 9);
  });

  it("the layer gets the measuring graphics of every value; the active field is drawn active, a wrong text invalid, the rest quiet", async () => {
    session.setTool("rectangle");
    await click(10, 10);
    await move(70, 40);
    const tones = () => Object.fromEntries((layer.preview?.live ?? []).map((l) => [l.id, l.tone]));
    expect(layer.preview?.live?.map((l) => [l.id, l.dim.shape])).toEqual([
      ["width", "linear"],
      ["height", "linear"],
    ]);
    expect(tones()).toEqual({ width: "active", height: "quiet" });
    // Tab before typing only moves the selection: the height is now the active one.
    expect(key("Tab")).toBe(true);
    expect(tones()).toEqual({ width: "quiet", height: "active" });
    expect(key("4")).toBe(true);
    session.setTyped("height", "4x");
    expect(tones()).toEqual({ width: "quiet", height: "invalid" });
    session.setTyped("height", "40");
    expect(tones()).toEqual({ width: "quiet", height: "active" });
    // The graphics follow what the rubber band shows: the typed height moves the far edge.
    const height = layer.preview!.live!.find((l) => l.id === "height")!.dim;
    expect(height).toMatchObject({ shape: "linear", a: [70, 10], b: [70, 50] });
    session.escape();
    session.escape();
    expect(layer.preview?.live).toBeUndefined();
  });

  it("line and circle hand over an angle arc and a diameter", async () => {
    session.setTool("line");
    await click(5, 5);
    await move(5, 35);
    const live = layer.preview!.live!;
    expect(live.map((l) => [l.id, l.dim.shape, l.tone])).toEqual([
      ["length", "linear", "active"],
      ["angle", "angle", "quiet"],
    ]);
    const angle = live[1]!.dim;
    expect(angle.shape === "angle" && angle.sweep).toBeCloseTo(Math.PI / 2, 9);
    session.escape();
    session.setTool("circle");
    await click(10, 10);
    await move(25, 10);
    expect(layer.preview?.live?.[0]).toMatchObject({ id: "diameter", tone: "active", dim: { shape: "diameter", c: [10, 10], r: 15, dir: [1, 0] } });
  });

  it("a typed value locks that field; the others keep following the pointer", async () => {
    session.setTool("rectangle");
    await click(10, 10);
    await move(70, 40);
    expect(key("5")).toBe(true);
    session.setTyped("width", "50");
    expect(field("width")).toMatchObject({ locked: true, text: "50" });
    expect(field("height").locked).toBe(false);
    await move(70, 60);
    expect(field("height").live).toBeCloseTo(50, 9);
    expect(layer.preview?.lines?.[0]).toEqual({ a: [10, 10], b: [60, 10] });
    await move(70, 80);
    expect(field("height").live).toBeCloseTo(70, 9);
    // Clearing the field gives it back to the pointer.
    session.setTyped("width", "");
    expect(field("width").locked).toBe(false);
  });

  it("a digit overwrites the active field; Tab before typing moves the keyboard to the next field", async () => {
    session.setTool("line");
    await click(5, 5);
    await move(30, 5);
    expect(typed()?.active).toBe("length");
    expect(key("Tab")).toBe(true);
    expect(typed()).toMatchObject({ active: "angle", typing: false });
    expect(key("9")).toBe(true);
    expect(typed()).toMatchObject({ active: "angle", typing: true });
    expect(field("angle")).toMatchObject({ locked: true, text: "9" });
    expect(field("length").locked).toBe(false);
    // Tab while typing keeps going round.
    session.nextTyped();
    expect(typed()?.active).toBe("length");
  });

  it("Tab does nothing for a tool with one field or while nothing is drawn", async () => {
    session.setTool("circle");
    expect(key("Tab")).toBe(false);
    await click(10, 10);
    expect(key("Tab")).toBe(false);
  });

  it("with a typed length the untouched angle still reads the pointer", async () => {
    session.setTool("line");
    await click(0, 0);
    await move(30, 30);
    key("2");
    session.setTyped("length", "20");
    expect(field("angle").live).toBeCloseTo(45, 9);
    expect(field("length").locked).toBe(true);
    await move(0, 30);
    expect(field("angle").live).toBeCloseTo(90, 9);
  });

  it("an error stays on its field and the other field keeps its live value", async () => {
    session.setTool("rectangle");
    await click(0, 0);
    await move(40, 30);
    key("4");
    session.setTyped("width", "4x");
    expect(field("width").error?.error).toBe("unknownUnit");
    expect(field("height").error).toBeNull();
    expect(field("height").live).toBeCloseTo(30, 9);
  });

  it("Enter commits as one editor call and the fields are gone", async () => {
    session.setTool("circle");
    await click(10, 10);
    key("4");
    session.setTyped("diameter", "40");
    await session.commitTyped();
    expect(calls("addCircle")).toHaveLength(1);
    expect(typed()).toBeNull();
  });
});

describe("dimension tool: what is clicked is what is measured and the sector of an angle", () => {
  beforeEach(() => {
    editor.seed({
      points: [["p1", 0, 0], ["p2", 40, 0], ["p3", 40, 30], ["p4", 0, 30], ["p5", 20, 15], ["p6", 60, 15], ["p8", 0, 60], ["p9", 40, 60]],
      lines: [["l1", "p1", "p2"], ["l2", "p2", "p3"], ["l3", "p3", "p4"], ["l4", "p4", "p1"], ["l5", "p8", "p9"]],
      circles: [["c1", "p5", 4], ["c2", "p6", 3]],
    });
    layer.setSketch(editor.view, { highlight: "band", colour: "green", showConstraints: true, showDimensions: true });
    session.setTool("dimension");
  });
  const placed = () => calls("addDimension").at(-1)!.args.slice(0, 2);

  it("a circle's centre is a point: centre and line measure from the centre, perpendicular to the line", async () => {
    await click(20, 15); // the centre p5
    expect(session.getState().prompt).toBe("dimensionSecond");
    await click(25, 0); // the line l1
    expect(session.getState().prompt).toBe("dimensionPlace");
    await move(30, 7);
    expect(session.getState().ghost).toMatchObject({ dimKind: "distance", value: 15, refs: ["p5", "l1"] });
    await click(30, 7);
    expect(placed()).toEqual(["distance", ["p5", "l1"]]);
  });

  it("a circle's rim measures from the rim: rim and line, rim and rim, rim and a point", async () => {
    await click(24, 15); // the rim of c1
    expect(session.getState().prompt).toBe("dimensionCircle");
    await click(25, 0); // the line l1: the rim is 15 - 4 = 11 mm from it
    await move(30, 7);
    expect(session.getState().ghost).toMatchObject({ dimKind: "distance", value: 11, refs: ["c1", "l1"] });
    await click(30, 7);
    expect(placed()).toEqual(["distance", ["c1", "l1"]]);

    session.setTool("dimension");
    await click(24, 15);
    await click(57, 15); // the rim of c2: the centres are 40 apart
    await move(40, 22);
    expect(session.getState().ghost).toMatchObject({ dimKind: "distance", value: 33, refs: ["c1", "c2"] });
    await click(40, 22);
    expect(placed()).toEqual(["distance", ["c1", "c2"]]);

    session.setTool("dimension");
    await click(24, 15);
    await click(40, 30); // the point p3
    await move(30, 22);
    expect(session.getState().ghost).toMatchObject({ dimKind: "distance", refs: ["c1", "p3"] });
    expect(session.getState().ghost!.value).toBeCloseTo(Math.hypot(20, 15) - 4, 9);
  });

  it("a point and a line: the perpendicular distance; the end point of the same line is no partner", async () => {
    await click(40, 30); // p3, an end of l2 and l3
    await click(20, 0); // l1
    await move(30, 10);
    expect(session.getState().ghost).toMatchObject({ dimKind: "distance", value: 30, refs: ["p3", "l1"] });
    session.escape();
    session.setTool("dimension");
    await click(40, 30);
    await click(40, 15); // l2 ends at p3: not a partner, so this click is an empty click of a point: nothing happens
    expect(session.getState().prompt).toBe("dimensionSecond");
  });

  it("after a circle a click into empty space places the diameter, as before", async () => {
    await click(24, 15);
    await click(40, 45);
    expect(placed()).toEqual(["diameter", ["c1"]]);
  });

  it("after a line a click into empty space places the length; another line, a point or a circle picks the partner", async () => {
    await click(20, 0); // l1
    expect(session.getState().prompt).toBe("dimensionLine");
    await click(20, 40); // empty space
    expect(placed()).toEqual(["distance", ["l1"]]);
  });

  it("two parallel lines give their distance, not an angle", async () => {
    await click(20, 0); // l1
    await click(20, 60); // l5, parallel
    await move(30, 30);
    expect(session.getState().ghost).toMatchObject({ dimKind: "distance", value: 60 });
    expect(session.getState().ghost!.refs).toEqual(["l1", "l5"]);
  });

  it("two lines that cross give the angle of the sector the label is in: the corner is 90 inside, and outside too", async () => {
    await click(20, 0); // l1 runs p1 -> p2 (east)
    await click(0, 15); // l4 runs p4 -> p1 (south): its direction alone is 270 degrees from l1
    await move(5, 5); // inside the rectangle, the corner at p1
    expect(session.getState().ghost).toMatchObject({ dimKind: "angle", value: 90, refs: ["l1", "l4"], reverse: [false, true] });
    expect(layer.preview?.dimension).toMatchObject({ kind: "angle", refs: ["l1", "l4"], reverse: [false, true], label: [5, 5] });
    await move(-5, -5); // the opposite sector: west and south
    expect(session.getState().ghost).toMatchObject({ dimKind: "angle", value: 90, reverse: [true, false] });
    await click(-5, -5);
    expect(calls("addDimension").at(-1)!.args.slice(0, 2)).toEqual(["angle", ["l1", "l4"]]);
  });

  it("the picked things are drawn as a dimension while the label is placed: the preview carries its kind, references and position", async () => {
    await click(20, 0);
    await click(20, 60);
    await move(30, 30);
    expect(layer.preview?.dimension).toMatchObject({ kind: "distance", refs: ["l1", "l5"], label: [30, 30] });
  });

  it("two circles that cross have no distance: a notice, nothing is added", async () => {
    // c1 (centre 20,15, r 4) and a circle at p10 (24,15): they cross
    editor.seed({ points: [["p10", 24, 15]], circles: [["c3", "p10", 4]] });
    layer.setSketch(editor.view, { highlight: "band", colour: "green", showConstraints: true, showDimensions: true });
    await click(20, 19); // the top of c1 (not near c3's rim)
    await click(24, 11); // the bottom of c3
    await click(40, 40);
    expect(session.getState().notice).toBe("noDistance");
    expect(calls("addDimension")).toHaveLength(0);
    expect(session.getState().prompt).toBe("dimensionFirst");
  });
});

describe("what is still missing: highlighting", () => {
  it("an entry under the pointer lights up its elements next to the selection, and leaving it takes the light away", () => {
    editor.seed({ points: [["p1", 0, 0], ["p2", 40, 0]], lines: [["l1", "p1", "p2"]] });
    session.select(["p1"]);
    session.highlightFact(["l1"]);
    expect(layer.selection).toEqual(["p1", "l1"]);
    session.highlightFact(["l1"]); // the same again: nothing changes
    expect(layer.selection).toEqual(["p1", "l1"]);
    session.highlightFact(null);
    expect(layer.selection).toEqual(["p1"]);
  });
});
