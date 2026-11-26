// The sketch session: everything about one open sketch that is not drawing. It owns the active tool, the selection, the
// typed values and the dimension value box, turns pointer and key events into tool calls, hands the layer what to draw and
// reports refused edits. Plain TypeScript with the editor and the layer injected, so the whole flow runs in unit tests.
import { parseQuantity, type QuantityKind, type QuantityParse } from "../../document/index.ts";
import type { DimensionKind } from "../../document/types.ts";
import type { EditOutcome, SketchEditor, SketchView } from "../../model/index.ts";
import type { LiveDimension, LiveDimensionItem, SketchLayer, SketchLayerOptions, SketchPreview } from "../../viewport/sketch/types.ts";
import { constraintFromSelection } from "./constraint-tool.ts";
import { formatNumber, type P } from "./geometry.ts";
import { createTool, isConstraintTool, toolKeys } from "./tools.ts";
import type { DimensionEdit, EditAction, Ghost, NoticeId, PendingDimension, Pointer, PromptId, Tool, ToolContext, ToolId } from "./tool.ts";
import { startsTyping } from "./typed-fields.ts";

/** A refused edit, handed to whoever shows the message. */
export interface Rejection {
  action: EditAction;
  outcome: Exclude<EditOutcome, { ok: true }>;
  /** The sketch as shown when the edit was refused (for naming the elements involved). */
  view: SketchView;
}

/** "reference": the user chose "Als Referenzmaß anlegen" (only offered for dimensions). */
export type RejectChoice = "reference" | "cancel";

export interface SessionDeps {
  editor: SketchEditor;
  layer: SketchLayer;
  options: SketchLayerOptions;
  reject: (rejection: Rejection) => Promise<RejectChoice>;
  /** German decimal comma in the value boxes. */
  decimalComma: boolean;
}

export interface TypedFieldState {
  id: string;
  kind: QuantityKind;
  /** What the user typed into the field (empty while the field follows the pointer). */
  text: string;
  /** The user typed into this field: it keeps its value and no longer follows the pointer. */
  locked: boolean;
  /** The value of the shape now, in mm or degrees (what an untouched field shows). */
  live: number;
  /** What the value measures, drawn as a dimension (see LiveField). */
  dim: LiveDimension;
  /** Where the field of the "Etikett" look belongs (see LiveField). */
  at: P;
  away: P;
  either: boolean;
  /** Set only when the text does not read as a value. */
  error: Extract<QuantityParse, { ok: false }> | null;
}

export interface DimEditState {
  id: string | null;
  dimKind: DimensionKind;
  text: string;
  unit: "mm" | "deg";
  quantity: QuantityKind;
  error: Extract<QuantityParse, { ok: false }> | null;
  /** Sketch coordinates of the label the box belongs to. */
  at: P;
}

export interface SessionState {
  tool: ToolId;
  prompt: PromptId;
  selection: readonly string[];
  /** The tool has begun something; also true while a drag runs. */
  inProgress: boolean;
  /**
   * The value fields of the shape being drawn: there from the first point on (they follow the pointer), null while no
   * draw tool has begun a shape. `typing` is true once a character was typed; `active` is the field the next one goes to.
   */
  typed: { fields: TypedFieldState[]; active: string; typing: boolean } | null;
  dimEdit: DimEditState | null;
  ghost: Ghost | null;
  /** A short message that replaces the prompt in the hint bar until the next click or key, or null. */
  notice: NoticeId | null;
  /** A point the user tried to drag is fully determined and does not move. */
  dragBlocked: boolean;
}

interface DimEdit extends DimensionEdit {
  text: string;
  /** The value in the sketch when editing started (null: the dimension is not in the sketch yet). */
  original: number | null;
}

const dimQuantity = (kind: DimensionKind): QuantityKind => (kind === "angle" ? "angle" : "length");
const dimSign = (kind: DimensionKind): "positive" | "any" => (kind === "distanceX" || kind === "distanceY" || kind === "angle" ? "any" : "positive");

