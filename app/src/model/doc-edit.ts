// Small immutable edits of the document: every function returns a new document and shares what it did not change.
import type {
  Body,
  ExtrudeFeature,
  Feature,
  OriginPlane,
  HalfCubeDocument,
  SketchData,
  SketchFeature,
} from "../document/types.ts";

export const ROOT_COMPONENT = "root";

export function findFeature(doc: HalfCubeDocument, id: string): Feature | undefined {
  return doc.timeline.find((f) => f.id === id);
}

export function sketchFeature(doc: HalfCubeDocument, id: string): SketchFeature | undefined {
  const f = findFeature(doc, id);
  return f && f.type === "sketch" ? f : undefined;
}

export function extrudeFeature(doc: HalfCubeDocument, id: string): ExtrudeFeature | undefined {
  const f = findFeature(doc, id);
  return f && f.type === "extrude" ? f : undefined;
}

export function planeOf(f: SketchFeature): OriginPlane {
  return f.plane.plane;
}

export function withSketch(doc: HalfCubeDocument, id: string, sketch: SketchData): HalfCubeDocument {
  return { ...doc, timeline: doc.timeline.map((f) => (f.id === id && f.type === "sketch" ? { ...f, sketch } : f)) };
}

export function appendFeature(doc: HalfCubeDocument, feature: Feature): HalfCubeDocument {
  return { ...doc, timeline: [...doc.timeline, feature] };
}

/** Replaces the step with the same id (an edited extrusion keeps its place in the timeline). */
export function replaceFeature(doc: HalfCubeDocument, feature: Feature): HalfCubeDocument {
  return { ...doc, timeline: doc.timeline.map((f) => (f.id === feature.id ? feature : f)) };
}

/** Adds a body to the root component, or replaces the body with the same id. */
export function withBody(doc: HalfCubeDocument, body: Body): HalfCubeDocument {
  return {
    ...doc,
    components: doc.components.map((c) => {
      if (c.id !== ROOT_COMPONENT) return c;
      const exists = c.bodies.some((b) => b.id === body.id);
      return { ...c, bodies: exists ? c.bodies.map((b) => (b.id === body.id ? body : b)) : [...c.bodies, body] };
    }),
  };
}

export function bodyOf(doc: HalfCubeDocument, id: string): Body | undefined {
  for (const c of doc.components) for (const b of c.bodies) if (b.id === id) return b;
  return undefined;
}

/** Number for the next default name ("Skizze3"): one more than the steps of this type so far. */
export function nextNumber(doc: HalfCubeDocument, type: Feature["type"]): number {
  return doc.timeline.filter((f) => f.type === type).length + 1;
}
