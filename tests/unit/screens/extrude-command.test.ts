// The extrude command as a state machine, driven against a made-up model: how it starts, which values it sends to the editor
// (and which it does not), what OK and Cancel do, what the dialog shows for a refused preview or a crashed engine, and that an
// area that vanished from the sketch is never guessed.
import { describe, expect, it } from "vitest";
import type { Problem } from "../../../app/src/engine/generated/protocol.ts";
import type { EditOutcome, ExtrudeEditor, ExtrudeParams, ExtrudeView, ProfileView } from "../../../app/src/model/index.ts";
import { ExtrudeCommand, type CommittedStep, type ExtrudeModelApi } from "../../../app/src/screens/main/extrude-command.ts";

const area = (key: string): ProfileView => ({
  key,
  outer: [],
  holes: [],
  area: 1,
  determined: true,
  loopsDetermined: [true],
  fill: { positions: new Float32Array(), indices: new Uint32Array() },
  loops: [],
});

class FakeEditor implements ExtrudeEditor {
  readonly featureId: string;
  view: ExtrudeView;
  sets: Partial<ExtrudeParams>[] = [];
  cancelled = false;
  commitResult: Promise<EditOutcome> = Promise.resolve({ ok: true });
  private readonly listeners = new Set<() => void>();
  constructor(id: string, sketch: string, params: ExtrudeParams, profiles: ProfileView[] | null = null) {
    this.featureId = id;
    this.view = { featureId: id, name: `Extrusion${id}`, bodyId: `b${id}`, sketch, frame: null, params, profiles, step: null, pending: false };
  }
  getView = (): ExtrudeView => this.view;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  set(patch: Partial<ExtrudeParams>): void {
    this.sets.push(patch);
    this.view = { ...this.view, params: { ...this.view.params, ...patch } };
    this.emit();
  }
  commit(): Promise<EditOutcome> {
    return this.commitResult;
  }
  cancel(): void {
    this.cancelled = true;
  }
  /** A change the engine reports (an answer, an error). */
  report(patch: Partial<ExtrudeView>): void {
    this.view = { ...this.view, ...patch };
    this.emit();
  }
  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}

function setup(options: { decimalComma?: boolean } = {}) {
  const editors: FakeEditor[] = [];
  const inits: unknown[] = [];
  let n = 0;
  const model: ExtrudeModelApi = {
    startExtrude(init) {
      inits.push(init);
      const e = new FakeEditor(String(++n), init.sketch, {
        region: init.region ?? null,
        extent: init.extent ?? "oneSide",
        distance: init.distance ?? { value: 10, unit: "mm" },
      });
      editors.push(e);
      return e;
    },
    editExtrude(id) {
      const e = new FakeEditor(id, "f1", { region: "r1", extent: "symmetric", distance: { value: 7.5, unit: "mm" } }, [area("r1"), area("r2")]);
      editors.push(e);
      return e;
    },
  };
  const committed: CommittedStep[] = [];
  const command = new ExtrudeCommand(model, { decimalComma: options.decimalComma ?? false, onCommitted: (s) => committed.push(s) });
  return { command, editors, inits, committed };
}

const problem = (code: Problem["code"] = "result_invalid"): Problem => ({ code, message: "The result is not a valid solid." });
const ref = (regionId: string, sketchId = "f1") => ({ sketchId, regionId });

describe("starting", () => {
  it("asks for an area first, and the dialog opens when one is picked", () => {
    const { command, editors, inits } = setup();
    expect(command.getState().phase).toBe("idle");
    command.begin(null);
    expect(command.getState()).toMatchObject({ phase: "pick", profile: null });
    expect(editors).toHaveLength(0);
    command.pick(ref("r1"));
    expect(command.getState()).toMatchObject({ phase: "dialog", mode: "create", profile: ref("r1"), sketchId: "f1" });
    expect(inits[0]).toMatchObject({ sketch: "f1", region: "r1", extent: "oneSide", distance: { value: 10, unit: "mm" } });
    expect(command.getState().form.text).toBe("10");
  });

  it("opens the dialog at once with an area chosen beforehand", () => {
    const { command } = setup();
    command.begin(ref("r2"));
    expect(command.getState()).toMatchObject({ phase: "dialog", profile: ref("r2") });
  });

  it("ignores a second begin while it runs", () => {
    const { command, editors } = setup();
    command.begin(ref("r1"));
    command.begin(ref("r2"));
    expect(editors).toHaveLength(1);
    expect(command.getState().profile).toEqual(ref("r1"));
  });

  it("writes the default distance with the decimal comma in German", () => {
    const { command } = setup({ decimalComma: true });
    command.begin(null);
    expect(command.getState().form.text).toBe("10");
  });

  it("edit opens an existing step with its values (symmetric 7.5 mm), and an existing step keeps its sketch", () => {
    const { command, editors } = setup({ decimalComma: true });
    command.edit("f7");
    expect(command.getState()).toMatchObject({ phase: "dialog", mode: "edit", featureId: "f7", sketchId: "f1", profile: ref("r1") });
    expect(command.getState().form).toEqual({ text: "7,5", reversed: false, extent: "symmetric" });
    command.pick(ref("x", "f2")); // another sketch: not for an existing step
    expect(editors).toHaveLength(1);
    expect(command.getState().profile).toEqual(ref("r1"));
  });
});

