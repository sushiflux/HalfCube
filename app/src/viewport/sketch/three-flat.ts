// A mesh of triangles that lies in the sketch plane, given in sketch coordinates: bands, ribbons, arrowheads, region fills.
// The geometry is replaced as a whole when the content changes (it is small and changes at most once per frame).
import * as THREE from "three/webgpu";
import { type Frame3, sketchToWorld } from "./frame.ts";

export interface FlatOptions {
  renderOrder: number;
  opacity?: number;
}

export class FlatMesh {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  private geometry: THREE.BufferGeometry | null = null;

  constructor(options: FlatOptions) {
    const translucent = options.opacity !== undefined && options.opacity < 1;
    this.material = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setScalar(1),
      side: THREE.DoubleSide,
      transparent: translucent,
      opacity: options.opacity ?? 1,
      depthWrite: false,
      // The sketch plane may be the face of a body: pull the triangles a little towards the camera.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.renderOrder = options.renderOrder;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  setColour(color: string): void {
    this.material.color.set(color);
  }

  setOpacity(opacity: number): void {
    this.material.opacity = opacity;
    this.material.transparent = opacity < 1;
  }

  /** Sets the triangles: u v per vertex and three indices per triangle. An empty mesh hides itself. */
  set(frame: Frame3, uv: Float32Array, indices: Uint32Array): void {
    if (indices.length === 0 || uv.length === 0) {
      this.mesh.visible = false;
      return;
    }
    const n = uv.length / 2;
    const positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const p = sketchToWorld(frame, uv[i * 2]!, uv[i * 2 + 1]!);
      positions[i * 3] = p[0];
      positions[i * 3 + 1] = p[1];
      positions[i * 3 + 2] = p[2];
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.mesh.geometry = geometry;
    this.geometry?.dispose();
    this.geometry = geometry;
    this.mesh.visible = true;
  }

  clear(): void {
    this.mesh.visible = false;
  }

  get visible(): boolean {
    return this.mesh.visible;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry?.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
