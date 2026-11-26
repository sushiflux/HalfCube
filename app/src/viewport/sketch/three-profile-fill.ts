// THE FULL FILL of determined regions (a translucent fill of 25 % in the colour of "fully constrained"). Kept in this one module so it can be switched off or removed in one change. This file is the
// whole fill: to remove it, delete this file and everything three-sketch-layer.ts marks with "profile fill" (the import, the
// field, dispose, the colour lines, the updateFill method and its call); the inner band (band.ts) stays as the fallback. The
// fill is never drawn while a drag skips the regions. The rule which regions get it is filledProfiles() below.
import type { SketchView } from "../../model/editors.ts";
import type { Frame3 } from "./frame.ts";
import { FlatMesh } from "./three-flat.ts";
import { mergeMeshes } from "./ribbon.ts";

/** Opacity of the full fill (25 %). The theme token opacity.profileFill is not used. */
export const PROFILE_FILL_OPACITY = 0.25;

/**
 * The regions that get the fill: those whose outer loop is fully determined (per loop). The holes are cut
 * out of the fill triangles, so they stay empty whether they are determined or not; a free hole does not keep the fill off.
 */
export function filledProfiles(profiles: readonly SketchView["profiles"][number][]): SketchView["profiles"] {
  return profiles.filter((p) => p.loopsDetermined[0] === true);
}

export class ProfileFill {
  private readonly flat = new FlatMesh({ renderOrder: 18, opacity: PROFILE_FILL_OPACITY });
  get mesh() {
    return this.flat.mesh;
  }

  setColour(color: string): void {
    this.flat.setColour(color);
  }

  /** The opacity to blend with: PROFILE_FILL_OPACITY corrected for the renderer's linear blending (see linearAlpha). */
  setOpacity(opacity: number): void {
    this.flat.setOpacity(opacity);
  }

  /** Fills the given regions (the caller picks them with filledProfiles); an empty list hides the fill. */
  set(frame: Frame3, profiles: readonly SketchView["profiles"][number][]): void {
    if (profiles.length === 0) {
      this.flat.clear();
      return;
    }
    const merged = mergeMeshes(profiles.map((p) => ({ positions: p.fill.positions, indices: p.fill.indices })));
    this.flat.set(frame, merged.positions, merged.indices);
  }

  clear(): void {
    this.flat.clear();
  }

  dispose(): void {
    this.flat.dispose();
  }
}
