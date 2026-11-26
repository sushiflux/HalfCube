// The extrude command as a small state machine, independent of React and of the 3D view (so it can be tested with a made-up
// model):
//
//   idle --begin--> pick (asks for an area; the view highlights areas under the pointer) --pick--> dialog
//   idle --begin with a chosen area--------------------------------------------------------------> dialog
//   idle --edit(step)----------------------------------------------------------------------------> dialog (an existing step)
//   dialog --confirm (OK)--> idle, ONE undo step     dialog --cancel--> idle, nothing changed
//
// The dialog's values go to the model layer's ExtrudeEditor, which previews them through the engine (latest value wins) and
// commits them as one undo step. This class adds what the dialog needs around it: the form (field text, direction, extent), live
// validation of the typed value, the failure to show (a refused preview, a refused OK, an engine that did not answer) and the
// area that is picked.
import type { Problem } from "../../engine/generated/protocol.ts";
import type { QuantityParse } from "../../document/quantity.ts";
import type { EditOutcome, ExtrudeEditor, ExtrudeExtent, ExtrudeParams, ExtrudeView } from "../../model/index.ts";
import { checkDistance, distanceText, formFromHandle, formFromParams, signedDistance, type ExtrudeForm } from "./extrude-form.ts";
import { sameProfile, type ProfileRef } from "./profile-catalogue.ts";

export interface ExtrudeModelApi {
  startExtrude(init: { sketch: string; region?: string; extent?: ExtrudeExtent; distance?: ExtrudeParams["distance"] }): ExtrudeEditor;
  editExtrude(featureId: string): ExtrudeEditor;
}

/** Why the dialog shows a message instead of (or next to) the preview. */
export type CommandFailure =
  /** The engine computed the preview and the step failed (no closed area, kernel refused, invalid result ...). */
  | { kind: "preview"; problem: Problem }
  /** OK was pressed and the engine refused the step; nothing was committed. */
  | { kind: "rejected"; problem: Problem }
  /** The engine did not answer (crash, restart, time limit). The values are kept and the preview is asked again. */
  | { kind: "engine"; error: Error }
  /** The command itself cannot do this (a programming error of the caller). */
  | { kind: "invalid"; message: string };

export interface ExtrudeState {
  phase: "idle" | "pick" | "dialog";
  /** A new step or an existing one being edited. */
  mode: "create" | "edit";
  featureId: string | null;
  /** The step's name ("Extrusion1"), for the timeline's draft step and the status line. */
  name: string | null;
  bodyId: string | null;
  /** The sketch the editor works on (null before an area is picked). */
  sketchId: string | null;
  /** The area being extruded (null while the user has to pick one). */
  profile: ProfileRef | null;
  form: ExtrudeForm;
  /** The field text read as a length: the field is red and says why while it is not ok. */
  distance: QuantityParse;
  /** A preview is being computed. */
  pending: boolean;
  /** OK was pressed and the answer has not come yet. */
  confirming: boolean;
  failure: CommandFailure | null;
  /** The area of the step is gone from its sketch (the sketch changed since): the user has to pick it again. */
  profileGone: boolean;
}

export interface CommittedStep {
  featureId: string;
  bodyId: string;
  mode: "create" | "edit";
}

export interface ExtrudeCommandOptions {
  /** The decimal comma of the language: the field's text is written with it. */
  decimalComma: boolean;
  /** The extrusion was committed (one undo step). */
  onCommitted?: (step: CommittedStep) => void;
}

const DEFAULT_MM = 10;

function sameFailure(a: CommandFailure | null, b: CommandFailure | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "preview":
    case "rejected":
      return a.problem === (b as typeof a).problem;
    case "engine":
      return a.error === (b as typeof a).error;
    case "invalid":
      return a.message === (b as typeof a).message;
  }
}

const idle = (form: ExtrudeForm): ExtrudeState => ({
  phase: "idle",
  mode: "create",
  featureId: null,
  name: null,
  bodyId: null,
  sketchId: null,
  profile: null,
  form,
  distance: checkDistance(form.text),
  pending: false,
  confirming: false,
  failure: null,
  profileGone: false,
});

export class ExtrudeCommand {
  private state: ExtrudeState;
  private editor: ExtrudeEditor | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly model: ExtrudeModelApi;
  private options: ExtrudeCommandOptions;
  /** The failure of the last OK, kept until the user changes something. */
  private refused: CommandFailure | null = null;
  private refreshing = false;
  private again = false;

