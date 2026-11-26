// every user action in the sketch is exactly ONE undo step. Part 1 drives the tools against the fake editor, which
// counts undo steps the way the store does and records when an undo group opens and closes. Part 2 runs the same
// actions against the real editor and the real store, so the count is the store's own.
import { beforeEach, describe, expect, it } from "vitest";
import { DocumentStore } from "../../../app/src/document/store.ts";
import type { SketchData } from "../../../app/src/document/types.ts";
import { sketchFeature } from "../../../app/src/model/doc-edit.ts";
import { SketchEditorImpl } from "../../../app/src/model/sketch-editor.ts";
import { SketchHistory } from "../../../app/src/screens/sketch/history.ts";
import { SketchSession, type RejectChoice, type Rejection } from "../../../app/src/screens/sketch/session.ts";
import { document } from "../../fixtures/engine/cases.ts";
import { solveLink, type SolveLinkOptions } from "../model/solve-link.ts";
import { FakeEditor, FakeLayer, px } from "./fakes.ts";
import type { EditOutcome, SketchEditor } from "../../../app/src/model/index.ts";

const rejected = (): EditOutcome => ({
  ok: false,
  reason: "rejected",
  problem: { code: "sketch_conflicting", message: "The sketch was not solved." },
  conflicting: ["k9"],
  redundant: [],
});

const OPTIONS = { highlight: "band", colour: "green", showConstraints: true, showDimensions: true } as const;

interface Rig {
  session: SketchSession;
  editor: SketchEditor;
  rejections: Rejection[];
  choice: { value: RejectChoice };
  click(u: number, v: number): Promise<void>;
  move(u: number, v: number): void;
  names(): string[];
}

function rig(editor: SketchEditor, layerView: { readonly view: ReturnType<SketchEditor["getView"]> }, calls?: () => string[]): Rig {
  const layer = new FakeLayer(layerView);
  const rejections: Rejection[] = [];
  const choice = { value: "cancel" as RejectChoice };
  const session = new SketchSession({
    editor,
    layer,
    options: OPTIONS,
    reject: (r) => {
      rejections.push(r);
      return Promise.resolve(choice.value);
    },
    decimalComma: false,
  });
  return {
    session,
    editor,
    rejections,
    choice,
    async click(u, v) {
      const [x, y] = px(u, v);
      session.pointerMove(x, y);
      await session.pointerDown(x, y);
      await session.pointerUp(x, y);
    },
    move(u, v) {
      const [x, y] = px(u, v);
      session.pointerMove(x, y);
    },
    names: calls ?? (() => []),
  };
}

// ------------------------------------------------------------------------------------------------ part 1: fake editor