describe("the form goes to the editor", () => {
  it("sends every valid value (latest wins in the model) and none that is not valid", () => {
    const { command, editors } = setup();
    command.begin(ref("r1"));
    const editor = editors[0]!;
    command.setText("1");
    command.setText("12");
    command.setText("12,"); // a comma and no decimals yet still reads as 12
    command.setText("12,5");
    command.setText("abc");
    command.setText("");
    expect(editor.sets.map((s) => s.distance?.value)).toEqual([1, 12, 12, 12.5]);
    expect(command.getState().distance).toMatchObject({ ok: false, error: "empty" });
    // The preview keeps the last valid value while the text is wrong.
    expect(editor.view.params.distance.value).toBe(12.5);
  });

  it("flip sends the negative distance, and a typed value keeps the direction", () => {
    const { command, editors } = setup();
    command.begin(ref("r1"));
    const editor = editors[0]!;
    command.flip();
    expect(editor.view.params.distance.value).toBe(-10);
    command.setText("4");
    expect(editor.view.params.distance.value).toBe(-4);
    command.flip();
    expect(editor.view.params.distance.value).toBe(4);
  });

  it("symmetric is the total thickness: positive, the flip is off, and one side restores the direction", () => {
    const { command, editors } = setup();
    command.begin(ref("r1"));
    const editor = editors[0]!;
    command.flip();
    command.setExtent("symmetric");
    expect(editor.view.params).toMatchObject({ extent: "symmetric", distance: { value: 10 } });
    command.flip(); // no direction here
    expect(command.getState().form.reversed).toBe(true);
    expect(editor.view.params.distance.value).toBe(10);
    command.setExtent("oneSide");
    expect(editor.view.params).toMatchObject({ extent: "oneSide", distance: { value: -10 } });
  });

  it("an extent change goes to the editor even while the distance text is wrong", () => {
    const { command, editors } = setup();
    command.begin(ref("r1"));
    command.setText("x");
    command.setExtent("symmetric");
    expect(editors[0]!.view.params.extent).toBe("symmetric");
  });

  it("the arrow in the view sets the form: sign is the direction, length the distance", () => {
    const { command, editors } = setup();
    command.begin(ref("r1"));
    command.dragHandle(-15.5);
    expect(command.getState().form).toMatchObject({ text: "15.5", reversed: true });
    expect(editors[0]!.view.params.distance.value).toBe(-15.5);
  });

  it("picking another area of the same sketch changes only the area; one of another sketch starts a new editor with the typed values", () => {
    const { command, editors, inits } = setup();
    command.begin(ref("r1"));
    command.setText("6");
    command.flip();
    command.pick(ref("r2"));
    expect(editors).toHaveLength(1);
    expect(editors[0]!.view.params.region).toBe("r2");
    command.pick(ref("q1", "f5"));
    expect(editors).toHaveLength(2);
    expect(editors[0]!.cancelled).toBe(true);
    expect(inits[1]).toMatchObject({ sketch: "f5", region: "q1", distance: { value: -6, unit: "mm" } });
    expect(command.getState().profile).toEqual(ref("q1", "f5"));
  });
});

