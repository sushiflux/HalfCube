// React views on the model layer: each hook is one useSyncExternalStore over a store the model layer exposes.
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { PartcraftDocument, SketchFeature } from "../../document/types.ts";
import type { ModelView, PartcraftModel, SketchEditor, SketchView } from "../../model/index.ts";
import { ExtrudeCommand, type CommittedStep, type ExtrudeState } from "./extrude-command.ts";
import { ProfileCatalogue, type CatalogueEntry } from "./profile-catalogue.ts";

export function useDocument(model: PartcraftModel): PartcraftDocument {
  return useSyncExternalStore(model.document.subscribe, model.document.getSnapshot);
}

export function useModelView(model: PartcraftModel): ModelView {
  return useSyncExternalStore(model.subscribeModel, model.getModelView);
}

/** The view of the open sketch, or null while no sketch is open. */
export function useSketchView(editor: SketchEditor | null): SketchView | null {
  const subscribe = useCallback((listener: () => void) => (editor ? editor.subscribe(listener) : () => undefined), [editor]);
  const read = useCallback(() => (editor ? editor.getView() : null), [editor]);
  return useSyncExternalStore(subscribe, read);
}

/**
 * The closed areas of the finished sketches (see profile-catalogue.ts). The open sketch is left out (its data changes with every
 * edit), and so is a sketch without any line or circle. Asked again when the engine becomes ready.
 */
export function useProfileCatalogue(model: PartcraftModel, doc: PartcraftDocument, openSketchId: string | null, engineReady: boolean): readonly CatalogueEntry[] {
  const catalogue = useMemo(() => new ProfileCatalogue((feature) => model.sketchProfiles(feature)), [model]);
  useEffect(() => {
    const finished = doc.timeline.filter(
      (f): f is SketchFeature => f.type === "sketch" && f.id !== openSketchId && f.sketch.lines.length + f.sketch.circles.length > 0,
    );
    catalogue.sync(finished, engineReady);
  }, [catalogue, doc, openSketchId, engineReady]);
  return useSyncExternalStore(catalogue.subscribe, catalogue.getSnapshot);
}

/** The extrude command of this model and its state. */
export function useExtrudeCommand(model: PartcraftModel, decimalComma: boolean, onCommitted: (step: CommittedStep) => void): { command: ExtrudeCommand; state: ExtrudeState } {
  const command = useMemo(() => new ExtrudeCommand(model, { decimalComma: false }), [model]);
  useEffect(() => {
    command.configure({ decimalComma, onCommitted });
  }, [command, decimalComma, onCommitted]);
  useEffect(() => () => command.dispose(), [command]);
  const state = useSyncExternalStore(command.subscribe, command.getState);
  return { command, state };
}