describe("tools and undo steps (fake editor)", () => {
  let fake: FakeEditor;
  let r: Rig;
  const order = () => fake.calls.map((c) => c.name).filter((n) => ["beginGroup", "closeGroup", "addRectangle", "addDimension", "setDimension", "setDriving"].includes(n));

  beforeEach(() => {
    fake = new FakeEditor();
    fake.seed({ points: [["p1", 0, 0], ["p2", 40, 0], ["p3", 40, 30]], lines: [["l1", "p1", "p2"], ["l2", "p2", "p3"]], circles: [["c1", "p1", 5]] });
    r = rig(fake, fake);
  });

  /** Dimension tool: pick the line l1, place the label above it; the value box is open afterwards. */
  async function placeDimension(): Promise<void> {
    r.session.setTool("dimension");
    await r.click(20, 0);
    await r.click(20, 8);
  }

  describe("a new dimension: placing, typing and Enter are one step", () => {
    it("with a typed value: the group opens before the placing and closes after Enter; one step", async () => {
      await placeDimension();
      expect(fake.grouping).toBe(true); // open while the value box is
      expect(fake.undoSteps).toBe(1); // the placing is the step
      r.session.setDimText("55");
      await r.session.commitDimEdit();
      expect(order()).toEqual(["beginGroup", "addDimension", "setDimension", "closeGroup"]);
      expect(fake.grouping).toBe(false);
      expect(fake.undoSteps).toBe(1);
    });

    it("Enter without a changed value: one step, group closed", async () => {
      await placeDimension();
      await r.session.commitDimEdit();
      expect(fake.undoSteps).toBe(1);
      expect(fake.grouping).toBe(false);
    });

    it("Esc keeps the dimension with its measured value as the one step, and closes the group", async () => {
      await placeDimension();
      r.session.setDimText("99");
      r.session.escape();
      expect(fake.undoSteps).toBe(1);
      expect(fake.grouping).toBe(false);
      expect(fake.calls.filter((c) => c.name === "setDimension")).toHaveLength(0);
      expect(fake.view.dimensions).toHaveLength(1);
    });

    it("a click elsewhere, another tool, and dispose all close the group", async () => {
      await placeDimension();
      await r.click(100, 100);
      expect(fake.grouping).toBe(false);
      expect(fake.undoSteps).toBe(1);

      fake.seed({});
      await placeDimension();
      expect(fake.grouping).toBe(true);
      r.session.setTool("line");
      expect(fake.grouping).toBe(false);

      r.session.setTool("dimension");
      await r.click(20, 0);
      await r.click(20, 8);
      expect(fake.grouping).toBe(true);
      r.session.dispose();
      expect(fake.grouping).toBe(false);
    });

    it("a typed value the engine refuses: Abbrechen keeps the placed (measured) dimension, still one step", async () => {
      await placeDimension();
      r.session.setDimText("70");
      fake.refuse = (name) => (name === "setDimension" ? rejected() : undefined);
      r.choice.value = "cancel";
      await r.session.commitDimEdit();
      expect(r.rejections).toHaveLength(1);
      expect(fake.undoSteps).toBe(1);
      expect(fake.grouping).toBe(false);
      expect(fake.view.dimensions).toHaveLength(1);
      expect(fake.view.dimensions[0]!.driving).toBe(true);
    });

    it("a typed value the engine refuses: \"Als Referenzmaß anlegen\" makes the placed dimension a reference, still one step", async () => {
      await placeDimension();
      r.session.setDimText("70");
      fake.refuse = (name) => (name === "setDimension" ? rejected() : undefined);
      r.choice.value = "reference";
      await r.session.commitDimEdit();
      expect(order()).toEqual(["beginGroup", "addDimension", "setDimension", "setDriving", "closeGroup"]);
      expect(fake.undoSteps).toBe(1);
      expect(fake.grouping).toBe(false);
    });

    it("a placing the sketch already fixes is a reference dimension at once: ONE step, no box, no dialog, no group left", async () => {
      fake.refuse = (name, args) => (name === "addDimension" && (args[4] as { driving?: boolean } | undefined)?.driving !== false ? rejected() : undefined);
      await placeDimension();
      expect(r.rejections).toHaveLength(0);
      expect(r.session.getState().dimEdit).toBeNull();
      expect(fake.undoSteps).toBe(1); // the reference dimension, the refused try made none
      expect(fake.grouping).toBe(false);
      expect(fake.view.dimensions).toHaveLength(1);
      expect(fake.view.dimensions[0]!.driving).toBe(false);
      expect(order()).toEqual(["beginGroup", "addDimension", "addDimension", "closeGroup"]);
    });

    it("editing an existing dimension by double-click is one step and needs no group", async () => {
      await placeDimension();
      await r.session.commitDimEdit(); // finish the first one
      const id = fake.view.dimensions[0]!.id;
      const before = fake.undoSteps;
      r.session.editDimension(id);
      r.session.setDimText("66");
      await r.session.commitDimEdit();
      expect(fake.undoSteps).toBe(before + 1);
      expect(fake.calls.filter((c) => c.name === "beginGroup")).toHaveLength(1); // only the placing
    });
  });

  describe("a rectangle with typed sizes is one step", () => {
    async function typedRectangle(): Promise<void> {
      r.session.setTool("rectangle");
      await r.click(10, 10);
      r.move(-5, 0);
      r.session.key({ key: "6", ctrl: false, alt: false, meta: false, shift: false });
      r.session.setTyped("width", "60");
      r.session.nextTyped();
      r.session.setTyped("height", "30");
      await r.session.commitTyped();
    }

    it("the rectangle and both dimensions share one step", async () => {
      await typedRectangle();
      expect(order()).toEqual(["beginGroup", "addRectangle", "addDimension", "addDimension", "closeGroup"]);
      expect(fake.undoSteps).toBe(1);
      expect(fake.grouping).toBe(false);
      expect(r.session.getState().tool).toBe("select");
    });

    it("a refused second dimension keeps the rectangle and the first dimension in the same one step", async () => {
      let n = 0;
      fake.refuse = (name) => (name === "addDimension" && ++n === 2 ? rejected() : undefined);
      await typedRectangle();
      expect(r.rejections).toHaveLength(1);
      expect(fake.undoSteps).toBe(1);
      expect(fake.view.dimensions).toHaveLength(1);
      expect(fake.grouping).toBe(false);
    });

    it("a refused rectangle makes no step, closes the group and does not go on to the dimensions", async () => {
      fake.refuse = (name) => (name === "addRectangle" ? rejected() : undefined);
      await typedRectangle();
      expect(fake.undoSteps).toBe(0);
      expect(fake.calls.filter((c) => c.name === "addDimension")).toHaveLength(0);
      expect(fake.grouping).toBe(false);
      expect(r.session.getState().tool).toBe("rectangle");
    });

    it("a plain rectangle is one step too", async () => {
      r.session.setTool("rectangle");
      await r.click(50, 50);
      await r.click(70, 70);
      expect(fake.undoSteps).toBe(1);
    });
  });

  describe("every other action is one step", () => {
    it("line with typed length and angle, circle, constraint tool, constraint from the selection, delete, drag", async () => {
      let expected = 0;
      const step = () => {
        expected += 1;
        expect(fake.undoSteps).toBe(expected);
        expect(fake.grouping).toBe(false);
      };

      r.session.setTool("line");
      await r.click(60, 0);
      r.move(80, 0);
      r.session.key({ key: "2", ctrl: false, alt: false, meta: false, shift: false });
      r.session.setTyped("length", "20");
      r.session.nextTyped();
      r.session.setTyped("angle", "30");
      await r.session.commitTyped();
      step();

      r.session.setTool("circle");
      await r.click(100, 100);
      r.session.key({ key: "4", ctrl: false, alt: false, meta: false, shift: false });
      r.session.setTyped("diameter", "40");
      await r.session.commitTyped();
      step();

      r.session.setTool("horizontal");
      await r.click(20, 0);
      step();

      r.session.setTool("select");
      await r.click(40, 15);
      r.session.setTool("vertical"); // applies to the selection at once
      await new Promise((resolve) => setTimeout(resolve, 0));
      step();

      const [x, y] = px(40, 30);
      r.session.pointerMove(x, y);
      await r.session.pointerDown(x, y);
      r.session.pointerMove(x + 30, y - 20);
      await r.session.pointerUp(x + 30, y - 20);
      step();

      await r.click(40, 30);
      r.session.key({ key: "Delete", ctrl: false, alt: false, meta: false, shift: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
      step();
    });
  });
});

// ------------------------------------------------------------------------------------------------ part 2: real editor

describe("tools and undo steps (real editor and store)", () => {
  const sketchOf = (store: DocumentStore): SketchData => sketchFeature(store.getSnapshot(), "f1")!.sketch;

  async function open(options: SolveLinkOptions = {}) {
    const store = new DocumentStore(document({ points: [], lines: [], circles: [], constraints: [] }));
    const editor = await SketchEditorImpl.open({ link: solveLink(options), store }, "f1", () => undefined);
    const r = rig(editor, { get view() { return editor.getView(); } });
    const history = new SketchHistory(store);
    return { store, editor, r, history };
  }

  /** A 60 x 40 rectangle with its corner on the origin, drawn without typed sizes (one step), then the undo state is reset. */
  async function withRectangle() {
    const ctx = await open();
    ctx.r.session.setTool("rectangle");
    await ctx.r.click(0, 0);
    await ctx.r.click(60, 40);
    return ctx;
  }

  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("a new dimension with a typed value: ONE undo takes the dimension and the value, ONE redo brings both back", async () => {
    const { store, r, history } = await withRectangle();
    expect(history.getState().canUndo).toBe(true); // the rectangle
    r.session.setTool("dimension");
    await r.click(30, 0); // the bottom edge
    await r.click(30, -8);
    expect(r.session.getState().dimEdit).not.toBeNull();
    r.session.setDimText("55");
    await r.session.commitDimEdit();
    const dims = sketchOf(store).constraints.filter((c) => "driving" in c);
    expect(dims).toHaveLength(1);
    expect(dims[0]).toMatchObject({ value: { value: 55, unit: "mm" } });

    expect(history.undo()).toBe(true); // the dimension, with its value
    expect(sketchOf(store).constraints.filter((c) => "driving" in c)).toHaveLength(0);
    expect(sketchOf(store).lines).toHaveLength(4); // the rectangle is a step of its own
    expect(history.redo()).toBe(true);
    expect(sketchOf(store).constraints.filter((c) => "driving" in c)[0]).toMatchObject({ value: { value: 55, unit: "mm" } });
    expect(history.undo()).toBe(true);
    expect(history.undo()).toBe(true); // the rectangle
    expect(history.undo()).toBe(false); // the start of the sketch
    expect(sketchOf(store).lines).toHaveLength(0);
  });

  it("a rectangle with typed width and height: ONE undo removes the lot, ONE redo restores it with its three sketch steps", async () => {
    const { store, r, history } = await open();
    r.session.setTool("rectangle");
    await r.click(0, 0);
    r.move(30, 20);
    r.session.key({ key: "6", ctrl: false, alt: false, meta: false, shift: false });
    r.session.setTyped("width", "60");
    r.session.nextTyped();
    r.session.setTyped("height", "40");
    await r.session.commitTyped();
    const done = sketchOf(store);
    expect(done.lines).toHaveLength(4);
    expect(done.steps!.map((s) => s.kind)).toEqual(["rectangle", "dimension", "dimension"]);

    expect(history.undo()).toBe(true);
    await flush();
    expect(sketchOf(store).lines).toHaveLength(0);
    expect(sketchOf(store).constraints).toHaveLength(0);
    expect(history.getState()).toEqual({ canUndo: false, canRedo: true });
    expect(history.redo()).toBe(true);
    expect(sketchOf(store)).toEqual(done);
  });

  it("Esc on a new dimension's box: the dimension stays with its measured value, as one step", async () => {
    const { store, r, history } = await withRectangle();
    r.session.setTool("dimension");
    await r.click(30, 0);
    await r.click(30, -8);
    r.session.setDimText("99");
    r.session.escape();
    expect(sketchOf(store).constraints.filter((c) => "driving" in c)).toHaveLength(1);
    expect(sketchOf(store).constraints.filter((c) => "driving" in c)[0]).toMatchObject({ value: { value: 60 } });
    expect(history.undo()).toBe(true);
    expect(sketchOf(store).constraints.filter((c) => "driving" in c)).toHaveLength(0);
  });

  it("a refused typed value and Abbrechen: the measured dimension stays as the one step; Referenzmaß: one step as well", async () => {
    const { store, r, history } = await open({ refuse: (s) => (s.constraints.some((c) => "driving" in c && c.driving && c.value.value === 999) ? "conflicting" : null) });
    r.session.setTool("rectangle");
    await r.click(0, 0);
    await r.click(60, 40);

    r.session.setTool("dimension");
    await r.click(30, 0);
    await r.click(30, -8);
    r.session.setDimText("999");
    r.choice.value = "cancel";
    await r.session.commitDimEdit();
    expect(r.rejections).toHaveLength(1);
    const dims = () => sketchOf(store).constraints.filter((c) => "driving" in c);
    expect(dims()).toHaveLength(1);
    expect(dims()[0]).toMatchObject({ driving: true, value: { value: 60 } }); // measured value, nothing half-made
    expect(history.undo()).toBe(true);
    expect(dims()).toHaveLength(0);

    // The same with "Als Referenzmaß anlegen": the placed dimension becomes a reference dimension, one step.
    await r.click(30, 0);
    await r.click(30, -8);
    r.session.setDimText("999");
    r.choice.value = "reference";
    await r.session.commitDimEdit();
    expect(dims()).toHaveLength(1);
    expect(dims()[0]).toMatchObject({ driving: false });
    expect(history.undo()).toBe(true);
    expect(dims()).toHaveLength(0);
    expect(sketchOf(store).lines).toHaveLength(4);
  });

  it("undo while the value box is open ends the group; the next edit is a step of its own", async () => {
    const { store, r, history } = await withRectangle();
    r.session.setTool("dimension");
    await r.click(30, 0);
    await r.click(30, -8);
    expect(store.grouping).toBe(true);
    expect(history.undo()).toBe(true); // the placed dimension goes
    r.session.resetTool();
    expect(store.grouping).toBe(false);
    expect(sketchOf(store).constraints.filter((c) => "driving" in c)).toHaveLength(0);
    expect(sketchOf(store).lines).toHaveLength(4);
  });
});