describe("OK and Cancel", () => {
  it("OK commits through the editor, ends the command and reports the new step", async () => {
    const { command, editors, committed } = setup();
    command.begin(ref("r1"));
    const outcome = await command.confirm();
    expect(outcome).toEqual({ ok: true });
    expect(command.getState().phase).toBe("idle");
    expect(committed).toEqual([{ featureId: "1", bodyId: "b1", mode: "create" }]);
    expect(editors[0]!.cancelled).toBe(false); // the editor closed itself by committing
  });

  it("OK does nothing while the distance is wrong or no area is chosen", async () => {
    const { command, committed } = setup();
    command.begin(null);
    expect(await command.confirm()).toBeNull();
    command.pick(ref("r1"));
    command.setText("0");
    expect(await command.confirm()).toBeNull();
    expect(command.getState().phase).toBe("dialog");
    expect(committed).toEqual([]);
  });

  it("a refused OK keeps the dialog, shows the engine's reason and clears it when a value changes", async () => {
    const { command, editors, committed } = setup();
    command.begin(ref("r1"));
    editors[0]!.commitResult = Promise.resolve({ ok: false, reason: "rejected", problem: problem(), conflicting: [], redundant: [] });
    const outcome = await command.confirm();
    expect(outcome).toMatchObject({ ok: false, reason: "rejected" });
    expect(command.getState()).toMatchObject({ phase: "dialog", confirming: false, failure: { kind: "rejected" } });
    expect(committed).toEqual([]);
    command.setText("5");
    expect(command.getState().failure).toBeNull();
  });

  it("an engine that did not answer is shown as such and the values are kept", async () => {
    const { command, editors } = setup();
    command.begin(ref("r1"));
    command.setText("33");
    editors[0]!.commitResult = Promise.resolve({ ok: false, reason: "engine", error: new Error("The engine crashed") });
    await command.confirm();
    expect(command.getState()).toMatchObject({ phase: "dialog", failure: { kind: "engine" } });
    expect(command.getState().form.text).toBe("33");
  });

  it("Cancel closes the editor without a commit", () => {
    const { command, editors, committed } = setup();
    command.begin(ref("r1"));
    command.cancel();
    expect(command.getState().phase).toBe("idle");
    expect(editors[0]!.cancelled).toBe(true);
    expect(committed).toEqual([]);
  });

  it("Cancel while asking for an area ends the command, and a cancel while OK waits wins", async () => {
    const { command, editors } = setup();
    command.begin(null);
    command.cancel();
    expect(command.getState().phase).toBe("idle");
    command.begin(ref("r1"));
    let release: (o: EditOutcome) => void = () => undefined;
    editors[0]!.commitResult = new Promise<EditOutcome>((r) => (release = r));
    const pending = command.confirm();
    expect(command.getState().confirming).toBe(true);
    command.cancel();
    release({ ok: true });
    await pending;
    expect(command.getState().phase).toBe("idle");
  });

  it("the next extrusion starts with the default values, not the last ones", async () => {
    const { command } = setup();
    command.begin(ref("r1"));
    command.setText("99");
    await command.confirm();
    command.begin(null);
    expect(command.getState().form).toEqual({ text: "10", reversed: false, extent: "oneSide" });
  });

  it("a command that is disposed while it runs is cancelled", () => {
    const { command, editors } = setup();
    command.begin(ref("r1"));
    command.dispose();
    expect(editors[0]!.cancelled).toBe(true);
    expect(command.getState().phase).toBe("idle");
  });
});

describe("what the engine reports", () => {
  it("a refused preview is shown once the answer is in, and not for an answer to an older value", () => {
    const { command, editors } = setup();
    command.begin(ref("r1"));
    const editor = editors[0]!;
    editor.report({ pending: true, step: { featureId: "1", state: "error", cached: false, ms: 1, problem: problem() } });
    expect(command.getState()).toMatchObject({ pending: true, failure: null });
    editor.report({ pending: false });
    expect(command.getState().failure).toMatchObject({ kind: "preview", problem: { code: "result_invalid" } });
    editor.report({ step: { featureId: "1", state: "ok", cached: false, ms: 1 } });
    expect(command.getState().failure).toBeNull();
  });

  it("an engine error shows the notice; when the engine is ready again the preview is asked for once more", () => {
    const { command, editors } = setup();
    command.begin(ref("r1"));
    const editor = editors[0]!;
    editor.report({ error: new Error("The engine crashed") });
    expect(command.getState().failure).toMatchObject({ kind: "engine" });
    editor.sets = [];
    command.engineReady();
    expect(editor.sets).toEqual([{}]);
  });

  it("an area that is not in the sketch any more is dropped, never guessed: the user picks again", () => {
    const { command, editors } = setup();
    command.edit("f7");
    const editor = editors[0]!;
    editor.report({ profiles: [area("other1"), area("other2")] });
    expect(command.getState()).toMatchObject({ profile: null, profileGone: true });
    expect(editor.view.params.region).toBeNull();
    command.pick(ref("other2"));
    expect(command.getState()).toMatchObject({ profile: ref("other2"), profileGone: false });
    expect(editor.view.params.region).toBe("other2");
  });

  it("while the areas are still loading the chosen one stays", () => {
    const { command, editors } = setup();
    command.begin(ref("r1"));
    editors[0]!.report({ profiles: null });
    expect(command.getState().profile).toEqual(ref("r1"));
  });
});
