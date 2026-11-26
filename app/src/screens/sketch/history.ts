// Undo and redo inside an open sketch: they reach back only as far as the steps made in the sketch. The document's undo
// stack also holds what happened before the sketch was opened (its creation, other features); undoing that would pull the
// sketch away under the editor. So the history counts its own steps: every document change that does not come from undo
// or redo is a step of the sketch, and undo stops when none is left. A commit that joins an open undo group (one user
// action made of several commits) is part of a step that is counted already.
import type { ChangeKind } from "../../document/index.ts";

export interface HistoryStore {
  /** What the change was that the listeners are told about now. */
  readonly lastChange: ChangeKind;
  subscribe(listener: () => void): () => void;
  undo(): boolean;
  redo(): boolean;
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

export class SketchHistory {
  private undoable = 0;
  private redoable = 0;
  private own = false;
  private state: HistoryState = { canUndo: false, canRedo: false };
  private readonly listeners = new Set<() => void>();
  private readonly off: () => void;

  private readonly store: HistoryStore;

  constructor(store: HistoryStore) {
    this.store = store;
    this.off = store.subscribe(() => {
      // A change that is not ours is a new edit of the sketch: it is one more step to undo and ends the redo chain.
      if (this.own) return;
      // A join belongs to the step its group started; the redo chain ended with that step.
      if (this.store.lastChange === "join") return;
      this.undoable += 1;
      this.redoable = 0;
      this.refresh();
    });
  }

  getState = (): HistoryState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  undo(): boolean {
    if (this.undoable === 0) return false;
    this.own = true;
    try {
      if (!this.store.undo()) return false;
    } finally {
      this.own = false;
    }
    this.undoable -= 1;
    this.redoable += 1;
    this.refresh();
    return true;
  }

  redo(): boolean {
    if (this.redoable === 0) return false;
    this.own = true;
    try {
      if (!this.store.redo()) return false;
    } finally {
      this.own = false;
    }
    this.redoable -= 1;
    this.undoable += 1;
    this.refresh();
    return true;
  }

  dispose(): void {
    this.off();
    this.listeners.clear();
  }

  private refresh(): void {
    const next = { canUndo: this.undoable > 0, canRedo: this.redoable > 0 };
    if (next.canUndo === this.state.canUndo && next.canRedo === this.state.canRedo) return;
    this.state = next;
    for (const l of [...this.listeners]) l();
  }
}