export class SketchSession {
  private tool: Tool;
  private selected: readonly string[] = [];
  private edit: DimEdit | null = null;
  private state: SessionState;
  private readonly listeners = new Set<() => void>();
  private readonly off: () => void;
  private options: SketchLayerOptions;
  private disposed = false;
  private blocked = false;
  private notice: NoticeId | null = null;
  /** Elements the palette's "what is still missing" entry under the pointer lights up. */
  private factHighlight: readonly string[] = [];

  private readonly context: ToolContext;

  private readonly deps: SessionDeps;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.options = deps.options;
    this.context = {
      view: () => deps.editor.getView(),
      editor: deps.editor,
      run: (action, call, opts) => this.run(action, call, opts),
      editDimension: (edit) => this.beginDimEdit(edit),
      notify: (id) => {
        this.notice = id;
      },
      done: () => this.setTool("select"),
      selection: () => this.selected,
      setSelection: (ids) => this.select(ids),
      pxPerMm: () => deps.layer.pxPerMm(),
    };
    this.tool = createTool("select", this.context);
    this.off = deps.editor.subscribe(() => this.onView());
    deps.layer.setSketch(deps.editor.getView(), this.options);
    this.state = this.snapshot();
    this.publish();
  }

  // ------------------------------------------------------------------------------------------------ state

  getState = (): SessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get view(): SketchView {
    return this.deps.editor.getView();
  }

  private snapshot(): SessionState {
    const tool = this.tool;
    const typed = tool.typed;
    const live = typed && tool.inProgress() ? tool.liveFields() : [];
    const dimEdit = this.edit;
    const quantity = dimEdit ? dimQuantity(dimEdit.dimKind) : "length";
    const dimError = dimEdit ? this.parseDim(dimEdit) : null;
    return {
      tool: tool.id,
      prompt: dimEdit ? "dimensionValue" : typed?.isOpen ? "typing" : this.blocked ? "dragBlocked" : tool.prompt(),
      selection: this.selected,
      inProgress: tool.inProgress(),
      typed:
        typed && live.length > 0
          ? {
              fields: live.flatMap((l) => {
                const def = typed.defs.find((d) => d.id === l.id);
                if (!def) return [];
                const parse = typed.parse(def.id);
                return [
                  {
                    id: def.id,
                    kind: def.kind,
                    text: typed.text(def.id),
                    locked: typed.isLocked(def.id),
                    live: l.value,
                    dim: l.dim,
                    at: l.at,
                    away: l.away,
                    either: l.either ?? false,
                    error: parse && !parse.ok ? parse : null,
                  },
                ];
              }),
              active: typed.active ?? typed.selected,
              typing: typed.isOpen,
            }
          : null,
      dimEdit: dimEdit
        ? {
            id: dimEdit.id,
            dimKind: dimEdit.dimKind,
            text: dimEdit.text,
            unit: quantity === "angle" ? "deg" : "mm",
            quantity,
            error: dimError && !dimError.ok ? dimError : null,
            at: [dimEdit.label.x, dimEdit.label.y],
          }
        : null,
      ghost: this.tool.ghost(),
      notice: this.notice,
      dragBlocked: this.blocked,
    };
  }

  private parseDim(edit: DimEdit): QuantityParse | null {
    if (edit.text.trim() === "") return null;
    return parseQuantity(edit.text, dimQuantity(edit.dimKind), { sign: dimSign(edit.dimKind) });
  }

  private publish(): void {
    if (this.disposed) return;
    const { layer } = this.deps;
    this.state = this.snapshot();
    layer.setPreview(this.previewWithValues(this.tool.preview(), this.state.typed));
    layer.setSelection([...this.selected, ...this.tool.highlight(), ...this.factHighlight]);
    for (const l of [...this.listeners]) l();
  }

  /**
   * The tool's preview plus the measuring graphics of its values: the field that has the keyboard is drawn in the accent
   * colour, a value that does not read as a number in red, the others quiet.
   */
  private previewWithValues(preview: SketchPreview | null, typed: SessionState["typed"]): SketchPreview | null {
    if (!typed) return preview;
    const live: LiveDimensionItem[] = typed.fields.map((f) => ({ id: f.id, dim: f.dim, tone: f.error ? "invalid" : f.id === typed.active ? "active" : "quiet" }));
    return { ...(preview ?? {}), live };
  }

  /** A click on an entry of "what is still missing": its elements are selected and brought into sight (pan, zoom only when needed). */
  focusFact(ids: readonly string[]): void {
    this.select(ids);
    this.deps.layer.focusOn(ids);
  }

  /** The pointer or the focus is on an entry of "what is still missing" (null: left it): its elements light up in the view. */
  highlightFact(ids: readonly string[] | null): void {
    const next = ids ?? [];
    if (next.length === this.factHighlight.length && next.every((id, i) => id === this.factHighlight[i])) return;
    this.factHighlight = next;
    this.publish();
  }

  setOptions(options: SketchLayerOptions): void {
    this.options = options;
    this.deps.layer.setSketch(this.deps.editor.getView(), options);
  }

  private onView(): void {
    if (this.disposed) return;
    const view = this.deps.editor.getView();
    this.deps.layer.setSketch(view, this.options);
    const exists = new Set<string>([
      ...view.points.map((p) => p.id),
      ...view.lines.map((l) => l.id),
      ...view.circles.map((c) => c.id),
      ...view.dimensions.map((d) => d.id),
      ...view.constraints.map((c) => c.id),
    ]);
    const kept = this.selected.filter((id) => exists.has(id));
    if (kept.length !== this.selected.length) this.selected = kept;
    this.blocked = view.drag?.points.some((p) => !p.moved && p.error > 0) ?? false;
    this.publish();
  }

  dispose(): void {
    if (this.disposed) return;
    this.edit?.group?.close();
    this.tool.reset();
    this.disposed = true;
    this.off();
    const { layer } = this.deps;
    layer.setPreview(null);
    layer.setSelection([]);
    layer.setHover(null);
    layer.setSketch(null, this.options);
    this.listeners.clear();
  }

  // ------------------------------------------------------------------------------------------------ edits

  private async run(action: EditAction, call: () => Promise<EditOutcome>, opts?: { silent?: boolean }): Promise<EditOutcome> {
    const outcome = await call();
    if (outcome.ok) {
      this.publish();
      return outcome;
    }
    if (outcome.reason === "rejected" && opts?.silent) return outcome;
    await this.report(action, outcome);
    return outcome;
  }

  /** Shows a refused edit and, when the user asks for it, adds the refused dimension as a reference dimension. */
  private async report(action: EditAction, outcome: Exclude<EditOutcome, { ok: true }>): Promise<void> {
    const choice = await this.deps.reject({ action, outcome, view: this.deps.editor.getView() });
    if (choice !== "reference" || action.kind !== "dimension") return;
    const d = action.dimension;
    const made = await (d.existingId !== undefined
      ? this.deps.editor.setDriving(d.existingId, false)
      : this.deps.editor.addDimension(d.dimKind, d.refs, null, d.label, { driving: false }));
    if (!made.ok) await this.deps.reject({ action: { kind: "constraint" }, outcome: made, view: this.deps.editor.getView() });
    this.publish();
  }

  // ------------------------------------------------------------------------------------------------ tools

  setTool(id: ToolId): void {
    this.notice = null;
    this.cancelDimEdit();
    this.tool.reset();
    this.blocked = false;
    if (isConstraintTool(id)) {
      // Something that fits is selected already: apply the constraint to it and stay in the select tool.
      const refs = constraintFromSelection(id, this.selected);
      if (refs) {
        this.tool = createTool("select", this.context);
        this.publish();
        void this.run({ kind: "constraint" }, () => this.deps.editor.addConstraint(id, refs)).then(() => this.select([]));
        return;
      }
    }
    this.tool = createTool(id, this.context);
    this.select([]);
  }

  /** The toolbar buttons: a second click on the running tool goes back to selecting. */
  toggleTool(id: ToolId): void {
    this.setTool(this.tool.id === id ? "select" : id);
  }

  select(ids: readonly string[]): void {
    this.selected = ids;
    this.publish();
  }

  /** The pointer left the view or the sketch closed: nothing is hovered. */
  clearHover(): void {
    this.deps.layer.setHover(null);
  }

  private pointer(x: number, y: number, shift: boolean): Pointer | null {
    const at = this.deps.layer.toSketch(x, y);
    if (!at) return null;
    return { x, y, at: [at.u, at.v], hit: this.deps.layer.pick(x, y), shift };
  }

  pointerMove(x: number, y: number, shift = false): void {
    const p = this.pointer(x, y, shift);
    if (!p) return;
    this.deps.layer.setHover(p.hit);
    this.tool.hover(p);
    this.publish();
  }

  async pointerDown(x: number, y: number, shift = false): Promise<void> {
    const p = this.pointer(x, y, shift);
    if (!p) return;
    this.notice = null;
    if (this.edit) this.cancelDimEdit();
    this.blocked = false;
    // The click that ends a typed length is a click at the pointer: the typed values win, so the box closes first.
    this.tool.typed?.close();
    await this.tool.down(p);
    this.publish();
  }

  async pointerUp(x: number, y: number, shift = false): Promise<void> {
    const p = this.pointer(x, y, shift);
    if (!p) return;
    await this.tool.up(p);
    this.publish();
  }

  // ------------------------------------------------------------------------------------------------ typed values

  /** The first typed character while a tool waits for its next point opens the value box. */
  private typeStart(key: string): boolean {
    const typed = this.tool.typed;
    if (!typed || !this.tool.inProgress() || this.edit) return false;
    typed.open(key);
    this.tool.typedChanged();
    this.publish();
    return true;
  }

  /** Tab before anything was typed: the next live field gets the keyboard, so the first digit goes there. */
  private selectNextField(): boolean {
    const typed = this.tool.typed;
    if (!typed || typed.defs.length < 2 || typed.isOpen || !this.tool.inProgress() || this.edit) return false;
    typed.next();
    this.publish();
    return true;
  }

  setTyped(id: string, text: string): void {
    const typed = this.tool.typed;
    if (!typed) return;
    typed.setText(id, text);
    this.tool.typedChanged();
    this.publish();
  }

  focusTyped(id: string): void {
    this.tool.typed?.focus(id);
    this.publish();
  }

  nextTyped(): void {
    this.tool.typed?.next();
    this.publish();
  }

  async commitTyped(): Promise<void> {
    const typed = this.tool.typed;
    if (!typed || !typed.isOpen) return;
    if (typed.hasError() || !typed.hasValues) return;
    await this.tool.commitTyped();
    this.publish();
  }

  cancelTyped(): void {
    this.tool.typed?.close();
    this.publish();
  }

  // ------------------------------------------------------------------------------------------------ dimension value box

  private beginDimEdit(edit: DimensionEdit): void {
    this.cancelDimEdit();
    const view = this.deps.editor.getView();
    const existing = edit.id ? view.dimensions.find((d) => d.id === edit.id) : undefined;
    this.edit = {
      ...edit,
      text: formatNumber(edit.initial, this.deps.decimalComma),
      original: existing ? existing.value.value : null,
    };
    this.publish();
  }

  /** Double-click on the value of a dimension in the sketch. */
  editDimension(id: string): void {
    const d = this.deps.editor.getView().dimensions.find((x) => x.id === id);
    if (!d || !d.driving) return;
    this.tool.reset();
    this.beginDimEdit({ id, dimKind: d.kind, refs: d.refs, label: d.label, initial: d.value.value });
  }

  setDimText(text: string): void {
    const edit = this.edit;
    if (!edit) return;
    edit.text = text;
    const parse = this.parseDim(edit);
    if (parse?.ok && edit.id) this.deps.editor.previewDimension(edit.id, parse.value);
    this.publish();
  }

  async commitDimEdit(): Promise<void> {
    const edit = this.edit;
    if (!edit) return;
    const parse = this.parseDim(edit);
    if (!parse || !parse.ok) return;
    const q = parse.value;
    const pending: PendingDimension = {
      dimKind: edit.dimKind,
      refs: edit.refs,
      label: edit.label,
      value: q,
      ...(edit.id ? { existingId: edit.id } : {}),
    };
    const action: EditAction = { kind: "dimension", dimension: pending };
    if (edit.id && edit.original !== null && Math.abs(edit.original - q.value) < 1e-9) {
      this.cancelDimEdit();
      return;
    }
    this.edit = null;
    try {
      if (edit.id) {
        // For a dimension that was just placed this commit joins the undo step of the placing (edit.group); the
        // group stays open through a refusal, so "Als Referenzmaß anlegen" joins it too.
        await this.run(action, () => this.deps.editor.setDimension(edit.id!, q));
        // A refused value leaves the preview of the typed value behind: the sketch goes back to the committed state.
        this.deps.editor.cancelPreview();
      } else {
        await this.run(action, () => this.deps.editor.addDimension(edit.dimKind, edit.refs, q, edit.label));
      }
    } finally {
      edit.group?.close();
    }
    this.publish();
  }

  cancelDimEdit(): void {
    const edit = this.edit;
    if (!edit) return;
    this.edit = null;
    // Esc, a click elsewhere, a tool change or undo: a dimension that was placed keeps its measured value and its one
    // undo step (it is in the sketch already); only the typed value is dropped.
    edit.group?.close();
    if (edit.id) this.deps.editor.cancelPreview();
    this.publish();
  }

  // ------------------------------------------------------------------------------------------------ keys

  /** Esc: ends the innermost thing that is open, step by step. */
  escape(): boolean {
    if (this.edit) {
      this.cancelDimEdit();
      return true;
    }
    if (this.tool.typed?.isOpen) {
      this.cancelTyped();
      return true;
    }
    if (this.tool.inProgress()) {
      this.tool.reset();
      this.publish();
      return true;
    }
    if (this.tool.id !== "select") {
      this.setTool("select");
      return true;
    }
    if (this.selected.length > 0) {
      this.select([]);
      return true;
    }
    return false;
  }

  async removeSelection(): Promise<void> {
    const ids = [...this.selected];
    if (ids.length === 0) return;
    const outcome = await this.run({ kind: "delete" }, () => this.deps.editor.remove(ids));
    if (outcome.ok) this.select([]);
  }

  /** Keys that reach the session from the page. Returns true when the key was used. */
  key(event: { key: string; ctrl: boolean; alt: boolean; meta: boolean; shift: boolean }): boolean {
    this.notice = null;
    if (event.key === "Escape") return this.escape();
    if (event.ctrl || event.meta || event.alt) return false;
    if (event.key === "Delete" || event.key === "Backspace") {
      if (this.edit || this.tool.typed?.isOpen || this.selected.length === 0) return false;
      void this.removeSelection();
      return true;
    }
    if (startsTyping(event.key) && this.typeStart(event.key)) return true;
    if (event.key === "Tab" && !event.shift && this.selectNextField()) return true;
    const upper = event.key.toUpperCase();
    const tool = (Object.keys(toolKeys) as ToolId[]).find((id) => toolKeys[id] === upper);
    if (tool && !this.edit && !this.tool.typed?.isOpen && event.key.length === 1) {
      this.setTool(tool);
      return true;
    }
    return false;
  }

  /** Back to a calm state after undo or redo changed the sketch under the tools. */
  resetTool(): void {
    this.tool.reset();
    this.cancelDimEdit();
    this.tool.typed?.close();
    this.blocked = false;
    this.publish();
  }
}
