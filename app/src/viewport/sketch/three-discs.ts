// Discs and rings of a fixed size in pixels that lie in the sketch plane: the points of a sketch, the halos of selected
// points, the points of a tool preview. One instanced mesh per set; the size of every instance is recomputed from the camera
// before each frame, so a point is 9 px across at any zoom and from any distance.
import * as THREE from "three/webgpu";
import { cameraBasis, type Lens, type ViewState } from "../camera.ts";
import { type Frame3, mmPerPixelAt, sketchToWorld } from "./frame.ts";

export interface DiscItem {
  u: number;
  v: number;
  /** Radius in CSS pixels (the outer radius for a ring). */
  radiusPx: number;
  /** "#rrggbb". */
  color: string;
}

export interface DiscOptions {
  renderOrder: number;
  /** Ring: the inner radius as a fraction of the outer one. Without it the set draws filled discs. */
  ringInner?: number;
  opacity?: number;
}

const SEGMENTS = 28;

export class DiscSet {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh | null = null;
  private capacity = 0;
  private items: DiscItem[] = [];
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly matrix = new THREE.Matrix4();
  private readonly colour = new THREE.Color();

  private readonly options: DiscOptions;

  constructor(options: DiscOptions) {
    this.options = options;
    this.geometry = options.ringInner !== undefined ? new THREE.RingGeometry(options.ringInner, 1, SEGMENTS) : new THREE.CircleGeometry(1, SEGMENTS);
    const translucent = options.opacity !== undefined && options.opacity < 1;
    this.material = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setScalar(1),
      side: THREE.DoubleSide,
      transparent: translucent,
      opacity: options.opacity ?? 1,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.group.visible = false;
  }

  setOpacity(opacity: number): void {
    this.material.opacity = opacity;
    this.material.transparent = opacity < 1;
  }

  get count(): number {
    return this.items.length;
  }

  /** The items are sketch points with their size and colour. Matrices follow with update(). */
  set(items: readonly DiscItem[]): void {
    this.items = [...items];
    if (items.length === 0) {
      this.group.visible = false;
      return;
    }
    if (!this.mesh || items.length > this.capacity) {
      if (this.mesh) {
        this.group.remove(this.mesh);
        this.mesh.dispose();
      }
      this.capacity = Math.max(16, 2 ** Math.ceil(Math.log2(items.length)));
      const mesh = new THREE.InstancedMesh(this.geometry, this.material, this.capacity);
      mesh.frustumCulled = false;
      mesh.renderOrder = this.options.renderOrder;
      this.group.add(mesh);
      this.mesh = mesh;
    }
    const mesh = this.mesh;
    mesh.count = items.length;
    items.forEach((it, i) => mesh.setColorAt(i, this.colour.set(it.color)));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.visible = true;
  }

  /** Places every instance for the current camera. */
  update(frame: Frame3, view: ViewState, lens: Lens): void {
    const mesh = this.mesh;
    if (!mesh || this.items.length === 0) return;
    const basis = cameraBasis(view);
    const m = this.matrix;
    this.items.forEach((it, i) => {
      const p = sketchToWorld(frame, it.u, it.v);
      const s = it.radiusPx * mmPerPixelAt(view, lens, p, basis);
      m.set(
        frame.u[0] * s, frame.v[0] * s, frame.normal[0] * s, p[0],
        frame.u[1] * s, frame.v[1] * s, frame.normal[1] * s, p[1],
        frame.u[2] * s, frame.v[2] * s, frame.normal[2] * s, p[2],
        0, 0, 0, 1,
      );
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.dispose();
      this.mesh = null;
    }
    this.geometry.dispose();
    this.material.dispose();
  }
}
