// Public surface of the document layer.
export * from "./types.ts";
export { createEmptyDocument } from "./create.ts";
export type { NewDocumentOptions } from "./create.ts";
export { DocumentStore } from "./store.ts";
export type { ChangeKind, DocumentListener, DocumentStoreOptions, UndoGroup } from "./store.ts";
export { deg, formatQuantity, mm, parseQuantity } from "./quantity.ts";
export type { ParseOptions, QuantityErrorCode, QuantityKind, QuantityParse } from "./quantity.ts";
export { assertValidDocument, canonicalDocument, documentProblems, serializeDocument } from "./validate.ts";
export { geometryOf, labelPlacement, labelPosition } from "./dimension-label.ts";
export type { LabelGeometry } from "./dimension-label.ts";
export { absoluteLabelsToRelative, numberNamesInDocument } from "./migrate.ts";
export { dimensionName, highestParameterNumber, nextParameterOf, numberDimensions, parameterName } from "./parameter-names.ts";
export { formOfShapes, formsOf, isShapeStep, nextShapeNumber, numberShapes, reconcileForms, shapeKinds, shapesOf, shapesOfElements } from "./shape-names.ts";
export type { Form, Shape, ShapeKind } from "./shape-names.ts";
export { angleRays, measuredSegment } from "./dimension-label.ts";
export type { MeasuredSegment, UV } from "./dimension-label.ts";
export { angleSectorAt, linesParallel } from "./angle-sector.ts";
export type { AngleSector } from "./angle-sector.ts";