  constructor(model: ExtrudeModelApi, options: ExtrudeCommandOptions) {
    this.model = model;
    this.options = options;
    this.state = idle(this.defaultForm());
  }

  /** Replaces the options (the language changed, or the owner of the command has a new handler). */
  configure(options: ExtrudeCommandOptions): void {
    this.options = options;
  }

  getState = (): ExtrudeState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The command is running (it asks for an area, or its dialog is open). */
  get active(): boolean {
    return this.state.phase !== "idle";
  }

  // ------------------------------------------------------------------------------------------------ start and end

  /** Starts a new extrusion: with an area chosen beforehand the dialog opens at once, otherwise the command asks for one. */
  begin(preselected: ProfileRef | null): void {
    if (this.state.phase !== "idle") return;
    this.refused = null;
    const form = this.defaultForm();
    this.set({ ...idle(form), phase: "pick" });
    if (preselected) this.pick(preselected);
  }

  /** Opens an existing extrusion for editing, with the values it has. */
  edit(featureId: string): void {
    if (this.state.phase !== "idle") return;
    this.refused = null;
    const editor = this.model.editExtrude(featureId);
    const view = editor.getView();
    const form = formFromParams(view.params, this.options.decimalComma);
    this.attach(editor);
    const region = view.params.region;
    this.set({
      ...idle(form),
      phase: "dialog",
      mode: "edit",
      featureId: view.featureId,
      name: view.name,
      bodyId: view.bodyId,
      sketchId: view.sketch,
      profile: region === null ? null : { sketchId: view.sketch, regionId: region },
    });
    this.refresh();
  }

  /** An area was picked: it starts the extrusion (asking phase) or replaces the area of the running one. */
  pick(ref: ProfileRef): void {
    const s = this.state;
    if (s.phase === "idle" || s.confirming) return;
    if (sameProfile(s.profile, ref)) return;
    this.refused = null;
    if (s.phase === "dialog" && this.editor && this.editor.getView().sketch === ref.sketchId) {
      this.editor.set({ region: ref.regionId });
      this.set({ profile: ref, profileGone: false, failure: null });
      this.refresh();
      return;
    }
    if (s.phase === "dialog" && s.mode === "edit") return; // an existing step keeps its sketch
    // A new editor for the area of another sketch (or the first one): the typed values go with it.
    this.detach(true);
    const distance = checkDistance(s.form.text);
    const mm = distance.ok ? distance.value : { value: DEFAULT_MM, unit: "mm" as const };
    const editor = this.model.startExtrude({
      sketch: ref.sketchId,
      region: ref.regionId,
      extent: s.form.extent,
      distance: signedDistance(s.form, mm),
    });
    this.attach(editor);
    const view = editor.getView();
    this.set({
      phase: "dialog",
      mode: "create",
      featureId: view.featureId,
      name: view.name,
      bodyId: view.bodyId,
      sketchId: view.sketch,
      profile: ref,
      profileGone: false,
      failure: null,
    });
    this.refresh();
  }

  /** OK. Does nothing while the field or the area is not valid; otherwise commits one undo step or shows why not. */
  async confirm(): Promise<EditOutcome | null> {
    const s = this.state;
    const editor = this.editor;
    if (s.phase !== "dialog" || !editor || s.confirming || s.profile === null || !s.distance.ok) return null;
    this.set({ confirming: true });
    const outcome = await editor.commit();
    if (this.editor !== editor) return outcome; // cancelled while waiting
    if (outcome.ok) {
      const view = editor.getView();
      const done: CommittedStep = { featureId: view.featureId, bodyId: view.bodyId, mode: this.state.mode };
      this.detach(false);
      this.set({ ...idle(this.state.form) });
      this.options.onCommitted?.(done);
      return outcome;
    }
    this.refused =
      outcome.reason === "rejected"
        ? { kind: "rejected", problem: outcome.problem }
        : outcome.reason === "engine"
          ? { kind: "engine", error: outcome.error }
          : { kind: "invalid", message: outcome.message };
    this.set({ confirming: false });
    this.refresh();
    return outcome;
  }

  /** Cancel, Esc or the corner button: nothing is committed and the preview disappears. */
  cancel(): void {
    if (this.state.phase === "idle") return;
    this.detach(true);
    this.refused = null;
    this.set({ ...idle(this.state.form) });
  }

  // ------------------------------------------------------------------------------------------------ the form

