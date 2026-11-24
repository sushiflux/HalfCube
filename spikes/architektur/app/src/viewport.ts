// 3D view on three.js's WebGPURenderer: WebGPU when the browser offers it, otherwise its WebGL2 backend.
// Draws the engine's meshes straight from the result payload (zero-copy typed arrays), the B-rep edges as
// screen-space lines with a settable width, and highlights a picked face. Picking maps the hit triangle to its
// face through the per-triangle face ids of the mesh.
import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineSegments2 } from "three/addons/lines/webgpu/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { meshViews, type BodyMeshViews } from "../../protocol/mesh.ts";
import type { BodyResult, FaceInfo, RebuildResult } from "../../protocol/protocol.ts";

/** auto: WebGPU with automatic fallback; webgl: WebGL2 forced; nogpu: navigator.gpu hidden, tests the fallback path. */
export type RendererMode = "auto" | "webgl" | "nogpu";

export interface BackendInfo {
  mode: RendererMode;
  /** Backend that actually draws. */
  backend: "WebGPU" | "WebGL2";
  /** navigator.gpu existed when the view was created (before any hiding for mode nogpu). */
  webgpuApiPresent: boolean;
  adapter: { vendor: string; architecture: string; device: string; description: string; isFallbackAdapter: boolean | null } | null;
  adapterError: string | null;
  /** WebGL renderer string (WEBGL_debug_renderer_info), only for the WebGL2 backend. */
  webglRenderer: string | null;
  initMs: number;
}

export interface PickHit {
  bodyId: string;
  face: FaceInfo;
  triangle: number;
  point: THREE.Vector3;
  raycastMs: number;
}

export interface ViewColors {
  background: string;
  body: string;
  edge: string;
  selection: string;
}

const defaultColors: ViewColors = { background: "#e8edf2", body: "#c7d2dc", edge: "#16476e", selection: "#1f75ae" };

interface BodyView {
  body: BodyResult;
  views: BodyMeshViews;
  mesh: THREE.Mesh;
  edges: LineSegments2 | null;
  geometry: THREE.BufferGeometry;
}

