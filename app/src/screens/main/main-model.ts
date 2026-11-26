// The one model of the running page: the document the user works on, kept in step with the engine. It is created on first
// use (not in a React initialiser, which strict mode runs twice and would leave a second model listening) and lives as long
// as the page. After a reload the document comes back from the tab's session storage (autosave.ts).
import { createEmptyDocument, type HalfCubeDocument } from "../../document/index.ts";
import { createHalfCubeModel, featureNames, linkSession, type EngineLink, type HalfCubeModelImpl, type SketchEditor } from "../../model/index.ts";
import type { EngineSession } from "../../engine/index.ts";
import { i18n } from "../../i18n/runtime.ts";
import { currentVersion } from "../../version.ts";
import type { SketchLayer } from "../../viewport/sketch/types.ts";
import type { Viewport } from "../../viewport/types.ts";
import type { SketchSession } from "../sketch/session.ts";
import { loadSessionDocument, saveSessionDocument } from "./autosave.ts";
import type { ExtrudeCommand } from "./extrude-command.ts";

/** Stands in for the engine where there is none (demo scenes): never ready, every request fails with a clear message. */
export const offlineLink: EngineLink = {
  isReady: () => false,
  onReady: () => () => undefined,
  request: () => {
    throw new Error("No engine is running in this scene, so the model cannot be computed.");
  },
  cancel: () => undefined,
};

function newDocument(): HalfCubeDocument {
  return createEmptyDocument({ rootName: featureNames(i18n.getState().t).root });
}

/** What the dev channel puts on window for the tests. */
export interface DevHooks {
  __halfcube?: {
    model: HalfCubeModelImpl;
    editor: SketchEditor | null;
    session: SketchSession | null;
    layer: SketchLayer | null;
    viewport: Viewport | null;
    /** The extrude command: tests start, pick, type and confirm through the same functions the dialog calls. */
    extrude: ExtrudeCommand | null;
  };
}

let cached: { session: EngineSession | null; model: HalfCubeModelImpl } | undefined;

export function getMainModel(session: EngineSession | null): HalfCubeModelImpl {
  if (cached && cached.session === session) return cached.model;
  cached?.model.dispose();
  const { t } = i18n.getState();
  const model = createHalfCubeModel(session ? linkSession(session) : offlineLink, loadSessionDocument() ?? newDocument(), {
    names: featureNames(t),
  });
  model.document.subscribe(() => saveSessionDocument(model.document.getSnapshot()));
  cached = { session, model };
  // Dev channel only: lets the end-to-end tests call the same functions the UI calls (model, open sketch editor).
  if (currentVersion().channel === "dev" && typeof window !== "undefined") (window as unknown as DevHooks).__halfcube = { model, editor: null, session: null, layer: null, viewport: null, extrude: null };
  return model;
}

/** "Neues Teil": starts over with an empty document (no undo history), but only when there is something to throw away. */
export function startNewDocument(model: HalfCubeModelImpl): void {
  if (model.document.getSnapshot().timeline.length === 0) return;
  model.document.load(newDocument());
}
