// The work that a restart would lose. HalfCube cannot save designs yet, so every step of the timeline of the open design counts. The
// main window reports it here; the restart flow of the update asks.
import { useSyncExternalStore } from "react";

export interface DesignWork {
  /** The name of the design as the tab shows it. */
  name: string;
  /** Steps in the timeline. */
  steps: number;
}

/** A restart needs the warning only when the open design has something in it. */
export function restartNeedsWarning(work: DesignWork | null): work is DesignWork {
  return work !== null && work.steps > 0;
}

export interface WorkStore {
  get: () => DesignWork | null;
  set: (work: DesignWork | null) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createWorkStore(): WorkStore {
  let current: DesignWork | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(work) {
      if (current?.name === work?.name && current?.steps === work?.steps) return;
      current = work;
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const workStore: WorkStore = createWorkStore();

export function useDesignWork(): DesignWork | null {
  return useSyncExternalStore(workStore.subscribe, workStore.get, workStore.get);
}
