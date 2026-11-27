// The Viewport on three.js's WebGPURenderer: WebGPU when the renderer offers it, otherwise its WebGL2 backend, MSAA 4x.
// Renders on demand: a frame is drawn only when something changed or moves, never in
// an idle loop. All colours, weights and dashes come from the ViewportStyle.
import * as THREE from "three/webgpu";
import {
  cameraBasis, DEFAULT_FOV_Y, defaultView, easeInOutCubic, fitBounds, focalPlanePoint, homeView, interpolateView,
  orbitByPixels, panByPixels, pixelsPerWorld, screenRay, viewAfterAxisClick, viewAfterTip, viewAfterTurn, viewFromAxis, viewsAreEqual, worldToScreen, zoomAbout,
  axisOfViewName, type AxisKey, type Lens, type StandardViewName, type TipDirection, type TurnDirection, type ViewState,
} from "./camera.ts";
import {
  bodyBounds, bodyEdgeSegments, buildFaceIndex, copyTriangles, originPlaneFrame, planeNormal, planeToWorld, segmentBounds,
  segmentsOfOwner, sketchSegments, trianglesBounds, validateBody, type SegmentBuffers,
} from "./geometry.ts";
import { boundsCenter, boundsRadius, distance, dot, emptyBounds, expandBounds, isEmptyBounds, unionBounds, type Bounds, type Vec3 } from "./math.ts";
import { classifyPointerDrag, classifyWheel, wheelDeltaInPixels, wheelZoomFactor, zoomEaseStep, type Modifiers, type NavigationPreset, type WheelZoomDirection } from "./navigation.ts";
import { choosePick, nearestSegment, rayHitsBounds, rayMesh, rayPlane, type PickCandidate } from "./picking.ts";
import { axisParameterAtPointer, distanceAfterDrag, hitHandle } from "./extrude-handle.ts";
import { originPlaneHalf } from "./origin-planes.ts";
import { axisDirections, axisFade, AXIS_HOVER_MIN_FADE, nearestAxis, type AxisIndex } from "./axis-style.ts";
import { linearAlpha } from "./sketch/band-colour.ts";
import { ExtrudeHandleView } from "./three-extrude-handle.ts";
import { ProfileLayer, profileKey } from "./three-profiles.ts";
import type { LineKind, ViewportStyle } from "./style.ts";
import { GridView } from "./three-grid.ts";
import { LineLayer } from "./three-lines.ts";
import { ThreeSketchLayer } from "./sketch/three-sketch-layer.ts";
import type { SketchLayer } from "./sketch/types.ts";
import {
  planeIds, refKey, refsEqual, type BackendInfo, type BodyData, type EntityRef, type FrameStats, type PickKind, type PickResult,
  type ExtrudeHandle, type PlaneFrame, type PlaneId, type PlanePoint, type PreviewData, type ProfileData, type SketchData, type Viewport, type ViewportEvents, type ViewportOptions,
} from "./types.ts";

const TRANSITION_MS = 240;
/** A click is a press and release that moved less than this many CSS pixels. */
const CLICK_SLOP_PX = 4;
const EDGE_PICK_PX = 5;
const SKETCH_PICK_PX = 6;
/** Frame intervals longer than this are idle gaps, not frame times. */
const IDLE_GAP_MS = 250;
const MAX_FRAME_SAMPLES = 1200;

// Render order of the layers: solids first, then the lines drawn over them, then the highlights.
const ORDER = { hiddenEdges: 1, bodyEdges: 2, sketch: 20, preview: 21, highlight: 30 } as const;

interface BodyView {
  data: BodyData;
  geometry: THREE.BufferGeometry;
  mesh: THREE.Mesh;
  ownMaterial: THREE.Material | null;
  faceIndex: Map<number, Uint32Array>;
  bounds: Bounds;
  edges: SegmentBuffers | null;
  edgeLayer: LineLayer | null;
  hiddenLayer: LineLayer | null;
}

interface SketchView {
  data: SketchData;
  layers: { kind: LineKind; buffers: SegmentBuffers; layer: LineLayer }[];
  bounds: Bounds;
}

interface PlaneView {
  id: PlaneId;
  frame: PlaneFrame;
  fill: THREE.Mesh;
  fillMaterial: THREE.MeshBasicMaterial;
  outline: LineLayer;
}

async function describeAdapter(): Promise<string | null> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return null;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    const i = adapter.info;
    return [i.vendor, i.architecture, i.description].filter((s) => s !== "").join(" ") || "unknown adapter";
  } catch {
    return null;
  }
}

export async function createThreeViewport(host: HTMLElement, options: ViewportOptions): Promise<Viewport> {
  const t0 = performance.now();
  const requested = options.renderer ?? "auto";
  const canvas = document.createElement("canvas");
  canvas.setAttribute("data-viewport-canvas", "");
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.touchAction = "none";
  host.appendChild(canvas);
  try {
    const adapterPromise = requested === "auto" ? describeAdapter() : Promise.resolve(null);
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: requested === "webgl2" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    await renderer.init();
    const backendObject = renderer.backend as unknown as { isWebGPUBackend?: boolean; gl?: WebGL2RenderingContext };
    const backend = backendObject.isWebGPUBackend ? "WebGPU" : "WebGL2";
    let webglRenderer: string | null = null;
    if (backend === "WebGL2" && backendObject.gl) {
      const gl = backendObject.gl;
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      webglRenderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    }
    const info: BackendInfo = {
      backend,
      requested,
      forcedWebGL2: requested === "webgl2",
      msaaSamples: renderer.samples,
      adapter: backend === "WebGPU" ? await adapterPromise : null,
      webglRenderer,
      initMs: performance.now() - t0,
    };
    return new ThreeViewport(host, canvas, renderer, info, options);
  } catch (error) {
    canvas.remove();
    throw error;
  }
}

class ThreeViewport implements Viewport {
  renderCount = 0;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
  private readonly grid = new GridView();
  private readonly bodyGroup = new THREE.Group();
  private readonly previewGroup = new THREE.Group();
  private readonly sketchGroup = new THREE.Group();
  private readonly planeGroup = new THREE.Group();
  private readonly highlightGroup = new THREE.Group();
  /** The sketch rendering layer (U2a) draws into this group. */
  private readonly sketchLayerGroup = new THREE.Group();
  private readonly sketchLayerImpl: ThreeSketchLayer;
  /** The pickable profiles of the extrude command (flat fills) and the drag arrow. */
  private readonly profileLayer = new ProfileLayer();
  private readonly handleView = new ExtrudeHandleView();
  private readonly bodyMaterial: THREE.MeshStandardMaterial;
  private readonly previewMaterial: THREE.MeshStandardMaterial;
  private readonly hemisphere: THREE.HemisphereLight;
  private readonly keyLight: THREE.DirectionalLight;

