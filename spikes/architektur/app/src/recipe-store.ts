// Document store: the UI owns the recipe (concept 3.2). Every change is a new immutable recipe plus an undo
// entry; the engine session only mirrors it to the engine.
import type { Recipe } from "../../protocol/protocol.ts";

export type RecipeChange =
  | { kind: "parameter"; name: string; value: number }
  | { kind: "replace"; reason: string }
  | { kind: "undo" }
  | { kind: "redo" };

export class RecipeStore {
  private recipe: Recipe;
  private undoStack: Recipe[] = [];
  private redoStack: Recipe[] = [];
  /** Increases with every change; React components use it as their snapshot. */
  revision = 0;
  private listeners = new Set<(c: RecipeChange) => void>();

  constructor(initial: Recipe) {
    this.recipe = structuredClone(initial);
  }

  get current(): Readonly<Recipe> {
    return this.recipe;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  subscribe(fn: (c: RecipeChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setParameter(name: string, value: number) {
    if (!(name in this.recipe.parameters)) throw new Error(`Unknown parameter "${name}".`);
    if (this.recipe.parameters[name] === value) return;
    this.commit({ ...this.recipe, parameters: { ...this.recipe.parameters, [name]: value } }, { kind: "parameter", name, value });
  }

  replace(recipe: Recipe, reason: string) {
    this.commit(structuredClone(recipe), { kind: "replace", reason });
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.recipe);
    this.recipe = prev;
    this.emit({ kind: "undo" });
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.recipe);
    this.recipe = next;
    this.emit({ kind: "redo" });
  }

  /**
   * Test only: changes a parameter without an undo entry and without notifying the engine session, so a test
   * can send the matching commands itself (stale-reply bursts).
   */
  setParameterSilently(name: string, value: number) {
    this.recipe = { ...this.recipe, parameters: { ...this.recipe.parameters, [name]: value } };
    this.revision++;
  }

  private commit(next: Recipe, change: RecipeChange) {
    this.undoStack.push(this.recipe);
    this.redoStack = [];
    this.recipe = next;
    this.emit(change);
  }

  private emit(c: RecipeChange) {
    this.revision++;
    for (const l of [...this.listeners]) l(c);
  }
}
