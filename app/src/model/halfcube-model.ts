// HalfCubeModel: the one object the UI uses for modelling. It owns the document store, keeps the engine's model in
// step (ModelSync) and opens the sketch and extrude editors.
import type { WatchdogClock } from "../engine/watchdog.ts";
import { DocumentStore } from "../document/store.ts";
import type { Body, ExtrudeFeature, OriginPlane, HalfCubeDocument, Quantity, SketchFeature } from "../document/types.ts";
import { appendFeature, bodyOf, extrudeFeature, nextNumber, ROOT_COMPONENT, sketchFeature } from "./doc-edit.ts";
import type { ExtrudeEditor, ExtrudeExtent, ModelView, HalfCubeModel, SketchEditor, SketchProfiles } from "./editors.ts";
import type { EngineLink } from "./engine-link.ts";
import { ExtrudeEditorImpl } from "./extrude-editor.ts";
import { ModelSync } from "./model-sync.ts";
import { SketchEditorImpl } from "./sketch-editor.ts";
import { solveSketchProfiles } from "./sketch-profiles.ts";

/** Default names of new steps and bodies as the user sees them ("Skizze1"); translated by the caller. */
export interface FeatureNames {
  sketch(n: number): string;
  extrude(n: number): string;
  body(n: number): string;
}

export interface HalfCubeModelOptions {
  names: FeatureNames;
  clock?: WatchdogClock;
  /** Default 10 mm. */
  defaultDistance?: Quantity;
}

export class HalfCubeModelImpl implements HalfCubeModel {
  readonly document: DocumentStore;
  readonly sync: ModelSync;
  private readonly link: EngineLink;
  private readonly opts: HalfCubeModelOptions;

  constructor(link: EngineLink, document: HalfCubeDocument | DocumentStore, options: HalfCubeModelOptions) {
    this.link = link;
    this.opts = options;
    this.document = document instanceof DocumentStore ? document : new DocumentStore(document);
    this.sync = new ModelSync(link, this.document, options.clock ? { clock: options.clock } : {});
  }

  getModelView = (): ModelView => this.sync.getView();

  subscribeModel = (listener: () => void): (() => void) => this.sync.subscribe(listener);

  /** Creates a sketch on an origin plane (one undo step) and opens it. */
  async startSketch(plane: OriginPlane): Promise<SketchEditor> {
    const release = this.sync.hold();
    const store = this.document;
    const feature: SketchFeature = {
      id: store.newId("f"),
      type: "sketch",
      name: this.opts.names.sketch(nextNumber(store.getSnapshot(), "sketch")),
      component: ROOT_COMPONENT,
      visible: true,
      plane: { kind: "originPlane", plane },
      sketch: { points: [], lines: [], circles: [], constraints: [], steps: [] },
    };
    store.commit((doc) => appendFeature(doc, feature));
    return SketchEditorImpl.open(this.deps(), feature.id, release);
  }

  async editSketch(featureId: string): Promise<SketchEditor> {
    if (!sketchFeature(this.document.getSnapshot(), featureId)) throw new Error(`The document has no sketch "${featureId}".`);
    return SketchEditorImpl.open(this.deps(), featureId, this.sync.hold());
  }

  startExtrude(init: { sketch: string; region?: string; extent?: ExtrudeExtent; distance?: Quantity }): ExtrudeEditor {
    const doc = this.document.getSnapshot();
    if (!sketchFeature(doc, init.sketch)) throw new Error(`The document has no sketch "${init.sketch}".`);
    const store = this.document;
    const featureId = store.newId("f");
    const bodyId = store.newId("b");
    const feature: ExtrudeFeature = {
      id: featureId,
      type: "extrude",
      name: this.opts.names.extrude(nextNumber(doc, "extrude")),
      component: ROOT_COMPONENT,
      profile: { sketch: init.sketch, region: init.region ?? "" },
      extent: init.extent ?? "oneSide",
      distance: init.distance ?? this.opts.defaultDistance ?? { value: 10, unit: "mm" },
      operation: "newBody",
      body: bodyId,
    };
    const bodies = doc.components.reduce((n, c) => n + c.bodies.length, 0);
    const body: Body = { id: bodyId, name: this.opts.names.body(bodies + 1), createdBy: featureId, visible: true };
    return new ExtrudeEditorImpl(this.deps(), { feature, body, editing: false });
  }

  editExtrude(featureId: string): ExtrudeEditor {
    const doc = this.document.getSnapshot();
    const feature = extrudeFeature(doc, featureId);
    if (!feature) throw new Error(`The document has no extrusion "${featureId}".`);
    const body = bodyOf(doc, feature.body);
    if (!body) throw new Error(`The document has no body "${feature.body}" for the extrusion "${featureId}".`);
    return new ExtrudeEditorImpl(this.deps(), { feature, body, editing: true });
  }

  sketchProfiles(sketch: SketchFeature): Promise<SketchProfiles> {
    return solveSketchProfiles(this.link, sketch);
  }

  undo(): boolean {
    return this.document.undo();
  }

  redo(): boolean {
    return this.document.redo();
  }

  dispose(): void {
    this.sync.dispose();
  }

  private deps() {
    return {
      link: this.link,
      store: this.document,
      sync: this.sync,
      ...(this.opts.clock ? { clock: this.opts.clock } : {}),
    };
  }
}

export function createHalfCubeModel(link: EngineLink, document: HalfCubeDocument | DocumentStore, options: HalfCubeModelOptions): HalfCubeModelImpl {
  return new HalfCubeModelImpl(link, document, options);
}
