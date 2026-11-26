// The extrude arrow on three.js: a shaft (a pixel-width line from the profile to the tip) and a cone head of constant size on
// the screen, each with a halo in the view colour behind it, so the arrow stays readable over the tinted preview it points
// through. All of it is drawn over everything (depth test off, transparent pass), like a manipulator. The maths (where the head
// is, what the pointer hits, which length a pointer position means) is in extrude-handle.ts.
import * as THREE from "three/webgpu";
import type { Lens, ViewState } from "./camera.ts";
import { handleGeometry, handleIsValid, handleTip } from "./extrude-handle.ts";
import { HANDLE_HALO_PX, type ViewportStyle } from "./style.ts";
import { LineLayer } from "./three-lines.ts";
import type { ExtrudeHandle } from "./types.ts";

const HALO_ORDER = 40;
const ARROW_ORDER = 41;
/** The head grows by this factor while the pointer is on the arrow or drags it. */
export const HOVER_GROW = 1.25;
/** The shaft is this many pixels wider while hovered. */
const HOVER_EXTRA_WIDTH = 1;

const UP = new THREE.Vector3(0, 1, 0);

export class ExtrudeHandleView {
  readonly group = new THREE.Group();
  private readonly haloShaft = LineLayer.empty({ renderOrder: HALO_ORDER, onTop: true });
  private readonly shaft = LineLayer.empty({ renderOrder: ARROW_ORDER, onTop: true });
  private readonly headGeometry = new THREE.ConeGeometry(1, 1, 28, 1);
  private readonly headMaterial = this.makeMaterial();
  private readonly haloMaterial = this.makeMaterial();
  private readonly head: THREE.Mesh;
  private readonly haloHead: THREE.Mesh;
  private handle: ExtrudeHandle | null = null;
  private hovered = false;
  private style: ViewportStyle | null = null;

  constructor() {
    // The apex at the origin, the base one unit back along -Y: scale (radius, length, radius) and turn to the arrow's direction.
    this.headGeometry.translate(0, -0.5, 0);
    this.head = new THREE.Mesh(this.headGeometry, this.headMaterial);
    this.head.renderOrder = ARROW_ORDER;
    this.head.frustumCulled = false;
    this.haloHead = new THREE.Mesh(this.headGeometry, this.haloMaterial);
    this.haloHead.renderOrder = HALO_ORDER;
    this.haloHead.frustumCulled = false;
    this.group.add(this.haloShaft.group, this.haloHead, this.shaft.group, this.head);
    this.group.visible = false;
  }

  private makeMaterial(): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(1), transparent: true, depthTest: false, depthWrite: false });
  }

  get current(): ExtrudeHandle | null {
    return this.handle;
  }

  get isHovered(): boolean {
    return this.hovered;
  }

  setStyle(style: ViewportStyle): void {
    this.style = style;
    this.applyLook();
  }

  /** Sets the arrow (null removes it). Only the shafts' geometry is rebuilt, in place; no GPU object is created per call. */
  setHandle(handle: ExtrudeHandle | null): void {
    const next = handle && handleIsValid(handle) ? handle : null;
    this.handle = next;
    this.group.visible = next !== null;
    if (!next) return;
    const tip = handleTip(next);
    const positions = Math.abs(next.distance) > 1e-9 ? new Float32Array([...next.origin, ...tip]) : new Float32Array(0);
    this.shaft.replaceGeometry({ positions });
    this.haloShaft.replaceGeometry({ positions });
    this.applyLook();
  }

  setHovered(hovered: boolean): void {
    if (this.hovered === hovered) return;
    this.hovered = hovered;
    this.applyLook();
  }

  private applyLook(): void {
    const s = this.style;
    if (!s) return;
    const color = this.hovered ? s.handle.hoverColor : s.handle.color;
    const width = s.handle.width + (this.hovered ? HOVER_EXTRA_WIDTH : 0);
    this.headMaterial.color.set(color);
    this.haloMaterial.color.set(s.handle.halo);
    this.shaft.applyStyle({ color, width, dash: [] });
    this.haloShaft.applyStyle({ color: s.handle.halo, width: width + 2 * HANDLE_HALO_PX, dash: [] });
  }

  /** Puts the head at the tip with its constant screen size; called before every frame while an arrow is shown. */
  update(view: ViewState, lens: Lens): void {
    const h = this.handle;
    const s = this.style;
    if (!h || !s) return;
    const grow = this.hovered ? HOVER_GROW : 1;
    const g = handleGeometry(view, lens, h, s.handle.headLengthPx, s.handle.headRadiusPx, grow);
    const dir = new THREE.Vector3(...g.dir);
    const turn = new THREE.Quaternion().setFromUnitVectors(UP, dir);
    this.head.position.set(...g.tip);
    this.head.scale.set(g.radius, g.length, g.radius);
    this.head.quaternion.copy(turn);
    // The halo head is the head grown by the halo width all round; its apex lies a little ahead of the tip so the outline is even.
    const wpp = g.length / (s.handle.headLengthPx * grow);
    const halo = HANDLE_HALO_PX * wpp;
    this.haloHead.position.set(g.tip[0] + dir.x * halo * 1.6, g.tip[1] + dir.y * halo * 1.6, g.tip[2] + dir.z * halo * 1.6);
    this.haloHead.scale.set(g.radius + halo, g.length + halo * 2.6, g.radius + halo);
    this.haloHead.quaternion.copy(turn);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.shaft.dispose();
    this.haloShaft.dispose();
    this.headGeometry.dispose();
    this.headMaterial.dispose();
    this.haloMaterial.dispose();
  }
}