  private style: ViewportStyle;
  private preset: NavigationPreset;
  private wheelZoomDirection: WheelZoomDirection;
  private reducedMotion: boolean | "auto";
  private view: ViewState = defaultView();
  private lens: Lens = { fovY: DEFAULT_FOV_Y, width: 1, height: 1 };
  private orbitPivot: Vec3 | null = null;
  private animation: { from: ViewState; to: ViewState; start: number; duration: number } | null = null;
  /** Wheel zoom that is still to be applied: the logarithm of the distance factor left, about the world point under the pointer. */
  private zoomEase: { anchor: Vec3; pendingLn: number; lastAt: number } | null = null;

  private bodies: BodyView[] = [];
  private sketches: SketchView[] = [];
  private previewBodies: BodyView[] = [];
  private previewSketches: SketchView[] = [];
  private planes: PlaneView[] = [];
  private highlightDisposables: { dispose(): void }[] = [];
  private originPlanesVisible = false;
  private hiddenEdgesVisible = false;
  private pickKinds: ReadonlySet<PickKind> | null = null;

  private selection: EntityRef[] = [];
  private hover: EntityRef | null = null;
  private highlightDirty = false;

  private rafId = 0;
  private disposed = false;
  private fitted = false;
  /** True until the user or the host moves the camera: new content then fits the view by itself (opening a document). */
  private autoFit = true;
  private readonly listeners: { [E in keyof ViewportEvents]: Set<ViewportEvents[E]> } = { hover: new Set(), pick: new Set(), view: new Set(), extrudeHandle: new Set() };
  private idleWaiters: (() => void)[] = [];
  private frameTimes: number[] = [];
  private cpuTimes: number[] = [];
  private lastFrameAt = 0;

  private drag: { pointerId: number; action: "orbit" | "pan"; x: number; y: number } | null = null;
  /** The extrude arrow is being dragged: the distance and the axis position at the grab, the last value sent and the newest pointer position. */
  private handleDrag: { pointerId: number; startDistance: number; grab: number; last: number; pending: { x: number; y: number } | null; raf: number } | null = null;
  private press: { pointerId: number; x: number; y: number; moved: boolean } | null = null;
  private hoverPending: { x: number; y: number } | null = null;
  private hoverRaf = 0;
  private readonly resizeObserver: ResizeObserver;
  private readonly abort = new AbortController();

  private readonly host: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGPURenderer;
  readonly backend: BackendInfo;

