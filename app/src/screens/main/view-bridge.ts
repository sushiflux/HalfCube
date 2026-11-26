// Turns what the model layer delivers (ModelView, finished sketches) into what the 3D view draws (BodyData, SketchData). Pure
// functions, no React, no DOM. The sketch that is open is drawn by the sketch layer, not here.
import type { SketchFeature } from "../../document/types.ts";
import type { ModelView, BodyView } from "../../model/index.ts";
import { originPlaneFrame } from "../../viewport/geometry.ts";
import type { BodyData, SketchData, SketchEntity } from "../../viewport/index.ts";

/** Engine ids are a letter and a number ("l6"); the number is unique in the document and is what the view calls an entity. */
export function entityNumber(id: string): number {
  const n = Number(id.slice(1));
  return Number.isInteger(n) ? n : -1;
}

export function bodyData(body: BodyView): BodyData {
  const edges = body.edges;
  const hasEdges = edges.length > 0;
  return {
    id: body.id,
    positions: body.mesh.positions,
    normals: body.mesh.normals,
    indices: body.mesh.indices,
    faceIds: body.mesh.triangleFace,
    ...(hasEdges
      ? {
          edges: {
            positions: body.mesh.edgePoints,
            // Polylines are stored one after the other: edge i uses the points pointStart .. pointStart + pointCount - 1.
            offsets: Uint32Array.from([...edges.map((e) => e.pointStart), edges.reduce((end, e) => Math.max(end, e.pointStart + e.pointCount), 0)]),
            ids: Uint32Array.from(edges.map((_, i) => i)),
          },
        }
      : {}),
  };
}

/** Bodies of the committed model; previews of a running command go through the viewport's preview channel (step U3). */
export function committedBodies(view: ModelView): BodyData[] {
  return view.bodies.filter((b) => !b.preview).map(bodyData);
}

/**
 * A finished sketch of the document, drawn neutral (body edge colour; construction lines as construction): no solver state
 * is known for it, so it must not claim to be under- or fully constrained. The plane is the origin plane's own frame.
 */
export function featureSketchData(feature: SketchFeature): SketchData {
  const pos = new Map(feature.sketch.points.map((p) => [p.id, [p.x, p.y] as const]));
  const entities: SketchEntity[] = [];
  for (const l of feature.sketch.lines) {
    const a = pos.get(l.p1);
    const b = pos.get(l.p2);
    if (a && b) entities.push({ id: entityNumber(l.id), kind: l.construction ? "construction" : "bodyEdge", geometry: { type: "line", a, b } });
  }
  for (const c of feature.sketch.circles) {
    const m = pos.get(c.center);
    if (m) entities.push({ id: entityNumber(c.id), kind: c.construction ? "construction" : "bodyEdge", geometry: { type: "circle", center: m, radius: c.radius } });
  }
  return { id: feature.id, plane: originPlaneFrame(feature.plane.plane), entities };
}
