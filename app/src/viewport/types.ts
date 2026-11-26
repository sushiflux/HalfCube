// Public types of the 3D view: the scene content the document side hands in, what picking returns, and the Viewport
// interface the rest of the app talks to. The implementation (three.js) stays behind it.
import type { Bounds, Vec3 } from "./math.ts";
import type { AxisKey, StandardViewName, TipDirection, TurnDirection, ViewState } from "./camera.ts";
import type { Modifiers, NavigationPreset, WheelZoomDirection } from "./navigation.ts";
import type { LineKind, ViewportStyle } from "./style.ts";
import type { SketchLayer } from "./sketch/types.ts";

export type Vec2 = readonly [number, number];

// --- scene content ----------------------------------------------------------------------------------------------

/** The three origin planes: XY (top), XZ (front) and YZ (right). Their normals are +Z, -Y and +X. */
export type PlaneId = "xy" | "xz" | "yz";
export const planeIds: readonly PlaneId[] = ["xy", "xz", "yz"];

/** Something the user can hover or pick, named by the ids the engine hands out. */
export type EntityRef =
  | { kind: "plane"; plane: PlaneId }
  | { kind: "face"; bodyId: string; faceId: number }
  | { kind: "edge"; bodyId: string; edgeId: number }
  | { kind: "sketch"; sketchId: string; entityId: number }
  /** A closed region of a finished sketch, shown as a flat fill while a command (extrude) asks for a profile (see setProfiles). */
  | { kind: "profile"; sketchId: string; regionId: string };

export type PickKind = EntityRef["kind"];
/** Every kind, in the order picking prefers them: lines first, then profiles (flat fills), then faces, then origin planes. */
export const allPickKinds: readonly PickKind[] = ["sketch", "edge", "profile", "face", "plane"];

export function refKey(ref: EntityRef): string {
  switch (ref.kind) {
    case "plane": return `plane:${ref.plane}`;
    case "face": return `face:${ref.bodyId}:${ref.faceId}`;
    case "edge": return `edge:${ref.bodyId}:${ref.edgeId}`;
    case "sketch": return `sketch:${ref.sketchId}:${ref.entityId}`;
    case "profile": return `profile:${ref.sketchId}:${ref.regionId}`;
  }
}

export const refsEqual = (a: EntityRef | null, b: EntityRef | null): boolean => (a === null || b === null ? a === b : refKey(a) === refKey(b));

/** The B-rep edges of a body as polylines. `offsets` has one entry more than `ids`: edge i uses vertices offsets[i] .. offsets[i + 1] - 1. */
export interface BodyEdges {
  /** xyz of all polyline vertices, mm. */
  positions: Float32Array;
  offsets: Uint32Array;
  /** Engine edge id of each polyline. */
  ids: Uint32Array;
}

/** A body as the engine delivers it: typed arrays that are used as they are (no copy on the way to the GPU). */
export interface BodyData {
  id: string;
  /** xyz per vertex, mm. */
  positions: Float32Array;
  /** Unit normal per vertex. */
  normals: Float32Array;
  /** Three vertex indices per triangle. */
  indices: Uint32Array;
  /** Engine face id of each triangle (one entry per triangle). */
  faceIds: Uint32Array;
  edges?: BodyEdges;
  /** Overrides the theme's body colour, "#rrggbb" (component colours later). */
  color?: string;
}

/** A plane in 3D: a point and two unit axes; the normal is xAxis x yAxis. */
export interface PlaneFrame {
  origin: Vec3;
  xAxis: Vec3;
  yAxis: Vec3;
}

export type SketchGeometry =
  | { type: "line"; a: Vec2; b: Vec2 }
  | { type: "circle"; center: Vec2; radius: number }
  /** Counter-clockwise from `start` to `end` (radians, in the sketch plane). */
  | { type: "arc"; center: Vec2; radius: number; start: number; end: number }
  | { type: "polyline"; points: readonly Vec2[]; closed?: boolean };

export interface SketchEntity {
  /** Engine id of the entity, unique within the sketch. */
  id: number;
  /** How it is drawn: the colour, weight and dashes of this line kind (sketchFull, construction, dimLine, error ...). */
  kind: LineKind;
  geometry: SketchGeometry;
}

export interface SketchData {
  id: string;
  plane: PlaneFrame;
  entities: readonly SketchEntity[];
}

/**
 * One closed region of a finished sketch that can be picked as the profile of a command. The engine has already cut the holes
 * out of the triangles; the viewport draws them as a flat fill on `plane` and never changes them (no topology work here).
 */