  constructor(host: HTMLElement, canvas: HTMLCanvasElement, renderer: THREE.WebGPURenderer, backend: BackendInfo, options: ViewportOptions) {
    this.host = host;
    this.canvas = canvas;
    this.renderer = renderer;
    this.backend = backend;
    this.style = options.style;
    this.preset = options.navigationPreset ?? "mouse";
    this.wheelZoomDirection = options.wheelZoomDirection ?? "down-out";
    this.reducedMotion = options.reducedMotion ?? "auto";

    // Neutral lights: only intensities, the colours of the surfaces come from the style.
    this.hemisphere = new THREE.HemisphereLight(new THREE.Color().setScalar(1), new THREE.Color().setScalar(0.45), 1.5);
    this.keyLight = new THREE.DirectionalLight(new THREE.Color().setScalar(1), 1.6);
    this.keyLight.position.set(-0.5, 0.35, 1); // in camera space: from the upper left, the lamp travels with the camera
    this.keyLight.target.position.set(0, 0, -1);
    this.camera.add(this.keyLight, this.keyLight.target);
    this.scene.add(this.hemisphere, this.camera);
    this.scene.add(this.bodyGroup, this.previewGroup, this.sketchGroup, this.planeGroup, this.highlightGroup, this.grid.group, this.sketchLayerGroup, this.profileLayer.group, this.handleView.group);
    this.sketchLayerImpl = new ThreeSketchLayer({
      group: this.sketchLayerGroup,
      getView: () => this.view,
      getLens: () => this.lens,
      getStyle: () => this.style,
      requestRender: () => this.requestRender(),
      moveTo: (view, animate) => this.moveTo(view, animate),
      setGridFrame: (frame) => this.grid.setFrame(frame),
    });

    this.bodyMaterial = this.makeBodyMaterial(this.style.body.left, false);
    this.previewMaterial = this.makeBodyMaterial(this.style.preview.fill, true);

    const opts = { signal: this.abort.signal };
    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e), opts);
    canvas.addEventListener("pointermove", (e) => this.onPointerMove(e), opts);
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e), opts);
    canvas.addEventListener("pointercancel", (e) => this.endPointer(e), opts);
    canvas.addEventListener("pointerleave", () => this.onPointerLeave(), opts);
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false, signal: this.abort.signal });
    // Without this the middle button starts the browser's auto-scroll.
    canvas.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); }, opts);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault(), opts);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.applyStyle();
    this.resize();
  }

  // --- style ----------------------------------------------------------------------------------------------------

  private makeBodyMaterial(color: string, preview: boolean): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color,
      roughness: 0.62,
      metalness: 0,
      side: THREE.DoubleSide,
      transparent: preview,
      opacity: preview ? 0.55 : 1,
      depthWrite: !preview,
      // A body is pushed back a little so the edge lines lying on it are not eaten by it. A preview does not write depth and its
      // edges are lines that are not hidden by it, but its cap often lies exactly on a face of a body (extruding from a face):
      // it is pulled forward so that it wins over that face on every pixel instead of flickering with it.
      polygonOffset: true,
      polygonOffsetFactor: preview ? -2 : 1,
      polygonOffsetUnits: preview ? -2 : 1,
    });
  }

  setStyle(style: ViewportStyle): void {
    this.style = style;
    this.applyStyle();
    this.requestRender();
  }

  private applyStyle(): void {
    const s = this.style;
    this.scene.background = new THREE.Color(s.background);
    this.bodyMaterial.color.set(s.body.left);
    this.previewMaterial.color.set(s.preview.fill);
    this.previewMaterial.opacity = linearAlpha(s.preview.fill, s.background, s.preview.fillOpacity);
    for (const b of this.bodies) {
      b.edgeLayer?.applyStyle(s.lines.bodyEdge);
      b.hiddenLayer?.applyStyle(s.lines.hiddenEdge);
    }
    for (const b of this.previewBodies) b.edgeLayer?.applyStyle(s.preview.edge);
    this.profileLayer.setStyle(s);
    this.handleView.setStyle(s);
    for (const sk of [...this.sketches, ...this.previewSketches]) for (const l of sk.layers) l.layer.applyStyle(s.lines[l.kind]);
    this.grid.invalidate();
    this.rebuildPlanes();
    this.highlightDirty = true;
    this.sketchLayerImpl?.styleChanged();
  }

  setNavigationPreset(preset: NavigationPreset): void {
    this.preset = preset;
  }

  setWheelZoomDirection(direction: WheelZoomDirection): void {
    this.wheelZoomDirection = direction;
  }

  setReducedMotion(mode: boolean | "auto"): void {
    this.reducedMotion = mode;
  }

  private motionReduced(): boolean {
    if (this.reducedMotion !== "auto") return this.reducedMotion;
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // --- content --------------------------------------------------------------------------------------------------

  setBodies(bodies: readonly BodyData[]): void {
    this.disposeBodies(this.bodies);
    this.bodies = bodies.map((b) => this.makeBody(b, this.bodyGroup, false));
    this.afterContentChange();
  }

  setSketches(sketches: readonly SketchData[]): void {
    this.disposeSketches(this.sketches);
    this.sketches = sketches.map((s) => this.makeSketch(s, this.sketchGroup, ORDER.sketch));
    this.afterContentChange();
  }

  setProfiles(profiles: readonly ProfileData[] | null): void {
    this.profileLayer.set(profiles ?? []);
    // The profiles lie on sketches that are already part of the content: the camera stays where it is.
    this.afterContentChange(false);
  }

  setExtrudeHandle(handle: ExtrudeHandle | null): void {
    this.handleView.setHandle(handle);
    // An arrow that is gone (or not valid) ends a drag without an event: the host asked for it.
    if (this.handleDrag && !this.handleView.current) this.cancelHandleDrag();
    if (!this.handleView.current) this.canvas.style.cursor = "";
    this.requestRender();
  }

  resourceStats(): { geometries: number; textures: number; bufferBytes: number } {
    const m = this.renderer.info.memory as { geometries: number; textures: number; attributesSize?: number; indexAttributesSize?: number };
    return { geometries: m.geometries, textures: m.textures, bufferBytes: (m.attributesSize ?? 0) + (m.indexAttributesSize ?? 0) };
  }

  setPreview(preview: PreviewData | null): void {
    this.disposeBodies(this.previewBodies);
    this.disposeSketches(this.previewSketches);
    this.previewBodies = (preview?.bodies ?? []).map((b) => this.makeBody(b, this.previewGroup, true));
    this.previewSketches = (preview?.sketches ?? []).map((s) => this.makeSketch(s, this.previewGroup, ORDER.preview));
    this.requestRender();
  }

  private makeBody(data: BodyData, group: THREE.Group, preview: boolean): BodyView {
    const problem = validateBody(data);
    if (problem) throw new Error(problem);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    const bounds = bodyBounds(data);
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(...bounds.min), new THREE.Vector3(...bounds.max));
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
    let material: THREE.Material = preview ? this.previewMaterial : this.bodyMaterial;
    let ownMaterial: THREE.MeshStandardMaterial | null = null;
    // A preview is drawn in the preview style whatever colour the body has: that is what tells it from the real bodies.
    if (data.color && !preview) {
      ownMaterial = this.makeBodyMaterial(data.color, preview);
      material = ownMaterial;
    }
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);
    const edges = data.edges && data.edges.ids.length > 0 ? bodyEdgeSegments(data.edges) : null;
    let edgeLayer: LineLayer | null = null;
    let hiddenLayer: LineLayer | null = null;
    if (edges && edges.segmentCount > 0) {
      const layerGeometry = { positions: edges.positions, distanceStart: edges.distanceStart, distanceEnd: edges.distanceEnd };
      edgeLayer = new LineLayer(layerGeometry, { renderOrder: ORDER.bodyEdges });
      edgeLayer.applyStyle(preview ? this.style.preview.edge : this.style.lines.bodyEdge);
      group.add(edgeLayer.group);
      // A translucent preview shows its hidden edges through itself anyway; only real bodies get a layer for them.
      if (!preview) {
        hiddenLayer = new LineLayer(layerGeometry, { renderOrder: ORDER.hiddenEdges, behindSolids: true });
        hiddenLayer.applyStyle(this.style.lines.hiddenEdge);
        hiddenLayer.visible = this.hiddenEdgesVisible;
        group.add(hiddenLayer.group);
      }
    }
    return { data, geometry, mesh, ownMaterial, faceIndex: buildFaceIndex(data.faceIds), bounds, edges, edgeLayer, hiddenLayer };
  }

  private makeSketch(data: SketchData, group: THREE.Group, order: number): SketchView {
    const layers: SketchView["layers"] = [];
    let bounds = emptyBounds();
    for (const [kind, buffers] of sketchSegments(data)) {
      if (buffers.segmentCount === 0) continue;
      const layer = new LineLayer({ positions: buffers.positions, distanceStart: buffers.distanceStart, distanceEnd: buffers.distanceEnd }, { renderOrder: order });
      layer.applyStyle(this.style.lines[kind]);
      group.add(layer.group);
      layers.push({ kind, buffers, layer });
      bounds = unionBounds(bounds, segmentBounds(buffers));
    }
    return { data, layers, bounds };
  }

  private disposeBodies(list: BodyView[]): void {
    for (const b of list) {
      b.mesh.parent?.remove(b.mesh);
      b.geometry.dispose();
      b.ownMaterial?.dispose();
      for (const layer of [b.edgeLayer, b.hiddenLayer]) {
        if (!layer) continue;
        layer.group.parent?.remove(layer.group);
        layer.dispose();
      }
    }
    list.length = 0;
  }

  private disposeSketches(list: SketchView[]): void {
    for (const s of list) {
      for (const l of s.layers) {
        l.layer.group.parent?.remove(l.layer.group);
        l.layer.dispose();
      }
    }
    list.length = 0;
  }

  private afterContentChange(refit = true): void {
    // Selected things may have gone; the planes follow the size of the content.
    this.selection = this.selection.filter((r) => this.refExists(r));
    if (this.hover && !this.refExists(this.hover)) this.hover = null;
    this.rebuildPlanes();
    this.highlightDirty = true;
    if (refit && this.autoFit && this.fitted) {
      this.view = this.fittedView(this.view);
      for (const l of this.listeners.view) l(this.getView());
    }
    this.requestRender();
  }

  private refExists(ref: EntityRef): boolean {
    switch (ref.kind) {
      case "plane": return true;
      case "face": return this.bodies.some((b) => b.data.id === ref.bodyId && b.faceIndex.has(ref.faceId));
      case "edge": return this.bodies.some((b) => b.data.id === ref.bodyId && b.edges?.owners.includes(ref.edgeId));
      case "sketch": return this.sketches.some((s) => s.data.id === ref.sketchId && s.data.entities.some((e) => e.id === ref.entityId));
      case "profile": return this.profileLayer.has(ref.sketchId, ref.regionId);
    }
  }

  setGridVisible(visible: boolean): void {
    this.grid.gridVisible = visible;
    this.grid.setAxisHover(null);
    this.requestRender();
  }

  setOriginVisible(visible: boolean): void {
    this.grid.originVisible = visible;
    this.grid.setAxisHover(null);
    this.requestRender();
  }

  setOriginPlanesVisible(visible: boolean): void {
    this.originPlanesVisible = visible;
    this.rebuildPlanes();
    if (!visible) {
      const drop = (r: EntityRef | null) => r?.kind === "plane";
      this.selection = this.selection.filter((r) => !drop(r));
      if (drop(this.hover)) this.hover = null;
    }
    this.highlightDirty = true;
    this.requestRender();
  }

  setHiddenEdgesVisible(visible: boolean): void {
    this.hiddenEdgesVisible = visible;
    for (const b of this.bodies) if (b.hiddenLayer) b.hiddenLayer.visible = visible;
    this.requestRender();
  }

  setPickKinds(kinds: readonly PickKind[] | null): void {
    this.pickKinds = kinds ? new Set(kinds) : null;
  }

  private allowed(kind: PickKind): boolean {
    return this.pickKinds === null || this.pickKinds.has(kind);
  }

  contentBounds(): Bounds {
    let b = emptyBounds();
    for (const x of [...this.bodies, ...this.sketches, ...this.previewBodies, ...this.previewSketches]) b = unionBounds(b, x.bounds);
    return unionBounds(unionBounds(b, this.profileLayer.bounds()), this.sketchLayerImpl.bounds());
  }

  // --- origin planes --------------------------------------------------------------------------------------------

  /**
   * Half size of the origin planes in mm: a small marker around the origin whose size on the screen is constant, a sixth of the
   * view's shorter side (origin-planes.ts). It follows the zoom and the window, never the content, so the planes cannot cover the model.
   */
  private planeHalf(): number {
    return originPlaneHalf(this.view, this.lens);
  }

  /** The planes are built with edges of 2 units and scaled to their size now, before every frame: no geometry is rebuilt by a zoom. */
  private scalePlanes(): void {
    if (this.planes.length === 0) return;
    const h = this.planeHalf();
    for (const p of this.planes) {
      p.fill.scale.setScalar(h);
      p.outline.group.scale.setScalar(h);
    }
  }

  private rebuildPlanes(): void {
    for (const p of this.planes) {
      this.planeGroup.remove(p.fill);
      p.fill.geometry.dispose();
      p.fillMaterial.dispose();
      this.planeGroup.remove(p.outline.group);
      p.outline.dispose();
    }
    this.planes = [];
    if (!this.originPlanesVisible) return;
    for (const id of planeIds) {
      const frame = originPlaneFrame(id);
      const corners = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map((c) => planeToWorld(frame, c));
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(corners.flat()), 3));
      geometry.setIndex([0, 1, 2, 0, 2, 3]);
      const fillMaterial = new THREE.MeshBasicMaterial({ color: this.style.lines.plane.color, transparent: true, opacity: this.style.opacity.plane, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      const fill = new THREE.Mesh(geometry, fillMaterial);
      // Below everything else that is drawn translucent (face highlights, profiles, sketch lines): content lies over the planes.
      fill.renderOrder = 1;
      fill.frustumCulled = false;
      const loop = [...corners, corners[0]!];
      const positions = new Float32Array(4 * 6);
      for (let i = 0; i < 4; i++) { positions.set(loop[i]!, i * 6); positions.set(loop[i + 1]!, i * 6 + 3); }
      const outline = new LineLayer({ positions }, { renderOrder: 2 });
      const view: PlaneView = { id, frame, fill, fillMaterial, outline };
      this.planes.push(view);
      this.planeGroup.add(fill, outline.group);
      this.applyPlaneState(view);
    }
    this.scalePlanes();
  }

  private applyPlaneState(p: PlaneView): void {
    const selected = this.selection.some((r) => r.kind === "plane" && r.plane === p.id);
    const hovered = this.hover?.kind === "plane" && this.hover.plane === p.id;
    const kind: LineKind = selected ? "selection" : hovered ? "hover" : "plane";
    const opacity = selected ? this.style.opacity.selection : hovered ? this.style.opacity.hover : this.style.opacity.plane;
    p.fillMaterial.color.set(this.style.lines[kind].color);
    p.fillMaterial.opacity = opacity;
    p.outline.applyStyle(this.style.lines[kind]);
  }

  // --- camera ---------------------------------------------------------------------------------------------------

  getView(): ViewState {
    return { ...this.view, target: [...this.view.target] };
  }

  setView(view: ViewState, animate = true): void {
    this.moveTo(view, animate);
  }

  private moveTo(target: ViewState, animate: boolean): void {
    this.autoFit = false;
    this.zoomEase = null;
    if (!animate || this.motionReduced() || viewsAreEqual(this.view, target)) {
      this.animation = null;
      this.applyView(target);
      return;
    }
    this.animation = { from: this.view, to: target, start: performance.now(), duration: TRANSITION_MS };
    this.requestRender();
  }

  private applyView(view: ViewState): void {
    this.view = view;
    this.sketchLayerImpl.cameraChanged();
    for (const l of this.listeners.view) l(this.getView());
    this.requestRender();
  }

  alignToAxis(key: AxisKey, animate = true): void {
    this.moveTo(viewAfterAxisClick(this.animation?.to ?? this.view, key), animate);
  }

  getTargetView(): ViewState {
    const v = this.animation?.to ?? this.view;
    return { ...v, target: [...v.target] };
  }

  turnView(direction: TurnDirection, animate = true): void {
    const next = viewAfterTurn(this.animation?.to ?? this.view, direction);
    if (next) this.moveTo(next, animate);
  }

  tipView(direction: TipDirection, animate = true): void {
    const next = viewAfterTip(this.animation?.to ?? this.view, direction);
    if (next) this.moveTo(next, animate);
  }

  showStandardView(name: StandardViewName, animate = true): void {
    this.moveTo(viewFromAxis(this.animation?.to ?? this.view, axisOfViewName[name]), animate);
  }

  goHome(animate = true): void {
    this.moveTo(this.fittedView(homeView(this.animation?.to ?? this.view)), animate);
  }

  fitAll(animate = true): void {
    this.moveTo(this.fittedView(this.animation?.to ?? this.view), animate);
  }

  /** The given view moved and zoomed so that the whole content is shown (an empty scene shows 200 mm around the origin). */
  private fittedView(view: ViewState): ViewState {
    let bounds = this.contentBounds();
    if (isEmptyBounds(bounds)) bounds = { min: [-100, -100, -100], max: [100, 100, 100] };
    return fitBounds(view, this.lens, bounds);
  }

  zoomToSelection(animate = true): boolean {
    let bounds = emptyBounds();
    for (const ref of this.selection) bounds = unionBounds(bounds, this.boundsOfRef(ref));
    if (isEmptyBounds(bounds)) return false;
    this.moveTo(fitBounds(this.animation?.to ?? this.view, this.lens, bounds, 1.25), animate);
    return true;
  }

  private boundsOfRef(ref: EntityRef): Bounds {
    switch (ref.kind) {
      case "plane": {
        const h = this.planeHalf();
        const frame = originPlaneFrame(ref.plane);
        let b = emptyBounds();
        for (const c of [[-h, -h], [h, h]] as const) b = expandBounds(b, planeToWorld(frame, c));
        return b;
      }
      case "face": {
        const body = this.bodies.find((x) => x.data.id === ref.bodyId);
        const tris = body?.faceIndex.get(ref.faceId);
        return body && tris ? trianglesBounds(body.data, tris) : emptyBounds();
      }
      case "edge": {
        const body = this.bodies.find((x) => x.data.id === ref.bodyId);
        return body?.edges ? this.ownerBounds(body.edges, ref.edgeId) : emptyBounds();
      }
      case "sketch": {
        const sketch = this.sketches.find((x) => x.data.id === ref.sketchId);
        let b = emptyBounds();
        for (const l of sketch?.layers ?? []) b = unionBounds(b, this.ownerBounds(l.buffers, ref.entityId));
        return b;
      }
      case "profile": return this.profileLayer.boundsOf(ref.sketchId, ref.regionId);
    }
  }

  private ownerBounds(buffers: SegmentBuffers, owner: number): Bounds {
    let b = emptyBounds();
    const p = segmentsOfOwner(buffers, owner);
    for (let i = 0; i + 2 < p.length; i += 3) b = expandBounds(b, [p[i]!, p[i + 1]!, p[i + 2]!]);
    return b;
  }

  setOrbitPivot(point: Vec3 | null): void {
    this.orbitPivot = point;
  }

  orbitBy(dxPx: number, dyPx: number): void {
    this.autoFit = false;
    this.animation = null;
    const next = orbitByPixels(this.view, dxPx, dyPx, this.orbitPivot ?? undefined);
    this.applyView(next);
  }

  panBy(dxPx: number, dyPx: number): void {
    this.autoFit = false;
    this.animation = null;
    this.applyView(panByPixels(this.view, this.lens, dxPx, dyPx));
  }

  zoomBy(factor: number, clientX?: number, clientY?: number): void {
    this.autoFit = false;
    this.animation = null;
    this.zoomEase = null;
    this.applyView(zoomAbout(this.view, this.zoomAnchor(clientX, clientY), factor));
  }

  /** The world point a zoom goes towards: the surface under the pointer; where there is none, the point at the target's depth. */
  private zoomAnchor(clientX?: number, clientY?: number): Vec3 {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX === undefined ? this.lens.width / 2 : clientX - rect.left;
    const y = clientY === undefined ? this.lens.height / 2 : clientY - rect.top;
    const basis = cameraBasis(this.view);
    const ray = screenRay(this.view, this.lens, x, y, basis);
    const hit = this.nearestSolid(ray);
    return hit ? [ray.origin[0] + ray.dir[0] * hit.t, ray.origin[1] + ray.dir[1] * hit.t, ray.origin[2] + ray.dir[2] * hit.t] : focalPlanePoint(this.view, ray, basis);
  }

  /**
   * A zoom that is eased in over the next frames (a mouse-wheel notch): the factor is added to what is still pending, so notches
   * in quick succession accumulate, and the frames apply it bit by bit (see zoomEaseStep). The point under the pointer is looked
   * up once per notch, not per frame.
   */
  private zoomEaseBy(factor: number, clientX: number, clientY: number): void {
    this.autoFit = false;
    this.animation = null;
    const anchor = this.zoomAnchor(clientX, clientY);
    const ease = this.zoomEase ?? { anchor, pendingLn: 0, lastAt: 0 };
    ease.anchor = anchor;
    ease.pendingLn += Math.log(factor);
    this.zoomEase = ease;
    this.requestRender();
  }

  private stepZoomEase(now: number): void {
    const ease = this.zoomEase;
    if (!ease) return;
    const first = ease.lastAt === 0;
    const sinceLast = now - ease.lastAt;
    ease.lastAt = now;
    // The first frame of an easing has no earlier frame to measure from: it takes a nominal frame of 8 ms (a 120 Hz screen).
    const step = zoomEaseStep(ease.pendingLn, first || sinceLast <= 0 ? 8 : sinceLast);
    ease.pendingLn = step.remaining;
    if (step.remaining === 0) this.zoomEase = null;
    if (step.apply === 0) return;
    this.view = zoomAbout(this.view, ease.anchor, Math.exp(step.apply));
    this.sketchLayerImpl.cameraChanged();
    for (const l of this.listeners.view) l(this.getView());
  }

  // --- frame loop -----------------------------------------------------------------------------------------------

  sketchLayer(): SketchLayer {
    return this.sketchLayerImpl;
  }

  requestRender(): void {
    if (this.disposed || this.rafId !== 0) return;
    this.rafId = requestAnimationFrame((now) => this.frame(now));
  }

  whenIdle(): Promise<void> {
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
      this.requestRender();
    });
  }

  private frame(now: number): void {
    this.rafId = 0;
    if (this.disposed) return;
    this.stepZoomEase(now);
    if (this.animation) {
      const a = this.animation;
      const t = Math.min(1, (performance.now() - a.start) / a.duration);
      this.view = interpolateView(a.from, a.to, easeInOutCubic(t));
      this.sketchLayerImpl.cameraChanged();
      for (const l of this.listeners.view) l(this.getView());
      if (t >= 1) {
        this.view = a.to;
        this.animation = null;
      }
    }
    this.runHoverPick();
    if (this.highlightDirty) this.rebuildHighlights();
    this.sketchLayerImpl.beforeRender();

    const t0 = performance.now();
    this.draw();
    const cpu = performance.now() - t0;
    if (this.lastFrameAt > 0 && now - this.lastFrameAt < IDLE_GAP_MS) {
      this.frameTimes.push(now - this.lastFrameAt);
      this.cpuTimes.push(cpu);
      if (this.frameTimes.length > MAX_FRAME_SAMPLES) {
        this.frameTimes.shift();
        this.cpuTimes.shift();
      }
    }
    this.lastFrameAt = now;

    if (this.animation || this.zoomEase) {
      this.requestRender();
    } else if (this.idleWaiters.length > 0) {
      const waiters = this.idleWaiters.splice(0);
      // One more animation frame, so the frame just drawn has been handed to the screen.
      requestAnimationFrame(() => { for (const w of waiters) w(); });
    }
  }

  private draw(): void {
    const basis = cameraBasis(this.view);
    const cam = this.camera;
    cam.fov = (this.lens.fovY * 180) / Math.PI;
    cam.aspect = this.lens.width / this.lens.height;
    cam.position.set(...basis.eye);
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...basis.right), new THREE.Vector3(...basis.up), new THREE.Vector3(-basis.forward[0], -basis.forward[1], -basis.forward[2]));
    cam.quaternion.setFromRotationMatrix(m);

    this.grid.update(this.view, this.lens, this.style, this.renderer.getPixelRatio());
    // Depth range: from just in front of the target distance out to everything that is drawn.
    const bounds = this.contentBounds();
    const content = isEmptyBounds(bounds) ? 0 : distance(basis.eye, boundsCenter(bounds)) + boundsRadius(bounds);
    // The grid fades out completely at its reach from the eye, so the far plane only has to lie just beyond that.
    const far = Math.max(this.view.distance * 4, content * 1.2, this.grid.reach * 1.05);
    cam.far = far;
    cam.near = Math.min(this.view.distance * 0.05, Math.max(far / 40000, 1e-3));
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    this.updateDashScales(basis.eye);
    this.handleView.update(this.view, this.lens);
    this.scalePlanes();
    this.renderer.render(this.scene, cam);
    this.renderCount++;
  }

  private updateDashScales(eye: Vec3): void {
    const scaleFor = (layer: LineLayer) => {
      if (!layer.dashed) return;
      const depth = Math.max(1e-3, distance(eye, [layer.center.x, layer.center.y, layer.center.z]));
      layer.updateDashScale(pixelsPerWorld(this.lens, depth));
    };
    for (const b of [...this.bodies, ...this.previewBodies]) {
      if (b.edgeLayer) scaleFor(b.edgeLayer);
      if (b.hiddenLayer) scaleFor(b.hiddenLayer);
    }
    for (const s of [...this.sketches, ...this.previewSketches]) for (const l of s.layers) scaleFor(l.layer);
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.lens = { fovY: DEFAULT_FOV_Y, width: w, height: h };
    // The first real size decides the start view; later resizes keep the camera.
    if (!this.fitted && this.host.clientWidth > 0 && this.host.clientHeight > 0) {
      this.fitted = true;
      this.view = this.fittedView(this.view);
      for (const l of this.listeners.view) l(this.getView());
    }
    this.sketchLayerImpl.cameraChanged();
    this.requestRender();
  }

  // --- picking --------------------------------------------------------------------------------------------------

  private nearestSolid(ray: ReturnType<typeof screenRay>): { t: number; body: BodyView; triangle: number } | null {
    let best: { t: number; body: BodyView; triangle: number } | null = null;
    for (const body of this.bodies) {
      if (!rayHitsBounds(ray, body.bounds)) continue;
      const hit = rayMesh(ray, body.data.positions, body.data.indices);
      if (hit && (!best || hit.t < best.t)) best = { t: hit.t, body, triangle: hit.triangle };
    }
    return best;
  }

  pick(clientX: number, clientY: number): PickResult | null {
    const rect = this.canvas.getBoundingClientRect();
    return this.pickLocal(clientX - rect.left, clientY - rect.top);
  }

  private pickLocal(x: number, y: number): PickResult | null {
    const basis = cameraBasis(this.view);
    const ray = screenRay(this.view, this.lens, x, y, basis);
    const forward = (t: number) => t * dot(ray.dir, basis.forward);
    const at = (t: number): Vec3 => [ray.origin[0] + ray.dir[0] * t, ray.origin[1] + ray.dir[1] * t, ray.origin[2] + ray.dir[2] * t];

    const solid = this.nearestSolid(ray);
    const solidDepth = solid ? forward(solid.t) : Infinity;
    const cand: { sketch: PickCandidate | null; edge: PickCandidate | null; profile: PickCandidate | null; face: PickCandidate | null; plane: PickCandidate | null } = { sketch: null, edge: null, profile: null, face: null, plane: null };

    if (solid && this.allowed("face")) {
      const faceId = solid.body.data.faceIds[solid.triangle]!;
      cand.face = { ref: { kind: "face", bodyId: solid.body.data.id, faceId }, point: at(solid.t), depth: solidDepth, distancePx: 0 };
    }
    if (this.allowed("edge")) {
      for (const body of this.bodies) {
        if (!body.edges) continue;
        const hit = nearestSegment(this.view, this.lens, body.edges, x, y, EDGE_PICK_PX, basis);
        if (hit && (!cand.edge || hit.distancePx < cand.edge.distancePx)) cand.edge = { ref: { kind: "edge", bodyId: body.data.id, edgeId: hit.owner }, point: hit.point, depth: hit.depth, distancePx: hit.distancePx };
      }
    }
    if (this.allowed("sketch")) {
      for (const sketch of this.sketches) {
        for (const l of sketch.layers) {
          const hit = nearestSegment(this.view, this.lens, l.buffers, x, y, SKETCH_PICK_PX, basis);
          if (hit && (!cand.sketch || hit.distancePx < cand.sketch.distancePx)) cand.sketch = { ref: { kind: "sketch", sketchId: sketch.data.id, entityId: hit.owner }, point: hit.point, depth: hit.depth, distancePx: hit.distancePx };
        }
      }
    }
    if (this.originPlanesVisible && this.allowed("plane")) {
      const h = this.planeHalf();
      for (const p of this.planes) {
        const hit = rayPlane(ray, p.frame.origin, planeNormal(p.frame));
        if (!hit) continue;
        const u = dot([hit.point[0] - p.frame.origin[0], hit.point[1] - p.frame.origin[1], hit.point[2] - p.frame.origin[2]], p.frame.xAxis);
        const v = dot([hit.point[0] - p.frame.origin[0], hit.point[1] - p.frame.origin[1], hit.point[2] - p.frame.origin[2]], p.frame.yAxis);
        if (Math.abs(u) > h || Math.abs(v) > h) continue;
        const depth = forward(hit.t);
        if (!cand.plane || depth < cand.plane.depth) cand.plane = { ref: { kind: "plane", plane: p.id }, point: hit.point, depth, distancePx: 0 };
      }
    }
    const epsilon = Math.max(this.view.distance * 2e-3, 1e-4);
    if (this.profileLayer.count > 0 && this.allowed("profile")) {
      const hit = this.profileLayer.pick(ray, epsilon);
      if (hit) cand.profile = { ref: { kind: "profile", sketchId: hit.sketchId, regionId: hit.regionId }, point: hit.point, depth: forward(hit.t), distancePx: 0 };
    }
    const chosen = choosePick(cand, epsilon, solidDepth);
    return chosen ? { ref: chosen.ref, point: chosen.point, depth: chosen.depth, distancePx: chosen.distancePx } : null;
  }

  pointOnPlane(clientX: number, clientY: number, plane: PlaneId | PlaneFrame): PlanePoint | null {
    const rect = this.canvas.getBoundingClientRect();
    const frame = typeof plane === "string" ? originPlaneFrame(plane) : plane;
    const ray = screenRay(this.view, this.lens, clientX - rect.left, clientY - rect.top);
    const hit = rayPlane(ray, frame.origin, planeNormal(frame));
    if (!hit) return null;
    const rel: Vec3 = [hit.point[0] - frame.origin[0], hit.point[1] - frame.origin[1], hit.point[2] - frame.origin[2]];
    return { point: hit.point, u: dot(rel, frame.xAxis), v: dot(rel, frame.yAxis) };
  }

  worldToClient(p: Vec3): { x: number; y: number; depth: number } | null {
    const s = worldToScreen(this.view, this.lens, p);
    if (!s) return null;
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y, depth: s.depth };
  }

  // --- selection and highlight ----------------------------------------------------------------------------------

  setSelection(refs: readonly EntityRef[]): void {
    this.selection = [...refs];
    this.highlightDirty = true;
    this.requestRender();
  }

  getSelection(): readonly EntityRef[] {
    return this.selection;
  }

  setHover(ref: EntityRef | null): void {
    if (refsEqual(this.hover, ref)) return;
    this.hover = ref;
    this.highlightDirty = true;
    this.requestRender();
  }

  getHover(): EntityRef | null {
    return this.hover;
  }

  private updateHover(result: PickResult | null): void {
    const ref = result?.ref ?? null;
    if (refsEqual(this.hover, ref)) return;
    this.hover = ref;
    this.highlightDirty = true;
    for (const l of this.listeners.hover) l(result);
  }

  private rebuildHighlights(): void {
    this.highlightDirty = false;
    for (const d of this.highlightDisposables) d.dispose();
    this.highlightDisposables = [];
    this.highlightGroup.clear();
    for (const p of this.planes) this.applyPlaneState(p);
    const selectedProfiles = new Set<string>();
    for (const r of this.selection) if (r.kind === "profile") selectedProfiles.add(profileKey(r.sketchId, r.regionId));
    this.profileLayer.setStates(selectedProfiles, this.hover?.kind === "profile" ? profileKey(this.hover.sketchId, this.hover.regionId) : null);

    const items: { ref: EntityRef; kind: "selection" | "hover" }[] = this.selection.map((ref) => ({ ref, kind: "selection" as const }));
    if (this.hover && !this.selection.some((r) => refKey(r) === refKey(this.hover!))) items.push({ ref: this.hover, kind: "hover" });
    for (const { ref, kind } of items) {
      const style = this.style.lines[kind];
      if (ref.kind === "face") {
        const body = this.bodies.find((b) => b.data.id === ref.bodyId);
        const tris = body?.faceIndex.get(ref.faceId);
        if (!body || !tris) continue;
        const copy = copyTriangles(body.data, tris);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(copy.positions, 3));
        const material = new THREE.MeshBasicMaterial({ color: style.color, transparent: true, opacity: this.style.opacity[kind], depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = 3;
        this.highlightGroup.add(mesh);
        this.highlightDisposables.push(geometry, material);
      } else if (ref.kind === "edge" || ref.kind === "sketch") {
        const positions = this.segmentsOfRef(ref);
        if (!positions || positions.length === 0) continue;
        const layer = new LineLayer({ positions }, { renderOrder: ORDER.highlight });
        layer.applyStyle(style);
        this.highlightGroup.add(layer.group);
        this.highlightDisposables.push(layer);
      }
    }
  }

  private segmentsOfRef(ref: EntityRef): Float32Array | null {
    if (ref.kind === "edge") {
      const body = this.bodies.find((b) => b.data.id === ref.bodyId);
      return body?.edges ? segmentsOfOwner(body.edges, ref.edgeId) : null;
    }
    if (ref.kind === "sketch") {
      const sketch = this.sketches.find((s) => s.data.id === ref.sketchId);
      const found = sketch?.layers.find((l) => l.buffers.owners.includes(ref.entityId));
      return found ? segmentsOfOwner(found.buffers, ref.entityId) : null;
    }
    return null;
  }

  // --- input ----------------------------------------------------------------------------------------------------

  private modifiers(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean }): Modifiers {
    return { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey };
  }

  private onPointerDown(e: PointerEvent): void {
    if (this.drag || this.press || this.handleDrag) return;
    // The extrude arrow is on top of everything: a press on it drags it and never starts an orbit or a click.
    if (e.button === 0 && this.beginHandleDrag(e)) return;
    const action = classifyPointerDrag(this.preset, e.button, this.modifiers(e));
    if (action) {
      e.preventDefault();
      this.drag = { pointerId: e.pointerId, action, x: e.clientX, y: e.clientY };
      this.canvas.setPointerCapture(e.pointerId);
    } else if (e.button === 0) {
      this.press = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.handleDrag) {
      if (e.pointerId === this.handleDrag.pointerId) {
        const rect = this.canvas.getBoundingClientRect();
        this.handleDrag.pending = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        if (this.handleDrag.raf === 0) this.handleDrag.raf = requestAnimationFrame(() => this.flushHandleDrag());
      }
      return;
    }
    if (this.drag && e.pointerId === this.drag.pointerId) {
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      if (this.drag.action === "orbit") this.orbitBy(dx, dy);
      else this.panBy(dx, dy);
      return;
    }
    if (this.press && e.pointerId === this.press.pointerId && Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > CLICK_SLOP_PX) this.press.moved = true;
    const rect = this.canvas.getBoundingClientRect();
    this.hoverPending = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    this.scheduleHoverPick();
  }

  /**
   * Picks under the pointer once per animation frame, and draws only when the hover changed: a pointer that moves along the
   * same thing costs a pick and no frame (a sketch of hundreds of curves must stay smooth under the pointer).
   */
  private scheduleHoverPick(): void {
    if (this.hoverRaf !== 0 || this.disposed) return;
    this.hoverRaf = requestAnimationFrame(() => {
      this.hoverRaf = 0;
      this.runHoverPick();
      if (this.highlightDirty) this.requestRender();
    });
  }

  private runHoverPick(): void {
    if (!this.hoverPending || this.disposed) return;
    const { x, y } = this.hoverPending;
    this.hoverPending = null;
    // The arrow is on top: while the pointer is on it nothing under it is hovered.
    const onHandle = this.handleHitAt(x, y) !== null;
    this.setHandleHover(onHandle);
    // The pending position is already local to the canvas.
    this.updateHover(onHandle ? null : this.pickLocal(x, y));
    this.updateAxisHover(x, y, onHandle);
  }

  /**
   * The origin axis under the pointer is drawn thicker and in full colour. It counts when the pointer is within a few pixels of it, it is
   * still solid there (not faded out), nothing solid is in front of it, and no sketch line or body edge is under the pointer (those win).
   */
  private updateAxisHover(x: number, y: number, onHandle: boolean): void {
    let axis: AxisIndex | null = null;
    if (this.grid.axesVisible && !onHandle && this.hover?.kind !== "sketch" && this.hover?.kind !== "edge") {
      const hit = nearestAxis(this.view, this.lens, x, y);
      if (hit) {
        const along = Math.abs(dot(hit.point, axisDirections[hit.axis]!));
        if (axisFade(along, this.view.distance) >= AXIS_HOVER_MIN_FADE) {
          const basis = cameraBasis(this.view);
          const ray = screenRay(this.view, this.lens, x, y, basis);
          const solid = this.nearestSolid(ray);
          const solidDepth = solid ? solid.t * dot(ray.dir, basis.forward) : Infinity;
          if (hit.depth <= solidDepth + Math.max(this.view.distance * 2e-3, 1e-4)) axis = hit.axis;
        }
      }
    }
    if (this.grid.setAxisHover(axis)) this.requestRender();
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.handleDrag && e.pointerId === this.handleDrag.pointerId) {
      this.endHandleDrag(e);
      return;
    }
    if (this.drag && e.pointerId === this.drag.pointerId) {
      this.endPointer(e);
      return;
    }
    const press = this.press;
    this.press = null;
    if (press && e.pointerId === press.pointerId && !press.moved && e.button === 0) {
      const result = this.pick(e.clientX, e.clientY);
      for (const l of this.listeners.pick) l(result, this.modifiers(e));
    }
  }

  private endPointer(e: PointerEvent): void {
    if (this.handleDrag?.pointerId === e.pointerId) this.endHandleDrag(e);
    if (this.drag?.pointerId === e.pointerId) {
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
      this.drag = null;
    }
    if (this.press?.pointerId === e.pointerId) this.press = null;
  }

  private onPointerLeave(): void {
    this.hoverPending = null;
    if (!this.handleDrag) this.setHandleHover(false);
    if (this.grid.setAxisHover(null)) this.requestRender();
    if (!this.drag && this.hover) {
      this.hover = null;
      this.highlightDirty = true;
      for (const l of this.listeners.hover) l(null);
      this.requestRender();
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const mods = this.modifiers(e);
    const action = classifyWheel(this.preset, mods);
    const dx = wheelDeltaInPixels(e.deltaX, e.deltaMode, this.lens.height);
    const dy = wheelDeltaInPixels(e.deltaY, e.deltaMode, this.lens.height);
    if (action === "zoom") {
      // Shift turns the wheel into a horizontal scroll in some browsers: take whichever axis moved.
      const delta = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
      const factor = wheelZoomFactor(delta, e.ctrlKey, this.wheelZoomDirection);
      // A pinch sends a stream of small events and is applied at once; a wheel notch is one big step, so it is eased in.
      if (e.ctrlKey || this.motionReduced()) this.zoomBy(factor, e.clientX, e.clientY);
      else this.zoomEaseBy(factor, e.clientX, e.clientY);
    } else if (action === "orbit") {
      this.orbitBy(-dx, -dy);
    } else {
      this.panBy(-dx, -dy);
    }
  }

  // --- the extrude arrow ------------------------------------------------------------------------------------------

  private handleHitAt(x: number, y: number): ReturnType<typeof hitHandle> {
    const handle = this.handleView.current;
    if (!handle) return null;
    return hitHandle(this.view, this.lens, handle, this.style.handle.headLengthPx, this.style.handle.headRadiusPx, x, y);
  }

  private setHandleHover(hovered: boolean): void {
    if (this.handleView.isHovered === hovered) return;
    this.handleView.setHovered(hovered);
    this.canvas.style.cursor = hovered ? "grab" : "";
    this.requestRender();
  }

  private emitHandle(distance: number, phase: "start" | "move" | "end"): void {
    for (const l of this.listeners.extrudeHandle) l(distance, phase);
  }

  private beginHandleDrag(e: PointerEvent): boolean {
    const handle = this.handleView.current;
    if (!handle) return false;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (this.handleHitAt(x, y) === null) return false;
    // Without a reading of the axis under the pointer (the arrow points at the eye) there is nothing to drag by.
    const grab = axisParameterAtPointer(this.view, this.lens, handle.origin, handle.direction, x, y);
    if (grab === null) return false;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.handleDrag = { pointerId: e.pointerId, startDistance: handle.distance, grab, last: handle.distance, pending: null, raf: 0 };
    this.setHandleHover(true);
    this.canvas.style.cursor = "grabbing";
    this.emitHandle(handle.distance, "start");
    return true;
  }

  /** Applies the newest pointer position of a drag: at most once per frame, and only when the length changed. */
  private flushHandleDrag(): void {
    const d = this.handleDrag;
    if (!d) return;
    d.raf = 0;
    const handle = this.handleView.current;
    if (!d.pending || !handle) return;
    const { x, y } = d.pending;
    d.pending = null;
    const next = distanceAfterDrag(this.view, this.lens, handle, d.startDistance, d.grab, x, y);
    if (next === null || next === d.last) return;
    d.last = next;
    // The arrow follows the pointer at once; the host may replace the value afterwards.
    this.handleView.setHandle({ ...handle, distance: next });
    this.requestRender();
    this.emitHandle(next, "move");
  }

  private endHandleDrag(e: PointerEvent): void {
    const d = this.handleDrag;
    if (!d) return;
    if (d.raf !== 0) cancelAnimationFrame(d.raf);
    d.raf = 0;
    // The last pointer position counts even when its frame has not come yet.
    const rect = this.canvas.getBoundingClientRect();
    if (e.type === "pointerup") d.pending = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    this.flushHandleDrag();
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.handleDrag = null;
    this.canvas.style.cursor = "";
    this.setHandleHover(this.handleHitAt(e.clientX - rect.left, e.clientY - rect.top) !== null);
    this.emitHandle(d.last, "end");
  }

  /** Stops a drag without telling the host (the host removed the arrow or the view is going away). */
  private cancelHandleDrag(): void {
    const d = this.handleDrag;
    if (!d) return;
    if (d.raf !== 0) cancelAnimationFrame(d.raf);
    if (this.canvas.hasPointerCapture(d.pointerId)) this.canvas.releasePointerCapture(d.pointerId);
    this.handleDrag = null;
    this.setHandleHover(false);
  }

  // --- events, statistics, lifetime -----------------------------------------------------------------------------

  on<E extends keyof ViewportEvents>(event: E, listener: ViewportEvents[E]): () => void {
    const set = this.listeners[event] as Set<ViewportEvents[E]>;
    set.add(listener);
    return () => { set.delete(listener); };
  }

  frameStats(): FrameStats {
    const n = this.frameTimes.length;
    if (n === 0) return { frames: 0, meanMs: 0, p95Ms: 0, maxMs: 0, meanCpuMs: 0, maxCpuMs: 0 };
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    return { frames: n, meanMs: sum(this.frameTimes) / n, p95Ms: sorted[Math.min(n - 1, Math.floor(n * 0.95))]!, maxMs: sorted[n - 1]!, meanCpuMs: sum(this.cpuTimes) / n, maxCpuMs: Math.max(...this.cpuTimes) };
  }

  resetFrameStats(): void {
    this.frameTimes = [];
    this.cpuTimes = [];
    this.lastFrameAt = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.rafId !== 0) cancelAnimationFrame(this.rafId);
    if (this.hoverRaf !== 0) cancelAnimationFrame(this.hoverRaf);
    this.abort.abort();
    this.resizeObserver.disconnect();
    for (const d of this.highlightDisposables) d.dispose();
    this.highlightGroup.clear();
    this.disposeBodies(this.bodies);
    this.disposeBodies(this.previewBodies);
    this.disposeSketches(this.sketches);
    this.disposeSketches(this.previewSketches);
    this.sketchLayerImpl.dispose();
    if (this.handleDrag) this.cancelHandleDrag();
    this.profileLayer.dispose();
    this.handleView.dispose();
    for (const p of this.planes) {
      p.fill.geometry.dispose();
      p.fillMaterial.dispose();
      p.outline.dispose();
    }
    this.planes = [];
    this.grid.dispose();
    this.bodyMaterial.dispose();
    this.previewMaterial.dispose();
    void this.renderer.dispose();
    this.canvas.remove();
    for (const w of this.idleWaiters.splice(0)) w();
  }
}
