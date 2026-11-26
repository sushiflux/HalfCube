// Types of the stored Partcraft document. They are generated from the protocol source (documentTypes in
// protocol/engine-protocol.json), so the document the UI holds and the one the engine reads are the same type.
export type {
  Body,
  Component,
  Dimension,
  DocumentSettings,
  ExtrudeFeature,
  Feature,
  GeometricConstraint,
  OriginPlaneRef,
  Parameter,
  PartcraftDocument,
  PlaneRef,
  ProfileRef,
  Quantity,
  SketchCircle,
  SketchConstraint,
  SketchData,
  SketchForm,
  SketchFeature,
  SketchLine,
  SketchPoint,
  SketchStep,
  Vec2,
} from "../engine/generated/protocol.ts";
export { DOCUMENT_FORMAT } from "../engine/generated/protocol.ts";

import type { Dimension, GeometricConstraint, OriginPlaneRef, SketchConstraint } from "../engine/generated/protocol.ts";

export type OriginPlane = OriginPlaneRef["plane"];
export type ConstraintKind = GeometricConstraint["kind"];
export type DimensionKind = Dimension["kind"];

/** Fixed references of every sketch; they are not stored in the document. */
export const SKETCH_ORIGIN = "@origin";
export const SKETCH_AXIS_U = "@axisU";
export const SKETCH_AXIS_V = "@axisV";
export const isReservedId = (id: string): boolean => id.startsWith("@");

const DIMENSION_KINDS: readonly string[] = ["distance", "distanceX", "distanceY", "angle", "diameter", "radius"] satisfies DimensionKind[];

/** A sketch constraint with a value (dimension) rather than a geometric constraint. */
export const isDimension = (c: SketchConstraint): c is Dimension => DIMENSION_KINDS.includes(c.kind);

/** Kind letters of document ids (one counter nextId for all of them; s = sketch step). */
export type IdKind = "p" | "l" | "c" | "k" | "d" | "f" | "b" | "s";