export interface ProfileData {
  sketchId: string;
  /** The engine's key of the region (the same string `EntityRef.regionId` carries). */
  regionId: string;
  /** The sketch plane: sketch coordinates (u, v) map to origin + u * xAxis + v * yAxis. */
  plane: PlaneFrame;
  /** u v pairs in sketch millimetres, three vertices (six numbers) per triangle; no index buffer. */
  triangles: Float32Array;
  /** The boundary loops (outer and holes) for the hover and selection outline; derived from `triangles` when absent. */
  outline?: readonly Vec2[][];
}

/** The drag arrow of the extrude command: it starts at `origin`, runs along `direction` and ends `distance` mm from the start. */
export interface ExtrudeHandle {
  /** Where the arrow starts (on the profile), world mm. */
  origin: Vec3;
  /** The axis the arrow runs along (the profile's normal); any length but zero, it is normalised. */
  direction: Vec3;
  /**
   * Signed length in mm: the tip is at origin + direction * distance and the head points away from the origin (so a negative
   * distance draws the arrow on the other side). What the viewport shows is exactly this number; it keeps no value of its own.
   */
  distance: number;
}

/** Temporary content that is not part of the document yet: a rubber-band line, an extrusion preview. */
export interface PreviewData {
  sketches?: readonly SketchData[];
  bodies?: readonly BodyData[];
}

// --- picking ----------------------------------------------------------------------------------------------------

export interface PickResult {
  ref: EntityRef;
  /** The picked point in the world (mm): on the surface, on the edge or line, on the plane. */
  point: Vec3;
  /** Distance of the point in front of the camera, mm. */
  depth: number;
  /** For lines: how many CSS pixels the pointer is away from the line (0 for faces and planes). */
  distancePx: number;
}

/** A point on a plane: in the world and in the plane's own 2D coordinates. */
export interface PlanePoint {
  point: Vec3;
  u: number;
  v: number;
}

// --- the viewport -----------------------------------------------------------------------------------------------

export type RendererRequest = "auto" | "webgl2";

export interface BackendInfo {
  /** The backend that really draws. */
  backend: "WebGPU" | "WebGL2";
  requested: RendererRequest;
  /** True when WebGPU was possible but the view is on WebGL2 because it was asked for. */
  forcedWebGL2: boolean;
  /** MSAA samples of the output (4 in the product). */
  msaaSamples: number;
  /** Adapter of the WebGPU backend, when it is the active one. */
  adapter: string | null;
  /** WebGL renderer string, when WebGL2 is the active backend. */
  webglRenderer: string | null;
  initMs: number;
}

export interface ViewportOptions {
  style: ViewportStyle;
  renderer?: RendererRequest;
  navigationPreset?: NavigationPreset;
  wheelZoomDirection?: WheelZoomDirection;
  /** "auto" follows the operating system's reduced-motion setting; true = view changes are instant. */
  reducedMotion?: boolean | "auto";
}

export interface ViewportEvents {
  /** The thing under the pointer changed (null = nothing). */
  hover: (pick: PickResult | null) => void;
  /** A left click without dragging; the pick is null when it hit nothing. */
  pick: (pick: PickResult | null, modifiers: Modifiers) => void;
  /** The camera changed (also during a transition). */
  view: (view: ViewState) => void;
  /**
   * The user drags the extrude arrow. `distance` is the new signed length in mm (the value the handle had when the drag started
   * plus the pointer's travel along the arrow's axis). "start" and "end" carry the value at that moment; "move" fires at most once
   * per frame and only when the value changed. While the drag runs the arrow already shows the new value; the host stays
   * the truth: whatever it passes to setExtrudeHandle afterwards replaces it. The camera never orbits during such a drag.
   */
  extrudeHandle: (distance: number, phase: "start" | "move" | "end") => void;
}

export interface FrameStats {
  /** Number of frames measured. */
  frames: number;
  /** Frame-to-frame time in ms while frames were requested back to back. */
  meanMs: number;
  p95Ms: number;
  maxMs: number;
  /** Mean CPU time of one render call (recording and submitting), ms. */
  meanCpuMs: number;
  /** Worst CPU time of one frame's draw (grid update and render call), ms. */
  maxCpuMs: number;
}

export interface Viewport {
  readonly backend: BackendInfo;
  readonly canvas: HTMLCanvasElement;
  /** Number of frames drawn since creation (stays constant while nothing changes: rendering is on demand). */
  readonly renderCount: number;

