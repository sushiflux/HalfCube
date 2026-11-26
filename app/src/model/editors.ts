// What the UI works with: views to draw and editors to change the document. The UI never talks to the engine
// client directly; Playwright, the manual clips and later the AI call the same functions.
import type {
  BodyEdge,
  FreedomFact,
  BodyFace,
  BoundingBox,
  ModelTimings,
  PlaneFrame,
  Problem,
  SketchSolveResult,
  StepStatus,
} from "../engine/generated/protocol.ts";
import type { DocumentStore, UndoGroup } from "../document/store.ts";
import type { Form, Shape } from "../document/shape-names.ts";
import type { ConstraintKind, DimensionKind, OriginPlane, Quantity, SketchFeature, Vec2 } from "../document/types.ts";

export type EntityState = SketchSolveResult["entities"][string];
export type ConstraintState = SketchSolveResult["constraints"][string];
export type SolveStatus = SketchSolveResult["status"];

export type PointInput =
  /** A new free point (sketch coordinates, mm). */
  | { x: number; y: number }
  /** An existing point id, or "@origin" (a new point joined to the origin by a coincident constraint). */
  | { snap: string }
  /** A new point on an existing line or circle (pointOnCurve). */
  | { x: number; y: number; onCurve: string };

export type EditOutcome =
  | { ok: true }
  /**
   * The engine solved the proposed sketch and refused it (conflicting, redundant or not solvable). Nothing was
   * committed. For a contradicting dimension the UI offers "add as reference dimension" (addDimension / setDriving
   * with driving false) or cancel.
   */
  | { ok: false; reason: "rejected"; problem: Problem; conflicting: string[]; redundant: string[] }
  /** The engine could not answer (crash, restart, malformed document). Nothing was committed. */
  | { ok: false; reason: "engine"; error: Error }
  /** The edit itself is not possible (unknown id, wrong kind); a programming error of the caller. */
  | { ok: false; reason: "invalid"; message: string };

export interface SketchPointView {
  id: string;
  x: number;
  y: number;
  state: EntityState;
}
export interface SketchLineView {
  id: string;
  p1: string;
  p2: string;
  construction: boolean;
  state: EntityState;
}
export interface SketchCircleView {
  id: string;
  center: string;
  radius: number;
  construction: boolean;
  state: EntityState;
}
export interface SketchConstraintView {
  id: string;
  kind: ConstraintKind;
  refs: string[];
  state: ConstraintState;
}
export interface SketchDimensionView {
  id: string;
  kind: DimensionKind;
  refs: string[];
  /** The number of the automatic name d<number> (Dimension.number); absent only for a dimension not numbered yet. */
  number?: number;
  /** The stored value; for a reference dimension the value it had when it became one. */
  value: Quantity;
  driving: boolean;
  /** Reference dimensions: the value measured from the solved sketch (mm or deg). */
  measured?: number;
  /** Angle between rays: per reference, the ray runs against the direction of its line. Absent: the old reading. */
  reverse?: boolean[];
  /** Where the number sits, absolute sketch coordinates on the geometry of this view (stored relative, see document/dimension-label.ts). */
  label: Vec2;
  state: ConstraintState;
}

/**
 * What the viewport draws in sketch mode. profiles are the closed regions of the solved sketch; the UI highlights
 * highlights per loop (an inner band along every determined loop, or the translucent fill of every region whose outer loop
 * is determined; the user chooses in the settings). Open chains and loops with an undetermined curve
 * have no highlight, and one free hole does not take the highlight away from the loops that are determined.
 */
export interface SketchView {
  sketchId: string;
  plane: OriginPlane;
  frame: PlaneFrame;
  points: SketchPointView[];
  lines: SketchLineView[];
  circles: SketchCircleView[];
  constraints: SketchConstraintView[];
  dimensions: SketchDimensionView[];
  /** Closed regions of the solved sketch, sorted by key; empty while a drag skips them (drag.profilesSkipped). */
  profiles: ProfileView[];
  dof: number;
  /** The numbered shapes of the sketch (Rectangle 1, Circle 2 ...), in creation order, with the elements each one owns. */
  shapes: Shape[];
  /** The groups of connected shapes with their Form numbers (groups of more than one shape). */
  forms: Form[];
  /** What is still free, per shape, in facts (the palette's "what is still missing"); empty while a drag runs or when nothing is free. */
  freedom: FreedomFact[];
  status: SolveStatus;
  problem?: Problem;
  /** The view shows a live preview (typed dimension value, a drag in progress), not the committed sketch. */
  preview: boolean;
  /** Only while a point is being dragged: what the last shown drag step did. */
  drag?: DragView;
}

