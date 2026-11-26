// Turns what the model layer knows about the closed areas of a sketch (ProfileView, in the engine's plane frame) into what the 3D
// view draws and picks (ProfileData), and places the drag arrow of the extrude command. Pure functions, no React, no DOM.
import type { PlaneFrame } from "../../engine/generated/protocol.ts";
import type { ProfileView } from "../../model/index.ts";
import type { EntityRef, ExtrudeHandle, ProfileData, Vec2 } from "../../viewport/index.ts";
import type { CatalogueEntry, ProfileRef } from "./profile-catalogue.ts";

/** The engine's frame (origin, u, v, normal) as the view's frame (origin, xAxis, yAxis; the normal is their cross product). */
export function viewFrame(frame: PlaneFrame): ProfileData["plane"] {
  const { origin, u, v } = frame;
  return { origin: [origin.x, origin.y, origin.z], xAxis: [u.x, u.y, u.z], yAxis: [v.x, v.y, v.z] };
}

/** Fill triangles without an index buffer: u v for each of the three vertices of every triangle, as the view takes them. */
export function expandTriangles(fill: ProfileView["fill"]): Float32Array {
  const { positions, indices } = fill;
  const out = new Float32Array(indices.length * 2);
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i] ?? 0;
    out[i * 2] = positions[index * 2] ?? 0;
    out[i * 2 + 1] = positions[index * 2 + 1] ?? 0;
  }
  return out;
}

/** One outline per loop (outer first, then the holes), as (u, v) points. */
export function outlineOf(loops: readonly Float32Array[]): Vec2[][] {
  return loops.map((loop) => {
    const points: Vec2[] = [];
    for (let i = 0; i + 1 < loop.length; i += 2) points.push([loop[i] ?? 0, loop[i + 1] ?? 0]);
    return points;
  });
}

export function profileData(entry: CatalogueEntry, profile: ProfileView): ProfileData {
  return {
    sketchId: entry.sketchId,
    regionId: profile.key,
    plane: viewFrame(entry.frame),
    triangles: expandTriangles(profile.fill),
    outline: outlineOf(profile.loops),
  };
}

/** The areas the view offers: all of them, or (editing an existing extrusion) only those of its own sketch. */
export function offeredProfiles(entries: readonly CatalogueEntry[], onlySketch: string | null): ProfileData[] {
  return entries.filter((e) => onlySketch === null || e.sketchId === onlySketch).flatMap((e) => e.profiles.map((p) => profileData(e, p)));
}

export function profileRefOf(ref: EntityRef): ProfileRef | null {
  return ref.kind === "profile" ? { sketchId: ref.sketchId, regionId: ref.regionId } : null;
}

export const entityOf = (ref: ProfileRef): EntityRef => ({ kind: "profile", sketchId: ref.sketchId, regionId: ref.regionId });

/** The middle of the bounding box of an area's outer loop in sketch coordinates (where the arrow starts). */
export function profileCentre(profile: ProfileView): Vec2 {
  const loop = profile.loops[0] ?? profile.fill.positions;
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (let i = 0; i + 1 < loop.length; i += 2) {
    const u = loop[i] ?? 0;
    const v = loop[i + 1] ?? 0;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  return Number.isFinite(minU) ? [(minU + maxU) / 2, (minV + maxV) / 2] : [0, 0];
}

/**
 * The drag arrow of the extrude command: it starts in the middle of the area on the sketch plane and runs along the plane's normal.
 * Its length is what the dialog says: the signed distance for "one side"; for "symmetric" the dialog's total thickness is shared
 * over both sides, so the arrow shows the half that lies in front of the plane and a drag of it doubles back to the total.
 */
export function extrudeHandle(entry: CatalogueEntry, profile: ProfileView, signedMm: number, symmetric: boolean): ExtrudeHandle {
  const [u, v] = profileCentre(profile);
  const { origin, u: fu, v: fv, normal } = entry.frame;
  return {
    origin: [origin.x + u * fu.x + v * fv.x, origin.y + u * fu.y + v * fv.y, origin.z + u * fu.z + v * fv.z],
    direction: [normal.x, normal.y, normal.z],
    distance: symmetric ? Math.abs(signedMm) / 2 : signedMm,
  };
}

/** What the arrow reports as the dialog's signed distance: the half of a symmetric extrusion is doubled to the total. */
export const handleToDistance = (reported: number, symmetric: boolean): number => (symmetric ? reported * 2 : reported);
