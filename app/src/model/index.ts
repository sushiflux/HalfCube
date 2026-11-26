// Public surface of the model layer. The UI imports from here (and from ../document) only, never the engine client.
export type {
  BodyMeshView,
  BodyView,
  ConstraintState,
  DragView,
  EditOutcome,
  EntityState,
  ExtrudeEditor,
  ExtrudeExtent,
  ExtrudeParams,
  ExtrudeView,
  LineOptions,
  ModelView,
  HalfCubeModel,
  PointInput,
  ProfileView,
  SketchCircleView,
  SketchConstraintView,
  SketchDimensionView,
  SketchDrag,
  SketchEditor,
  SketchLineView,
  SketchPointView,
  SketchProfiles,
  SketchView,
  SolveStatus,
} from "./editors.ts";
export { linkSession, MODEL_SYNC_TIMEOUT_MS, SKETCH_SOLVE_TIMEOUT_MS } from "./engine-link.ts";
export type { EngineLink } from "./engine-link.ts";
export { LatestOnly } from "./latest-only.ts";
export type { LatestOnlyOptions, LatestResult } from "./latest-only.ts";
export { ModelSync } from "./model-sync.ts";
export type { ModelPreview } from "./model-sync.ts";
export { createHalfCubeModel, HalfCubeModelImpl } from "./halfcube-model.ts";
export type { FeatureNames, HalfCubeModelOptions } from "./halfcube-model.ts";
export { elementWord, featureNames, problemText, quantityErrorText } from "./texts.ts";
