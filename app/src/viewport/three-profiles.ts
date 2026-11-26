// The pickable profiles of the extrude command on three.js: one flat translucent fill per region, drawn on its sketch plane, and
// an outline for the hovered and the selected ones. The fills are given by the host and never changed here. The states (rest,
// hover, selected) come from the ViewportStyle; the viewport tells this layer which profiles are hovered and selected.
import * as THREE from "three/webgpu";
import type { Ray } from "./camera.ts";
import type { Bounds, Vec3 } from "./math.ts";
import { emptyBounds, unionBounds } from "./math.ts";
import { outlineSegments, profileArea, profileBounds, profileWorldPositions, rayProfile, uvBounds, validateProfile } from "./profiles.ts";
import type { ViewportStyle } from "./style.ts";
import { linearAlpha } from "./sketch/band-colour.ts";
import { LineLayer } from "./three-lines.ts";
import type { PlaneFrame, ProfileData } from "./types.ts";

const FILL_ORDER = 4;
const OUTLINE_ORDER = 23;

export const profileKey = (sketchId: string, regionId: string): string => `${sketchId}\u0000${regionId}`;

export type ProfileState = "rest" | "hover" | "selected";

interface ProfileView {
  data: ProfileData;
  key: string;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshBasicMaterial;
  mesh: THREE.Mesh;
  bounds: Bounds;
  uv: ReturnType<typeof uvBounds>;
  area: number;
  /** Built on the first hover or selection. */
  outline: LineLayer | null;
  state: ProfileState;
}

export interface ProfileHitResult {
  sketchId: string;
  regionId: string;
  plane: PlaneFrame;
  t: number;
  point: Vec3;
}

export class ProfileLayer {
  readonly group = new THREE.Group();
  private views: ProfileView[] = [];
  private style: ViewportStyle | null = null;

  get count(): number {
    return this.views.length;
  }

  has(sketchId: string, regionId: string): boolean {
    const key = profileKey(sketchId, regionId);
    return this.views.some((v) => v.key === key);
  }

  boundsOf(sketchId: string, regionId: string): Bounds {
    const key = profileKey(sketchId, regionId);
    return this.views.find((v) => v.key === key)?.bounds ?? emptyBounds();
  }

  bounds(): Bounds {
    let b = emptyBounds();
    for (const v of this.views) b = unionBounds(b, v.bounds);
    return b;
  }

  setStyle(style: ViewportStyle): void {
    this.style = style;
    for (const v of this.views) this.applyState(v, v.state);
  }

  /** Replaces all profiles; the old ones are freed first. A profile whose data is malformed throws before anything is changed. */
  set(profiles: readonly ProfileData[]): void {
    for (const p of profiles) {
      const problem = validateProfile(p);
      if (problem) throw new Error(problem);
    }
    this.clear();
    for (const data of profiles) {
      if (data.triangles.length === 0) continue;
      const positions = profileWorldPositions(data.plane, data.triangles);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color().setScalar(1),
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false,
        // The profile usually lies on a body face or on the grid plane: pull it a little towards the camera.
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = FILL_ORDER;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      const view: ProfileView = { data, key: profileKey(data.sketchId, data.regionId), geometry, material, mesh, bounds: profileBounds(data.plane, data.triangles), uv: uvBounds(data.triangles), area: profileArea(data.triangles), outline: null, state: "rest" };
      this.views.push(view);
      this.applyState(view, "rest");
    }
  }

  /** Sets which profiles are hovered and selected (by key); every other one is at rest. */
  setStates(selected: ReadonlySet<string>, hovered: string | null): void {
    for (const v of this.views) {
      const state: ProfileState = selected.has(v.key) ? "selected" : v.key === hovered ? "hover" : "rest";
      if (state !== v.state) this.applyState(v, state);
    }
  }

  private applyState(v: ProfileView, state: ProfileState): void {
    v.state = state;
    const s = this.style;
    if (!s) return;
    const look = s.profile[state];
    v.material.color.set(look.color);
    v.material.opacity = linearAlpha(look.color, s.background, look.opacity);
    if (state === "rest") {
      if (v.outline) v.outline.visible = false;
      return;
    }
    const outlineStyle = s.profile[state].outline;
    if (!v.outline) {
      v.outline = new LineLayer({ positions: outlineSegments(v.data.plane, v.data.triangles, v.data.outline) }, { renderOrder: OUTLINE_ORDER, polygonOffset: true });
      this.group.add(v.outline.group);
    }
    v.outline.applyStyle(outlineStyle);
    v.outline.visible = true;
  }

  /** The profile under a ray: the nearest one; of two at the same distance (within `epsilon`) the smaller region. */
  pick(ray: Ray, epsilon: number): ProfileHitResult | null {
    let best: { view: ProfileView; t: number; point: Vec3 } | null = null;
    for (const v of this.views) {
      const hit = rayProfile(ray, v.data.plane, v.data.triangles, v.uv);
      if (!hit) continue;
      if (!best || hit.t < best.t - epsilon || (Math.abs(hit.t - best.t) <= epsilon && v.area < best.view.area)) best = { view: v, t: hit.t, point: hit.point };
    }
    return best ? { sketchId: best.view.data.sketchId, regionId: best.view.data.regionId, plane: best.view.data.plane, t: best.t, point: best.point } : null;
  }

  clear(): void {
    for (const v of this.views) {
      this.group.remove(v.mesh);
      v.geometry.dispose();
      v.material.dispose();
      if (v.outline) {
        this.group.remove(v.outline.group);
        v.outline.dispose();
      }
    }
    this.views = [];
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
  }
}