  setStyle(style: ViewportStyle): void;
  setNavigationPreset(preset: NavigationPreset): void;
  /** Which way the mouse wheel zooms (a pinch is not affected). */
  setWheelZoomDirection(direction: WheelZoomDirection): void;
  setReducedMotion(mode: boolean | "auto"): void;

  // content
  setBodies(bodies: readonly BodyData[]): void;
  setSketches(sketches: readonly SketchData[]): void;
  /**
   * The preview of a command: bodies drawn translucent in the preview style (never pickable, never hiding what is picked
   * behind them), sketches as rubber bands. Replacing it frees the previous preview's GPU memory; it can be called at typing speed.
   */
  setPreview(preview: PreviewData | null): void;
  /**
   * The closed regions that can be picked as a profile (null or empty = none). Drawn as flat fills on their sketch planes
   * and pickable while "profile" is an allowed pick kind (setPickKinds). Hover and selection use the existing hover and selection
   * API with `{ kind: "profile", sketchId, regionId }`; a profile that is not in the list any more drops out of the selection.
   */
  setProfiles(profiles: readonly ProfileData[] | null): void;
  /** The drag arrow of the extrude command (null = none). Emits the `extrudeHandle` event while the user drags it. */
  setExtrudeHandle(handle: ExtrudeHandle | null): void;
  setGridVisible(visible: boolean): void;
  setOriginVisible(visible: boolean): void;
  /** Shows the three origin planes; they can be hovered and picked only while shown ("choose a sketch plane"). */
  setOriginPlanesVisible(visible: boolean): void;
  setHiddenEdgesVisible(visible: boolean): void;
  /** Which kinds of things picking may return (null = all). */
  setPickKinds(kinds: readonly PickKind[] | null): void;
  /** Bounds of the content: bodies, sketches and preview. */
  contentBounds(): Bounds;

  // camera
  getView(): ViewState;
  setView(view: ViewState, animate?: boolean): void;
  /** The standard view looking from this axis end; a second call from there shows the opposite side. */
  alignToAxis(key: AxisKey, animate?: boolean): void;
  /** Where the camera is heading: the end of a running transition, otherwise the current view. */
  getTargetView(): ViewState;
  /** A quarter turn about the vertical axis, chained from the end of a running transition. Does nothing in a free view. */
  turnView(direction: TurnDirection, animate?: boolean): void;
  /** Tips to the neighbouring standard view in that screen direction, chained like turnView. Does nothing in a free view. */
  tipView(direction: TipDirection, animate?: boolean): void;
  showStandardView(name: StandardViewName, animate?: boolean): void;
  /** Start view (front, right, above) fitted to everything. */
  goHome(animate?: boolean): void;
  fitAll(animate?: boolean): void;
  /** Frames the selection; with an empty selection it does nothing and returns false. */
  zoomToSelection(animate?: boolean): boolean;
  /** Same effect as a drag of the mouse by these CSS pixels. */
  orbitBy(dxPx: number, dyPx: number): void;
  panBy(dxPx: number, dyPx: number): void;
  /** factor < 1 zooms in towards the given client point (or the view centre). */
  zoomBy(factor: number, clientX?: number, clientY?: number): void;
  /** The point orbiting turns around; null = the view target (the centre of the view). */
  setOrbitPivot(point: Vec3 | null): void;
  /** Resolves when the camera has stopped moving and the frame after the last change has been drawn. */
  whenIdle(): Promise<void>;

  // picking and selection
  pick(clientX: number, clientY: number): PickResult | null;
  /** Where the pointer's ray meets a plane (an origin plane or any frame); null when it points away or is parallel. */
  pointOnPlane(clientX: number, clientY: number, plane: PlaneId | PlaneFrame): PlanePoint | null;
  worldToClient(p: Vec3): { x: number; y: number; depth: number } | null;
  setSelection(refs: readonly EntityRef[]): void;
  getSelection(): readonly EntityRef[];
  setHover(ref: EntityRef | null): void;
  getHover(): EntityRef | null;

  on<E extends keyof ViewportEvents>(event: E, listener: ViewportEvents[E]): () => void;

  /** The sketch rendering layer: the sketch in edit mode with highlights, dimensions, hover and tool previews. */
  sketchLayer(): SketchLayer;

  requestRender(): void;
  /** What the renderer holds right now: geometries, textures and the bytes of vertex and index buffers (for tests that watch for leaks). */
  resourceStats(): { geometries: number; textures: number; bufferBytes: number };
  frameStats(): FrameStats;
  resetFrameStats(): void;
  /** Takes the canvas off the page and frees every GPU resource, listener and observer. */
  dispose(): void;
}
