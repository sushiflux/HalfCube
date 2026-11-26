// ModelSync keeps the engine's model in step with the document: after every committed change (and every undo or
// redo) it sends the whole document with model.sync; while a dialog previews a step it sends the committed document
// plus that step as a preview. Requests go through LatestOnly, so fast changes never pile up.
//
// Revisions keep counting across engine restarts. When an engine becomes ready again after a crash, the current
// state (committed document, or the open preview built on it) is simply sent again: the engine keeps no editing
// state, so that is all a restart needs.
//
// While a sketch is open no model.sync is sent (the body is rebuilt when the sketch is finished); hold() does that.
import type { Reply } from "../engine/client.ts";
import type { ModelResult } from "../engine/generated/protocol.ts";
import type { WatchdogClock } from "../engine/watchdog.ts";
import type { DocumentStore } from "../document/store.ts";
import type { PartcraftDocument } from "../document/types.ts";
import type { ModelView } from "./editors.ts";
import { MODEL_SYNC_TIMEOUT_MS, type EngineLink } from "./engine-link.ts";
import { LatestOnly, type LatestResult } from "./latest-only.ts";
import { bodyView } from "./payload.ts";

export interface ModelPreview {
  /** The previewed document, built on the committed one at the moment it is sent. */
  build(committed: PartcraftDocument): PartcraftDocument;
  /** Steps being previewed (their bodies are marked preview). */
  features: string[];
}

interface SyncRequest {
  document: PartcraftDocument;
  purpose: "commit" | "preview";
  features: string[];
}

export interface ModelSyncOptions {
  clock?: WatchdogClock;
}

const EMPTY_VIEW: ModelView = {
  revision: 0,
  purpose: null,
  outcome: null,
  steps: [],
  bodies: [],
  timings: null,
  pending: false,
};

export class ModelSync {
  private view: ModelView = EMPTY_VIEW;
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private holds = 0;
  private preview: ModelPreview | null = null;
  /** Document and purpose of the last submitted request, to skip sending the same state twice. */
  private last: { document: PartcraftDocument; purpose: string } | null = null;
  private readonly lane: LatestOnly<SyncRequest, Reply<"model.sync">>;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly link: EngineLink;
  private readonly store: DocumentStore;

  constructor(link: EngineLink, store: DocumentStore, options: ModelSyncOptions = {}) {
    this.link = link;
    this.store = store;
    this.lane = new LatestOnly<SyncRequest, Reply<"model.sync">>({
      clock: options.clock,
      send: (r) =>
        link.request(
          {
            type: "model.sync",
            revision: ++this.revision,
            document: r.document,
            purpose: r.purpose,
            ...(r.purpose === "preview" ? { previewFeatures: r.features } : {}),
          },
          { timeoutMs: MODEL_SYNC_TIMEOUT_MS },
        ),
      cancel: (id) => link.cancel(id),
    });
    this.unsubscribe.push(store.subscribe(() => void this.sync()));
    this.unsubscribe.push(
      link.onReady(() => {
        this.last = null; // a new engine knows nothing: send the current state again
        void this.sync();
      }),
    );
    if (link.isReady()) void this.sync();
  }

  getView = (): ModelView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Last revision sent (keeps counting across engine restarts). */
  get lastRevision(): number {
    return this.revision;
  }

  /** Stops sending committed changes until the returned function is called (open sketch). */
  hold(): () => void {
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      void this.sync();
    };
  }

  /** Shows a preview (dialog open or a value changed); resolves with the engine's answer for exactly this state. */
  setPreview(preview: ModelPreview): Promise<LatestResult<Reply<"model.sync">>> {
    this.preview = preview;
    return this.sync(true);
  }

  /** Ends the preview; the committed document is shown again. */
  clearPreview(): Promise<LatestResult<Reply<"model.sync">>> {
    this.preview = null;
    return this.sync(true);
  }

  /** Sends the current state unless it was the last one sent (force: always). */
  sync(force = false): Promise<LatestResult<Reply<"model.sync">>> {
    const committed = this.store.getSnapshot();
    if (!this.preview && this.holds > 0) return Promise.resolve({ kind: "superseded" });
    const request: SyncRequest = this.preview
      ? { document: this.preview.build(committed), purpose: "preview", features: this.preview.features }
      : { document: committed, purpose: "commit", features: [] };
    if (!force && this.last && this.last.document === request.document && this.last.purpose === request.purpose) {
      return Promise.resolve({ kind: "superseded" });
    }
    if (!this.link.isReady()) {
      this.last = null; // sent when the engine is ready
      return Promise.resolve({ kind: "failed", error: new Error("The engine is not ready; the model is rebuilt as soon as it is.") });
    }
    this.last = { document: request.document, purpose: request.purpose };
    this.update({ pending: true });
    const result = this.lane.submit(request);
    void result.then((r) => this.apply(r));
    return result;
  }

  dispose(): void {
    for (const u of this.unsubscribe.splice(0)) u();
    this.lane.reset();
  }

  private apply(r: LatestResult<Reply<"model.sync">>): void {
    if (r.kind === "superseded") return;
    if (r.kind === "failed") {
      this.last = null;
      this.update({ pending: this.lane.busy, error: r.error });
      return;
    }
    const m: ModelResult = r.value.message;
    if (m.revision < this.view.revision) return; // never show an older state
    let bodies: ModelView["bodies"];
    try {
      bodies = m.bodies.map((b) => bodyView(b, r.value.payload));
    } catch (e) {
      this.update({ pending: this.lane.busy, error: e as Error });
      return;
    }
    const next: ModelView = {
      revision: m.revision,
      purpose: m.purpose,
      outcome: m.outcome,
      steps: m.steps,
      bodies,
      timings: m.timings,
      pending: this.lane.busy,
    };
    this.view = next;
    this.emit();
  }

  private update(patch: Partial<ModelView>): void {
    this.view = { ...this.view, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}
