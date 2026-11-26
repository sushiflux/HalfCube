// Whether "About HalfCube" is open, on which tab, and which component's licence it shows. The state lives in the address
// (`?about=licenses&item=occt`), so a reload (F5) keeps the view, on the desktop too. One store for the whole window: the
// status bar, the title bar and the welcome screen only call `open`, and the one dialog in the app shell reads it.
import { useSyncExternalStore } from "react";
import { patchUrl, readUrlState, type AboutTab, type UrlPatch, type UrlState } from "../screens/main/url-state.ts";

export interface AboutState {
  tab: AboutTab;
  /** Id of the component shown in the Lizenzen tab; null shows the list. */
  item: string | null;
}

/** The state an address stands for; null when the view is closed. */
export function aboutFromUrl(state: UrlState): AboutState | null {
  if (state.about === undefined) return null;
  return { tab: state.about, item: state.about === "licenses" ? (state.item ?? null) : null };
}

/** The address patch for a state: closing removes both keys, the Info tab never carries an item. */
export function aboutToPatch(state: AboutState | null): UrlPatch {
  if (state === null) return { about: null, item: null };
  return { about: state.tab, item: state.tab === "licenses" ? state.item : null };
}

type Listener = () => void;

export interface AboutStore {
  get: () => AboutState | null;
  /** The last state that was open: the dialog keeps showing it while it fades out. */
  lastOpen: () => AboutState;
  subscribe: (listener: Listener) => () => void;
  open: (next?: Partial<AboutState>) => void;
  setTab: (tab: AboutTab) => void;
  setItem: (item: string | null) => void;
  close: () => void;
}

export function createAboutStore(initial: AboutState | null, persist: (state: AboutState | null) => void = () => undefined): AboutStore {
  let state = initial;
  let last: AboutState = initial ?? { tab: "info", item: null };
  const listeners = new Set<Listener>();
  const set = (next: AboutState | null) => {
    state = next;
    if (next) last = next;
    persist(next);
    for (const l of listeners) l();
  };
  return {
    get: () => state,
    lastOpen: () => last,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open: (next) => {
      const tab = next?.tab ?? "info";
      set({ tab, item: tab === "licenses" ? (next?.item ?? null) : null });
    },
    setTab: (tab) => {
      if (state === null) return;
      set({ tab, item: tab === "licenses" ? state.item : null });
    },
    setItem: (item) => {
      if (state === null) return;
      set({ tab: "licenses", item });
    },
    close: () => set(null),
  };
}

export const aboutStore: AboutStore = createAboutStore(aboutFromUrl(readUrlState()), (state) => patchUrl(aboutToPatch(state)));

export function useAbout(): AboutState | null {
  return useSyncExternalStore(aboutStore.subscribe, aboutStore.get, aboutStore.get);
}
