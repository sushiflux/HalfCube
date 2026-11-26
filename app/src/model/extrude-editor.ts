// Extrude command: the dialog values are previewed through the engine (model.sync with purpose preview, the
// committed document plus this step), so the preview is exactly what OK produces and the UI computes no geometry.
// OK commits only after the preview of exactly these values succeeded; Cancel sends the committed document again.
//
// The regions of the sketch for hover and selection come from one sketch.solve with profiles when the command opens
// (with the element states, so every region also says whether it is determined).
import type { Reply } from "../engine/client.ts";
import type { StepStatus } from "../engine/generated/protocol.ts";
import type { DocumentStore } from "../document/store.ts";
import type { Body, ExtrudeFeature, HalfCubeDocument } from "../document/types.ts";
import { appendFeature, bodyOf, extrudeFeature, replaceFeature, sketchFeature, withBody } from "./doc-edit.ts";
import type { EditOutcome, ExtrudeEditor, ExtrudeParams, ExtrudeView } from "./editors.ts";
import type { EngineLink } from "./engine-link.ts";
import type { LatestResult } from "./latest-only.ts";
import type { ModelSync } from "./model-sync.ts";
import { solveSketchProfiles } from "./sketch-profiles.ts";

export interface ExtrudeEditorDeps {
  link: EngineLink;
  store: DocumentStore;
  sync: ModelSync;
}

export interface ExtrudeStart {
  /** New step: ids and names chosen by the caller. Editing: the existing step and its body. */
  feature: ExtrudeFeature;
  body: Body;
  /** Editing an existing step (it is replaced in place) rather than appending a new one. */
  editing: boolean;
}

export class ExtrudeEditorImpl implements ExtrudeEditor {
  readonly featureId: string;
  private view: ExtrudeView;
  private readonly listeners = new Set<() => void>();
  private readonly deps: ExtrudeEditorDeps;
  private readonly start: ExtrudeStart;
  /** Answer for the current values (replaced on every set). */
  private latest: Promise<LatestResult<Reply<"model.sync">>> | null = null;
  private closed = false;
  private readonly cleanup: (() => void)[] = [];

  constructor(deps: ExtrudeEditorDeps, start: ExtrudeStart) {
    this.deps = deps;
    this.start = start;
    this.featureId = start.feature.id;
    const f = start.feature;
    this.view = {
      featureId: f.id,
      name: f.name,
      bodyId: start.body.id,
      sketch: f.profile.sketch,
      frame: null,
      params: { region: f.profile.region === "" ? null : f.profile.region, extent: f.extent, distance: f.distance },
      profiles: null,
      step: null,
      pending: false,
    };
    this.loadProfiles();
    this.cleanup.push(
      deps.link.onReady(() => {
        if (this.view.profiles === null) this.loadProfiles();
      }),
    );
    this.previewNow();
  }

  getView = (): ExtrudeView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  set(patch: Partial<ExtrudeParams>): void {
    if (this.closed) return;
    this.update({ params: { ...this.view.params, ...patch } });
    this.previewNow();
  }

  async commit(): Promise<EditOutcome> {
    if (this.closed) return { ok: false, reason: "invalid", message: "The extrude command is already closed." };
    if (this.view.params.region === null) return { ok: false, reason: "invalid", message: "Choose a profile to extrude first." };
    // Wait for the answer to exactly the current values (a newer set replaces the promise).
    for (;;) {
      const pending = this.latest;
      if (!pending) return { ok: false, reason: "invalid", message: "There is no preview to commit." };
      const r = await pending;
      if (this.closed) return { ok: false, reason: "invalid", message: "The extrude command is already closed." };
      if (pending !== this.latest) continue;
      if (r.kind === "superseded") {
        this.previewNow();
        continue;
      }
      if (r.kind === "failed") return { ok: false, reason: "engine", error: r.error };
      const step = r.value.message.steps.find((s) => s.featureId === this.featureId);
      if (step?.problem && step.state === "error") {
        return { ok: false, reason: "rejected", problem: step.problem, conflicting: [], redundant: [] };
      }
      break;
    }
    const doc = this.build(this.deps.store.getSnapshot());
    this.close();
    this.deps.store.commit(doc);
    void this.deps.sync.clearPreview();
    return { ok: true };
  }

  cancel(): void {
    if (this.closed) return;
    this.close();
    void this.deps.sync.clearPreview();
  }

  // ------------------------------------------------------------------------------------------------ internals

  private feature(): ExtrudeFeature {
    const p = this.view.params;
    return {
      ...this.start.feature,
      profile: { sketch: this.view.sketch, region: p.region ?? "" },
      extent: p.extent,
      distance: p.distance,
    };
  }

  /** The document with this step: appended (new) or replaced in place (editing). */
  private build(committed: HalfCubeDocument): HalfCubeDocument {
    const feature = this.feature();
    const withStep = this.start.editing && extrudeFeature(committed, feature.id) ? replaceFeature(committed, feature) : appendFeature(committed, feature);
    return bodyOf(withStep, this.start.body.id) ? withStep : withBody(withStep, this.start.body);
  }

  private previewNow(): void {
    if (this.view.params.region === null) {
      // Nothing to show yet: the committed model (an edited step keeps its old body until a region is chosen).
      this.latest = null;
      return;
    }
    this.update({ pending: true });
    const promise = this.deps.sync.setPreview({ build: (c) => this.build(c), features: [this.featureId] });
    this.latest = promise;
    void promise.then((r) => {
      if (this.closed || promise !== this.latest) return;
      if (r.kind === "done") {
        const step: StepStatus | undefined = r.value.message.steps.find((s) => s.featureId === this.featureId);
        const next: ExtrudeView = { ...this.view, step: step ?? null, pending: false };
        delete next.error;
        this.view = next;
        this.emit();
      } else if (r.kind === "failed") {
        this.update({ pending: false, error: r.error });
      }
    });
  }

  private loadProfiles(): void {
    const sketch = sketchFeature(this.deps.store.getSnapshot(), this.view.sketch);
    if (!sketch || !this.deps.link.isReady()) return;
    solveSketchProfiles(this.deps.link, sketch).then(
      (result) => {
        if (!this.closed) this.update({ frame: result.frame, profiles: result.profiles });
      },
      (e: unknown) => {
        if (!this.closed) this.update({ error: e instanceof Error ? e : new Error(String(e)) });
      },
    );
  }

  private close(): void {
    this.closed = true;
    for (const c of this.cleanup.splice(0)) c();
  }

  private update(patch: Partial<ExtrudeView>): void {
    this.view = { ...this.view, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}
