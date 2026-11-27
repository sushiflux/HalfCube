// Which update view is open: the update window, the restart warning, the error of a failed check, and "Was ist neu". The state
// lives in the address (`?update=window|restart|error`, `?news=1`), so a reload (F5) keeps the view. One store for the whole window;
// the title bar, the info view and the settings only call `open...`, the host in the app shell reads it.
import { useSyncExternalStore } from "react";
import { patchUrl, readUrlState, type ChangesSource, type UpdateView, type UrlPatch, type UrlState } from "../screens/main/url-state.ts";

export interface UpdateUiState {
  view: UpdateView | null;
  news: boolean;
  /** The dialog "Alle Änderungen" and where its entries come from. */
  changes: ChangesSource | null;
}

export function updateUiFromUrl(state: UrlState): UpdateUiState {
  return { view: state.update ?? null, news: state.news === "1", changes: state.changes ?? null };
}

export function updateUiToPatch(state: UpdateUiState): UrlPatch {
  return { update: state.view, news: state.news ? "1" : null, changes: state.changes };
}

type Listener = () => void;

export interface UpdateUiStore {
  get: () => UpdateUiState;
  subscribe: (listener: Listener) => () => void;
  /** The update window (variant 2: installed and new version side by side). */
  openWindow: () => void;
  openRestart: () => void;
  openError: () => void;
  closeView: () => void;
  openNews: () => void;
  closeNews: () => void;
  openChanges: (source: ChangesSource) => void;
  closeChanges: () => void;
}

export function createUpdateUiStore(initial: UpdateUiState, persist: (state: UpdateUiState) => void = () => undefined): UpdateUiStore {
  let state = initial;
  const listeners = new Set<Listener>();
  const set = (next: UpdateUiState) => {
    if (next.view === state.view && next.news === state.news && next.changes === state.changes) return;
    state = next;
    persist(next);
    for (const l of [...listeners]) l();
  };
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openWindow: () => set({ ...state, view: "window" }),
    openRestart: () => set({ ...state, view: "restart" }),
    openError: () => set({ ...state, view: "error" }),
    closeView: () => set({ ...state, view: null }),
    openNews: () => set({ ...state, news: true }),
    closeNews: () => set({ ...state, news: false }),
    openChanges: (source) => set({ ...state, changes: source }),
    closeChanges: () => set({ ...state, changes: null }),
  };
}

export const updateUi: UpdateUiStore = createUpdateUiStore(updateUiFromUrl(readUrlState()), (state) => patchUrl(updateUiToPatch(state)));

export function useUpdateUi(): UpdateUiState {
  return useSyncExternalStore(updateUi.subscribe, updateUi.get, updateUi.get);
}
