// What every sketch tool is: a small state machine that reads pointer events and the sketch view and calls the sketch
// editor. Tools are plain TypeScript (no React, no DOM), so each one is unit-tested with a fake layer and a fake editor.
// The tool never solves anything: it hands points and values to the editor and shows what the editor answers.
import type { UndoGroup } from "../../document/store.ts";
import type { DimensionKind, Quantity, Vec2 } from "../../document/types.ts";
import type { EditOutcome, PointInput, SketchEditor, SketchView } from "../../model/index.ts";
import type { LiveDimension, SketchHit, SketchPreview } from "../../viewport/sketch/types.ts";
import type { P } from "./geometry.ts";
import type { TypedFields } from "./typed-fields.ts";

export type ToolId =
  | "select"
  | "line"
  | "rectangle"
  | "circle"
  | "dimension"
  | "coincident"
  | "pointOnCurve"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "equal"
  | "fix";

/** One pointer position, already looked at: the sketch coordinates and what lies under it. */
export interface Pointer {
  /** CSS px inside the viewport element. */
  x: number;
  y: number;
  /** Sketch coordinates in mm. */
  at: P;
  hit: SketchHit | null;
  shift: boolean;
}

/** What the user was doing when the editor refused, for the message. */
export type EditAction =
  | { kind: "line" | "rectangle" | "circle" | "constraint" | "delete" | "drag" }
  | { kind: "dimension"; dimension: PendingDimension };

/** A dimension the editor did not take; the dialog offers it as a reference dimension. */
export interface PendingDimension {
  dimKind: DimensionKind;
  refs: string[];
  label: Vec2;
  /** The value that was refused (null: the measured one). */
  value: Quantity | null;
  /** The dimension is already in the sketch and only its new value was refused. */
  existingId?: string;
}

export interface ToolContext {
  view(): SketchView;
  editor: SketchEditor;
  /**
   * Runs one editor call. A refusal opens the message (for dimensions) unless silent is set and the editor refused
   * on the sketch itself; every other failure is always shown. Resolves with the editor's outcome.
   */
  run(action: EditAction, call: () => Promise<EditOutcome>, opts?: { silent?: boolean }): Promise<EditOutcome>;
  /** The tool is finished with its element (a rectangle, a circle): the select tool takes over. */
  done(): void;
  selection(): readonly string[];
  setSelection(ids: readonly string[]): void;
  /** Opens the value box of a dimension that was just placed or is edited (the session shows it). */
  editDimension(edit: DimensionEdit): void;
  /** Tells the user something short and calm in the hint bar (replaces the prompt until the next click or key). */
  notify(id: NoticeId): void;
  pxPerMm(): number;
}

/** A dimension whose value the user is about to type. */
export interface DimensionEdit {
  /** In the sketch already (then typing previews it), or null while it was not applied yet. */
  id: string | null;
  dimKind: DimensionKind;
  refs: string[];
  label: Vec2;
  /** The value shown first (measured), in mm or deg. */
  initial: number;
  /**
   * The undo group the placing opened (placing, typing and Enter are ONE undo step). The session owns it from
   * here on and closes it when the box ends, however it ends (Enter, Esc, another click, undo).
   */
  group?: UndoGroup;
}

/** The text the status line shows for the tool's next step (i18n key below sketch.prompt). */
export type PromptId =
  | "select"
  | "lineStart"
  | "lineEnd"
  | "rectangleStart"
  | "rectangleEnd"
  | "circleCentre"
  | "circleSize"
  | "dimensionFirst"
  | "dimensionSecond"
  | "dimensionLine"
  | "dimensionCircle"
  | "dimensionPlace"
  | "coincident"
  | "pointOnCurve"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "equal"
  | "fix"
  | "typing"
  | "dimensionValue"
  | "dragBlocked";

/** One value of the shape being drawn (a length, an angle, a diameter) and where its field belongs. */
export interface LiveField {
  /** The id of the typed field it belongs to. */
  id: string;
  /** The value now, in mm or degrees, as the rubber band shows it. */
  value: number;
  /** What the value measures, as the graphics of a dimension (extension lines, dimension line with arrowheads, arc). */
  dim: LiveDimension;
  /** The point (sketch coordinates) the label of the "Etikett" look is attached to. */
  at: P;
  /** A direction in the sketch plane that points away from the geometry: that label sits beyond `at` that way. */
  away: P;
  /** `away` may be turned by 180 degrees (it is only the normal of a line): the overlay takes the upper or right side. */
  either?: boolean;
}

export interface Ghost {
  /** Sketch coordinates where the label would sit. */
  at: P;
  dimKind: DimensionKind;
  /** The measured value (mm or deg), for display only. */
  value: number;
  /** What it would measure, in the order the dimension would store them, and for an angle the rays. */
  refs: string[];
  reverse?: boolean[];
}

/** A short message the session shows in place of the prompt until the next click or key (id below sketch.notice). */
export type NoticeId = "alreadyFixed" | "noDistance";

export interface Tool {
  readonly id: ToolId;
  /** Typed values (length, angle ...) or null for tools that have none. */
  readonly typed: TypedFields | null;
  /** The tool has begun something (first point set, first thing picked): Esc ends that first. */
  inProgress(): boolean;
  prompt(): PromptId;
  /** Rubber band and hints the layer draws. */
  preview(): SketchPreview | null;
  /** Ids the layer shows as selected while the tool collects its references. */
  highlight(): string[];
  /** Dimension tool: the label that follows the pointer. */
  ghost(): Ghost | null;
  /**
   * The values of the shape being drawn, in the order of the typed fields, each with the place it belongs to. Empty while
   * nothing is in progress. The fields are shown from the first point on and follow the pointer.
   */
  liveFields(): LiveField[];
  /** Typed values changed: the rubber band follows. */
  typedChanged(): void;
  hover(pointer: Pointer): void;
  down(pointer: Pointer): Promise<void>;
  up(pointer: Pointer): Promise<void>;
  /** Back to the start of the tool (Esc, undo, a refused edit). */
  reset(): void;
  /** Enter while values are typed. */
  commitTyped(): Promise<void>;
}

export abstract class BaseTool implements Tool {
  abstract readonly id: ToolId;
  readonly typed: TypedFields | null = null;
  protected readonly ctx: ToolContext;
  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }
  abstract inProgress(): boolean;
  abstract prompt(): PromptId;
  preview(): SketchPreview | null {
    return null;
  }
  highlight(): string[] {
    return [];
  }
  ghost(): Ghost | null {
    return null;
  }
  liveFields(): LiveField[] {
    return [];
  }
  typedChanged(): void {
    /* tools without typed values */
  }
  hover(_pointer: Pointer): void {
    /* tools that only react to clicks */
  }
  down(_pointer: Pointer): Promise<void> {
    return Promise.resolve();
  }
  up(_pointer: Pointer): Promise<void> {
    return Promise.resolve();
  }
  abstract reset(): void;
  commitTyped(): Promise<void> {
    return Promise.resolve();
  }
}

export type { PointInput };