  /** The user typed in the distance field (every keystroke). A valid value is previewed, the last valid one stays shown otherwise. */
  setText(text: string): void {
    const s = this.state;
    if (s.phase === "idle" || s.confirming) return;
    this.refused = null;
    const form: ExtrudeForm = { ...s.form, text };
    this.set({ form, distance: checkDistance(text) });
    this.send(form);
    this.refresh();
  }

  setExtent(extent: ExtrudeExtent): void {
    const s = this.state;
    if (s.phase === "idle" || s.confirming || s.form.extent === extent) return;
    this.refused = null;
    const form: ExtrudeForm = { ...s.form, extent };
    this.set({ form });
    this.send(form);
    this.refresh();
  }

  /** The opposite direction (one side only). */
  flip(): void {
    const s = this.state;
    if (s.phase === "idle" || s.confirming || s.form.extent !== "oneSide") return;
    this.refused = null;
    const form: ExtrudeForm = { ...s.form, reversed: !s.form.reversed };
    this.set({ form });
    this.send(form);
    this.refresh();
  }

  /** The handle in the 3D view moved: signed distance along the sketch normal. */
  dragHandle(signed: number): void {
    const s = this.state;
    if (s.phase !== "dialog" || s.confirming) return;
    this.refused = null;
    const form = formFromHandle(s.form, signed, this.options.decimalComma);
    this.set({ form, distance: checkDistance(form.text) });
    this.send(form);
    this.refresh();
  }

  /** The engine is ready again (after a restart): a preview that did not come is asked for once more. */
  engineReady(): void {
    const editor = this.editor;
    if (editor?.getView().error) {
      editor.set({});
      this.refresh();
    }
  }

  /** The window goes away (or the model is replaced): a running command is cancelled. The command can be used again afterwards. */
  dispose(): void {
    if (this.state.phase === "idle") return;
    this.cancel();
  }

  // ------------------------------------------------------------------------------------------------ internals

  private defaultForm(): ExtrudeForm {
    return { text: distanceText(DEFAULT_MM, this.options.decimalComma), reversed: false, extent: "oneSide" };
  }

  /** Sends the values to the editor: the extent when it changed, the distance only when the typed text is a valid length. */
  private send(form: ExtrudeForm): void {
    const editor = this.editor;
    if (!editor) return;
    const params: Partial<ExtrudeParams> = {};
    if (editor.getView().params.extent !== form.extent) params.extent = form.extent;
    const distance = checkDistance(form.text);
    if (distance.ok) params.distance = signedDistance(form, distance.value);
    if (Object.keys(params).length > 0) editor.set(params);
  }

  private attach(editor: ExtrudeEditor): void {
    this.editor = editor;
    this.unsubscribe = editor.subscribe(() => this.refresh());
  }

  private detach(cancelEditor: boolean): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const editor = this.editor;
    this.editor = null;
    if (editor && cancelEditor) editor.cancel();
  }

  /**
   * Takes what the editor knows (pending, the step's outcome, an engine error, the areas) into the state. The editor reports
   * changes while this runs (it does when the area is dropped below), so a change that arrives meanwhile is taken in another pass.
   */
  private refresh(): void {
    if (this.refreshing) {
      this.again = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.again = false;
        this.refreshOnce();
      } while (this.again);
    } finally {
      this.refreshing = false;
    }
  }

  private refreshOnce(): void {
    const editor = this.editor;
    if (!editor) return;
    const view: ExtrudeView = editor.getView();
    const s = this.state;
    let profileGone = s.profileGone;
    let profile = s.profile;
    const dropArea = view.profiles !== null && profile !== null && !view.profiles.some((p) => p.key === profile?.regionId);
    if (dropArea) {
      // The area of this step is not in the sketch any more: ask again instead of guessing (the engine never guesses either).
      profile = null;
      profileGone = true;
    }
    let failure: CommandFailure | null = this.refused;
    if (!failure) {
      if (view.error) failure = { kind: "engine", error: view.error };
      // A refused preview is shown once the answer to the current values is in (not for the answer to an older value).
      else if (!view.pending && view.step?.state === "error" && view.step.problem && s.distance.ok && profile !== null) {
        failure = { kind: "preview", problem: view.step.problem };
      }
    }
    if (sameFailure(failure, s.failure)) failure = s.failure;
    if (s.pending !== view.pending || failure !== s.failure || profile !== s.profile || profileGone !== s.profileGone) {
      this.set({ pending: view.pending, failure, profile, profileGone });
    }
    if (dropArea) editor.set({ region: null });
  }

  private set(patch: Partial<ExtrudeState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  }
}