/** Outcome of the drag step the view shows. */
export interface DragView {
  /** One entry per dragged point. A fully determined point has moved false and error > 0: it cannot be moved. */
  points: { id: string; /** mm between the point and where the pointer wants it */ error: number; moved: boolean }[];
  /** False when a step found no solution; the view then shows the last good step. */
  complete: boolean;
  /** The regions were left out of the drag steps because they took too long (they come back when the drag ends). */
  profilesSkipped: boolean;
}

export interface LineOptions {
  construction?: boolean;
  /** Adds a driving length dimension. */
  length?: Quantity;
  /** Adds an angle dimension against the sketch's u axis; exactly 0/180 deg become horizontal, 90/270 vertical. */
  angle?: Quantity;
}

export interface SketchEditor {
  readonly sketchId: string;
  /** Stable between changes; usable with useSyncExternalStore(editor.subscribe, editor.getView). */
  getView: () => SketchView;
  subscribe: (listener: () => void) => () => void;
  addLine(a: PointInput, b: PointInput, opts?: LineOptions): Promise<EditOutcome>;
  addRectangle(corner1: PointInput, corner2: PointInput): Promise<EditOutcome>;
  addCircle(center: PointInput, diameter: Quantity, opts?: { construction?: boolean }): Promise<EditOutcome>;
  addConstraint(kind: ConstraintKind, refs: string[]): Promise<EditOutcome>;
  /**
   * value null: the current measured value. opts.driving false: a reference dimension. label: the point (sketch
   * coordinates) where the number is to sit now; the document keeps it relative to the measured geometry.
   */
  addDimension(kind: DimensionKind, refs: string[], value: Quantity | null, label: Vec2, opts?: { driving?: boolean }): Promise<EditOutcome>;
  /** Live typing: the view follows every valid value (latest wins); never an undo step. */
  previewDimension(id: string, value: Quantity): void;
  /** Esc while typing: back to the committed sketch. */
  cancelPreview(): void;
  /** Enter: commits the value as one undo step (or refuses it, see EditOutcome). */
  setDimension(id: string, value: Quantity): Promise<EditOutcome>;
  setDriving(id: string, driving: boolean): Promise<EditOutcome>;
  /** Puts the number of a dimension at an absolute point (sketch coordinates); it follows the geometry from there on. */
  moveLabel(id: string, label: Vec2): Promise<EditOutcome>;
  remove(ids: string[]): Promise<EditOutcome>;
  /**
   * Drag one or more points (sketch mode, B7). Several points move as a group: the first one goes to the pointer, the
   * others keep their offsets. Nothing touches the document until end(); there is at most one drag at a time and no
   * other edit while it runs (they answer invalid).
   */
  beginDrag(pointIds: string[]): SketchDrag;
  /**
   * Starts an undo group for ONE user action that takes several edits (a rectangle with the two dimensions typed with
   * it, a new dimension and its typed value): everything committed until close() is one undo step, and one undo or
   * redo takes all of it. Each edit still records its own sketch step (sketch.steps); only undo is grouped.
   *
   * An edit that is refused inside the group is not committed and the group keeps what succeeded: the document never
   * holds more or less than the edits that went through. A group without a commit leaves no undo step. Groups do not
   * nest (a second beginGroup throws); undo, redo and finish() end the open group. Everything committed while a group is
   * open joins it, a drag included, so keep the group to one action.
   */
  beginGroup(): UndoGroup;
  /** beginGroup() for a sequence of awaited edits: closes the group when the action settles, also on a throw. */
  group<T>(action: () => Promise<T>): Promise<T>;
  /** Ends sketch mode; the model is rebuilt with the sketch. Not an undo step. Closes an open group. */
  finish(): Promise<void>;
}

/** The handle of a drag in progress (SketchEditor.beginDrag). */
export interface SketchDrag {
  /**
   * The pointer is at (x, y) in sketch coordinates. The view follows (latest wins, stale answers are dropped: at
   * most one drag step is in the engine and one waits). Never an undo step.
   */
  moveTo(x: number, y: number): void;
  /**
   * Lets go: waits for the last step, solves the result once more with the element states and regions, and commits
   * it as exactly one undo step (nothing is committed when no point moved). Resolves with the outcome.
   */
  end(): Promise<EditOutcome>;
  /** Esc: the sketch is as it was before the drag; the document was never touched. */
  cancel(): void;
}

