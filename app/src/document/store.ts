// Document store: holds the document the UI edits as an immutable snapshot, with undo and redo as two stacks of
// whole document states (unchanged parts are shared, not copied). One user action is one undo step; previews never
// touch the store.
//
// One user action that needs several commits (a rectangle and the two dimensions typed with it, a new dimension and
// its typed value) is still one undo step: beginGroup() makes every commit until close() join the undo entry of the
// first one. Groups do not nest, and undo, redo and load end the open group.
//
// Ids come from one counter for the whole document and are never reused. The counter therefore lives outside the
// undo steps: undoing a line does not give its id back, and the next commit writes the higher counter into the
// document. The numbers of the automatic dimension names (d0, d1 ...) work the same way, from a counter of their own
// (newParameterNumber). Works with React's useSyncExternalStore: getSnapshot returns the same object until the next change.
import { nextParameterOf } from "./parameter-names.ts";
import { documentProblems } from "./validate.ts";
import type { IdKind, HalfCubeDocument } from "./types.ts";

export interface DocumentStoreOptions {
  /** Undo depth. Default 200. */
  maxUndo?: number;
  /** Check every committed document against the schema (throws on a violation). Default true. */
  validate?: boolean;
}

export type DocumentListener = () => void;

/** What the last change of the snapshot was. "join" is a commit that went into the undo step of its open group. */
export type ChangeKind = "commit" | "join" | "undo" | "redo" | "load";

/** An open undo group (DocumentStore.beginGroup). */
export interface UndoGroup {
  /** False once close() was called or undo, redo or load ended the group. */
  readonly open: boolean;
  /** Ends the group. Safe to call again. A group without a commit leaves no undo step behind. */
  close(): void;
}

/** One undo step: the document as it was before the step. The object's identity is how a group finds its step again. */
interface UndoEntry {
  readonly before: HalfCubeDocument;
}

interface GroupState {
  /** The undo step the group's first commit made; null until then. */
  entry: UndoEntry | null;
}

export class DocumentStore {
  private doc: HalfCubeDocument;
  private readonly undoStack: UndoEntry[] = [];
  private readonly redoStack: HalfCubeDocument[] = [];
  private counter: number;
  private parameterCounter: number;
  private readonly listeners = new Set<DocumentListener>();
  private readonly maxUndo: number;
  private readonly validate: boolean;
  private changes = 0;
  private last: ChangeKind = "load";
  private openGroup: GroupState | null = null;

  constructor(initial: HalfCubeDocument, options: DocumentStoreOptions = {}) {
    this.maxUndo = options.maxUndo ?? 200;
    this.validate = options.validate ?? true;
    this.check(initial);
    this.doc = initial;
    this.counter = initial.nextId;
    this.parameterCounter = nextParameterOf(initial);
  }

  getSnapshot = (): HalfCubeDocument => this.doc;

  subscribe = (listener: DocumentListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Counts every change of the snapshot (commit, join, undo, redo, load); for tests and change detection. Not the number of undo steps. */
  get changeCount(): number {
    return this.changes;
  }

  /** What the change was that the listeners are being told about (or were told about last). */
  get lastChange(): ChangeKind {
    return this.last;
  }

  /** True while a group is open. */
  get grouping(): boolean {
    return this.openGroup !== null;
  }

  /** Next value of the id counter (what nextId will be in the next committed document). */
  get nextIdValue(): number {
    return this.counter;
  }

  /** Next value of the counter of the automatic dimension names (what nextParameter will be in the next committed document). */
  get nextParameterValue(): number {
    return this.parameterCounter;
  }

  /**
   * A new number for an automatic name (d17) that was never used in this document: a dimension takes one when it is made, an
   * extrusion's distance can take one the same way. Never comes back, not after an undo. Not an undo step.
   */
  newParameterNumber(): number {
    return this.parameterCounter++;
  }

  /** A new id that was never used in this document, e.g. newId("l") -> "l17". Not an undo step. */
  newId(kind: IdKind): string {
    return `${kind}${this.counter++}`;
  }

  /**
   * Commits a new document state as one undo step and clears the redo stack. The document's nextId is raised to the
   * store's counter. Returns the committed snapshot. Committing an identical object is a no-op.
   *
   * While a group is open only its first commit makes an undo step; later ones are merged into that step (a "join").
   * If the group's step is no longer the newest one (it fell out of the undo depth), the commit starts a new step and
   * the group continues with that.
   */
  commit(next: HalfCubeDocument | ((current: HalfCubeDocument) => HalfCubeDocument)): HalfCubeDocument {
    const proposed = typeof next === "function" ? next(this.doc) : next;
    if (proposed === this.doc) return this.doc;
    this.counter = Math.max(this.counter, proposed.nextId);
    this.parameterCounter = Math.max(this.parameterCounter, nextParameterOf(proposed));
    let doc = proposed.nextId === this.counter ? proposed : { ...proposed, nextId: this.counter };
    // The counter of the names is written once a name was handed out (documents that have none keep their shape: absent means 0).
    if ((doc.nextParameter ?? 0) !== this.parameterCounter) doc = { ...doc, nextParameter: this.parameterCounter };
    this.check(doc);
    const group = this.openGroup;
    const joins = group !== null && group.entry !== null && group.entry === this.undoStack.at(-1);
    if (!joins) {
      const entry: UndoEntry = { before: this.doc };
      this.undoStack.push(entry);
      if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
      if (group) group.entry = entry;
    }
    this.redoStack.length = 0;
    this.set(doc, joins ? "join" : "commit");
    return doc;
  }

  /**
   * Starts a group: every commit until close() is one undo step, one undo removes all of them and one redo brings them
   * back. For one user action that needs several commits. Throws when a group is open already (groups do not nest:
   * two actions at once would be a bug of the caller). Undo, redo and load end the group.
   */
  beginGroup(): UndoGroup {
    if (this.openGroup) throw new Error("An undo group is already open; groups cannot be nested.");
    const state: GroupState = { entry: null };
    this.openGroup = state;
    const isOpen = (): boolean => this.openGroup === state;
    return {
      get open() {
        return isOpen();
      },
      close: () => {
        if (isOpen()) this.openGroup = null;
      },
    };
  }

  /** Runs fn inside a group and closes the group afterwards, also when fn throws. */
  group<T>(fn: () => T): T {
    const group = this.beginGroup();
    try {
      return fn();
    } finally {
      group.close();
    }
  }

  /** Like group() for an async action: the group stays open until the promise settles. */
  async groupAsync<T>(fn: () => Promise<T>): Promise<T> {
    const group = this.beginGroup();
    try {
      return await fn();
    } finally {
      group.close();
    }
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.openGroup = null;
    this.redoStack.push(this.doc);
    this.set(entry.before, "undo");
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.openGroup = null;
    this.undoStack.push({ before: this.doc });
    this.set(next, "redo");
    return true;
  }

  /** Replaces the document without undo history (new or opened document). */
  load(doc: HalfCubeDocument): void {
    this.check(doc);
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.counter = doc.nextId;
    this.parameterCounter = nextParameterOf(doc);
    this.openGroup = null;
    this.set(doc, "load");
  }

  private check(doc: HalfCubeDocument): void {
    if (!this.validate) return;
    const problems = documentProblems(doc);
    if (problems.length) throw new Error(`The document store refused an invalid document: ${problems.join(" ")}`);
  }

  private set(doc: HalfCubeDocument, kind: ChangeKind): void {
    this.doc = doc;
    this.last = kind;
    this.changes++;
    for (const l of [...this.listeners]) l();
  }
}