async function queryAdapter(): Promise<Pick<BackendInfo, "adapter" | "adapterError">> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return { adapter: null, adapterError: "navigator.gpu is not available" };
  try {
    const a = await gpu.requestAdapter();
    if (!a) return { adapter: null, adapterError: "requestAdapter() returned null" };
    const i = a.info;
    const fallback = (i as GPUAdapterInfo & { isFallbackAdapter?: boolean }).isFallbackAdapter;
    return {
      adapter: {
        vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description,
        isFallbackAdapter: typeof fallback === "boolean" ? fallback : null,
      },
      adapterError: null,
    };
  } catch (e) {
    return { adapter: null, adapterError: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

export class Viewport {
  readonly info: BackendInfo;
  edgeWidthPx = 1.5;
  onPick: ((p: PickHit | null) => void) | null = null;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10_000);
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly bodyMaterial: THREE.MeshStandardMaterial;
  private readonly selectionMaterial: THREE.MeshBasicMaterial;
  private readonly edgeMaterial: THREE.Line2NodeMaterial;
  private readonly selectionMesh: THREE.Mesh;
  private readonly root = new THREE.Group();
  private bodies: BodyView[] = [];
  private framedFor = "";
  /** performance.now() when the first body was on screen (load time). */
  firstBodyFrameAt: number | null = null;
  private renderQueued = false;
  private frameWaiters: (() => void)[] = [];
  private selected: { bodyId: string; faceId: number } | null = null;
  private resizeObserver: ResizeObserver;
  private readonly canvas: HTMLCanvasElement;

  private constructor(canvas: HTMLCanvasElement, renderer: THREE.WebGPURenderer, info: BackendInfo, colors: ViewColors) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.info = info;
    this.scene.background = new THREE.Color(colors.background);
    this.camera.up.set(0, 0, 1); // CAD convention: Z up, millimetres

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8794a1, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(0.4, -0.6, 1); // follows the camera, see render()
    this.camera.add(key);
    this.scene.add(this.camera);
    this.scene.add(this.root);

    this.bodyMaterial = new THREE.MeshStandardMaterial({
      color: colors.body, roughness: 0.55, metalness: 0.0,
      // Pushes faces back a little so the edge lines on them are not hidden.
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    this.selectionMaterial = new THREE.MeshBasicMaterial({
      color: colors.selection, transparent: true, opacity: 0.55, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    this.edgeMaterial = new THREE.Line2NodeMaterial({ color: colors.edge, linewidth: this.edgeWidthPx, worldUnits: false });

    this.selectionMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.selectionMaterial);
    this.selectionMesh.visible = false;
    this.selectionMesh.renderOrder = 1;
    this.root.add(this.selectionMesh);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.addEventListener("change", () => this.requestRender());

    let down: { x: number; y: number } | null = null;
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener("pointerup", (e) => {
      if (e.button !== 0 || !down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4) return; // a drag rotated the view
      const p = this.pickAt(e.clientX, e.clientY);
      this.select(p ? { bodyId: p.bodyId, faceId: p.face.faceId } : null);
      this.onPick?.(p);
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  static async create(canvas: HTMLCanvasElement, mode: RendererMode, colors: ViewColors = defaultColors): Promise<Viewport> {
    const t0 = performance.now();
    const webgpuApiPresent = "gpu" in navigator && !!(navigator as Navigator & { gpu?: GPU }).gpu;
    const adapterInfo = mode === "webgl" || mode === "nogpu" ? { adapter: null, adapterError: null } : await queryAdapter();
    if (mode === "nogpu") {
      // Simulates a browser without WebGPU, so three.js takes its own fallback path (not the forced one).
      Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
    }
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: mode === "webgl" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    await renderer.init();
    const backendObj = renderer.backend as unknown as { isWebGPUBackend?: boolean; isWebGLBackend?: boolean; gl?: WebGL2RenderingContext };
    const backend = backendObj.isWebGPUBackend ? "WebGPU" : "WebGL2";
    let webglRenderer: string | null = null;
    if (backend === "WebGL2" && backendObj.gl) {
      const gl = backendObj.gl;
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      webglRenderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    }
    const info: BackendInfo = { mode, backend, webgpuApiPresent, ...adapterInfo, webglRenderer, initMs: performance.now() - t0 };
    return new Viewport(canvas, renderer, info, colors);
  }

  /** Replaces all bodies with those of a result. Resolves after the next animation frame following the render. */
  setResult(result: RebuildResult, payload: ArrayBuffer): Promise<void> {
    for (const b of this.bodies) {
      this.root.remove(b.mesh);
      b.geometry.dispose();
      if (b.edges) {
        this.root.remove(b.edges);
        b.edges.geometry.dispose();
      }
    }
    this.bodies = [];
    for (const body of result.bodies) {
      const views = meshViews(payload, body);
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(views.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(views.normals, 3));
      g.setIndex(new THREE.BufferAttribute(views.indices, 1));
      g.boundingBox = new THREE.Box3(new THREE.Vector3(...body.bbox.min), new THREE.Vector3(...body.bbox.max));
      g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
      const mesh = new THREE.Mesh(g, this.bodyMaterial);
      mesh.userData.bodyId = body.bodyId;
      this.root.add(mesh);
      let edges: LineSegments2 | null = null;
      if (views.edgePositions.length > 0) {
        const eg = new LineSegmentsGeometry();
        eg.setPositions(views.edgePositions);
        edges = new LineSegments2(eg, this.edgeMaterial);
        this.root.add(edges);
      }
      this.bodies.push({ body, views, mesh, edges, geometry: g });
    }
    // Keep the selection if the face still exists (face ids are not stable across rebuilds yet: spike only).
    if (this.selected) {
      const b = this.bodies.find((x) => x.body.bodyId === this.selected!.bodyId);
      if (!b || this.selected.faceId >= b.body.faces.length) {
        this.selected = null;
        this.onPick?.(null);
      }
    }
    this.updateSelectionMesh();
    // Frame the camera when a different set of bodies appears (first result, other recipe).
    const ids = this.bodies.map((b) => b.body.bodyId).join(",");
    if (ids !== this.framedFor && this.bodies.length > 0) {
      this.frameAll();
      this.framedFor = ids;
    }
    const drawn = this.requestRender();
    if (this.firstBodyFrameAt === null && this.bodies.length > 0) {
      void drawn.then(() => {
        this.firstBodyFrameAt ??= performance.now();
      });
    }
    return drawn;
  }

  frameAll() {
    const box = new THREE.Box3();
    for (const b of this.bodies) box.union(b.geometry.boundingBox!);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dist = sphere.radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.15;
    const dir = new THREE.Vector3(1, -1.25, 0.95).normalize();
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    this.camera.near = Math.max(dist / 1000, 0.01);
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(sphere.center);
    this.controls.update();
    this.requestRender();
  }

  select(sel: { bodyId: string; faceId: number } | null) {
    this.selected = sel;
    this.updateSelectionMesh();
    void this.requestRender();
  }

  get selection() {
    return this.selected;
  }

  setEdgeWidth(px: number) {
    this.edgeWidthPx = px;
    this.edgeMaterial.linewidth = px;
    void this.requestRender();
  }

  /** Picks at client (CSS pixel) coordinates. */
  pickAt(clientX: number, clientY: number): PickHit | null {
    const t0 = performance.now();
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.bodies.map((b) => b.mesh), false);
    const raycastMs = performance.now() - t0;
    const hit = hits[0];
    if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) return null;
    const b = this.bodies.find((x) => x.mesh === hit.object);
    if (!b) return null;
    const faceId = b.views.faceIds[hit.faceIndex];
    const face = faceId === undefined ? undefined : b.body.faces[faceId];
    if (!face) return null;
    return { bodyId: b.body.bodyId, face, triangle: hit.faceIndex, point: hit.point.clone(), raycastMs };
  }

  /** Projects a model point (mm) to client coordinates; for tests. */
  toClient(p: THREE.Vector3): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const v = p.clone().project(this.camera);
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  /** Distance of a model point from the camera (mm); for tests. */
  cameraDistance(p: THREE.Vector3): number {
    return this.camera.position.distanceTo(p);
  }

  /** Centroid of one triangle of a face (mm); for tests. */
  faceSamplePoint(bodyId: string, faceId: number): THREE.Vector3 | null {
    const b = this.bodies.find((x) => x.body.bodyId === bodyId);
    const f = b?.body.faces[faceId];
    if (!b || !f || f.triangleCount === 0) return null;
    const t = f.triangleStart + (f.triangleCount >> 1);
    const c = new THREE.Vector3();
    for (let k = 0; k < 3; ++k) {
      const vi = b.views.indices[t * 3 + k]!;
      c.x += b.views.positions[vi * 3]! / 3;
      c.y += b.views.positions[vi * 3 + 1]! / 3;
      c.z += b.views.positions[vi * 3 + 2]! / 3;
    }
    return c;
  }

  get triangleCount(): number {
    return this.bodies.reduce((s, b) => s + b.body.mesh.triangleCount, 0);
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
  }

  private updateSelectionMesh() {
    const sel = this.selected;
    const b = sel ? this.bodies.find((x) => x.body.bodyId === sel.bodyId) : undefined;
    const f = b && sel ? b.body.faces[sel.faceId] : undefined;
    if (!b || !f) {
      this.selectionMesh.visible = false;
      return;
    }
    // Same vertex and index buffers as the body; the draw range covers the face's contiguous triangles.
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", b.geometry.getAttribute("position"));
    g.setAttribute("normal", b.geometry.getAttribute("normal"));
    g.setIndex(b.geometry.getIndex());
    g.setDrawRange(f.triangleStart * 3, f.triangleCount * 3);
    g.boundingSphere = b.geometry.boundingSphere;
    this.selectionMesh.geometry.dispose();
    this.selectionMesh.geometry = g;
    this.selectionMesh.visible = true;
  }

  private resize() {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    void this.requestRender();
  }

  /** Renders on the next animation frame (on demand, no idle loop). Resolves one frame after that render. */
  requestRender(): Promise<void> {
    const p = new Promise<void>((resolve) => this.frameWaiters.push(resolve));
    if (!this.renderQueued) {
      this.renderQueued = true;
      requestAnimationFrame(() => {
        this.renderQueued = false;
        const waiters = this.frameWaiters.splice(0);
        this.renderer.render(this.scene, this.camera);
        requestAnimationFrame(() => waiters.forEach((w) => w()));
      });
    }
    return p;
  }
}