/** A closed region of a sketch, in sketch coordinates. */
export interface ProfileView {
  key: string;
  outer: string[];
  holes: string[][];
  area: number;
  /** Every curve of all its loops is fully determined (the engine's answer; needs the element states, false when they were not asked for). */
  determined: boolean;
  /**
   * Per loop, in the order of `loops` (the outer loop first, then the holes): every curve of that loop is fully determined.
   * Worked out from the element states of the same answer (profileView), so one free circle in a determined rectangle leaves
   * the rectangle's loop determined. What the highlight follows: band = the loops that are true, fill = the regions whose
   * first entry is true (the holes are cut out of the fill either way).
   */
  loopsDetermined: boolean[];
  /** (u, v) pairs and triangle indices, counter-clockwise seen from the normal. */
  fill: { positions: Float32Array; indices: Uint32Array };
  /** One closed outline per loop (u, v pairs, first point not repeated): outer loop counter-clockwise first, then the holes clockwise. */
  loops: Float32Array[];
}

/** The closed regions of a finished sketch in its own plane (what the extrude command offers to pick). */
export interface SketchProfiles {
  frame: PlaneFrame;
  profiles: ProfileView[];
}

export type ExtrudeExtent = "oneSide" | "symmetric";

export interface ExtrudeParams {
  region: string | null;
  extent: ExtrudeExtent;
  /** oneSide: sign = direction along the sketch normal. symmetric: the total thickness. */
  distance: Quantity;
}

export interface ExtrudeView {
  featureId: string;
  /** The step's name as the timeline shows it ("Extrusion1"). */
  name: string;
  bodyId: string;
  sketch: string;
  frame: PlaneFrame | null;
  params: ExtrudeParams;
  /** Regions of the sketch for hover and selection in this command; null while loading. */
  profiles: ProfileView[] | null;
  /** State of the previewed step (null before the first preview answer). */
  step: StepStatus | null;
  /** A preview is being computed. */
  pending: boolean;
  /** Why the preview failed in the engine (crash, restart). */
  error?: Error;
}

export interface ExtrudeEditor {
  readonly featureId: string;
  getView: () => ExtrudeView;
  subscribe: (listener: () => void) => () => void;
  /** Changes the dialog values; the body is previewed through the engine. */
  set(patch: Partial<ExtrudeParams>): void;
  /** OK: commits the extrusion as one undo step after the preview of exactly these values succeeded. */
  commit(): Promise<EditOutcome>;
  /** Cancel: the document stays as it was; the preview body disappears. */
  cancel(): void;
}

export interface BodyMeshView {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  triangleFace: Uint32Array;
  edgePoints: Float32Array;
}

export interface BodyView {
  id: string;
  featureId: string;
  meshKey: string;
  preview: boolean;
  volume: number;
  area: number;
  bbox: BoundingBox;
  faces: BodyFace[];
  edges: BodyEdge[];
  mesh: BodyMeshView;
}

/** Bodies and timeline states for viewport, browser tree and timeline. */
export interface ModelView {
  /** Revision of the shown result (0 before the first answer). */
  revision: number;
  purpose: "commit" | "preview" | null;
  outcome: "ok" | "warning" | "error" | null;
  steps: StepStatus[];
  bodies: BodyView[];
  timings: ModelTimings | null;
  /** A rebuild is being computed. */
  pending: boolean;
  /** The last rebuild did not come back (crash, restart, refused document); it is sent again when the engine is ready. */
  error?: Error;
}

export interface HalfCubeModel {
  readonly document: DocumentStore;
  getModelView: () => ModelView;
  subscribeModel: (listener: () => void) => () => void;
  startSketch(plane: OriginPlane): Promise<SketchEditor>;
  editSketch(featureId: string): Promise<SketchEditor>;
  startExtrude(init: { sketch: string; region?: string; extent?: ExtrudeExtent; distance?: Quantity }): ExtrudeEditor;
  editExtrude(featureId: string): ExtrudeEditor;
  /**
   * The closed regions of a finished sketch, asked from the engine for exactly this sketch data (the answer is for the data
   * given, whatever the document holds by the time it arrives). Rejects when the engine cannot answer (crash, not ready).
   */
  sketchProfiles(sketch: SketchFeature): Promise<SketchProfiles>;
  /** Undo and redo of the document; the model follows. */
  undo(): boolean;
  redo(): boolean;
  dispose(): void;
}
