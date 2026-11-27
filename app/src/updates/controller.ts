// The page side of the updater: keeps the state the main process pushes, decides when to check by itself (the schedule setting and
// the time of the last successful check live in the page's preferences) and forwards the user's steps (check, download, restart,
// install on exit). No React and no DOM, so it is unit-tested with a fake bridge. Without the desktop bridge (a bare dev page) nothing
// attaches: the state stays null and no update view appears.
import { useSyncExternalStore } from "react";
import type { Preferences } from "../prefs/preferences.ts";
import { preferences } from "../prefs/preferences.ts";
import { settingsStore } from "../prefs/settings-runtime.ts";
import { isCheckDue, type UpdateCheckMode } from "./schedule.ts";
import type { UpdateError, UpdateErrorCode, UpdateOffer, UpdatePhase, UpdateState, UpdatesBridge } from "./types.ts";
import { isSupported } from "./view-model.ts";

/** The outcome of the last check the user started, kept for the settings view ("Update gefunden", "Du hast die neueste Version"). */
export type ManualResult = { kind: "uptodate" } | { kind: "found"; version: string } | { kind: "error"; error: UpdateError };

export interface UpdatesSnapshot {
  /** The state of the updater; null until the first answer, and always null without a bridge. */
  state: UpdateState | null;
  /** ISO time of the last successful check (automatic or by hand); a failed check never sets it. */
  lastCheckAt: string | null;
  manual: ManualResult | null;
  /** "Jetzt neu starten" was confirmed and the program is about to close. */
  restarting: boolean;
  restartError: UpdateError | null;
}

export const lastCheckPreferenceKey = "updates.lastCheckAt";

export interface ControllerDeps {
  preferences: Pick<Preferences, "get" | "set">;
  getMode: () => UpdateCheckMode;
  now?: () => Date;
}

function unexpected(code: UpdateErrorCode, cause: unknown, now: Date): UpdateError {
  return { code, detail: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause), at: now.toISOString() };
}

/**
 * The update a phase carries, or null. The main process starts the download as soon as a check finds an update, so a
 * successful check that found one answers with "downloading" (rarely "available"), or with "ready" / "on-exit" when it was
 * already there, or "download-failed": all of them mean "an update was found". With "ready" / "on-exit" it is the update that
 * can be installed, also when a newer one failed to download (`newerDownloadFailed`).
 */
export function knownOffer(phase: UpdatePhase): UpdateOffer | null {
  switch (phase.kind) {
    case "available":
    case "downloading":
    case "download-failed":
    case "ready":
    case "on-exit":
      return phase.offer;
    case "none":
    case "up-to-date":
    case "check-failed":
      return null;
  }
}

export class UpdatesController {
  private snapshot: UpdatesSnapshot;
  private bridge: UpdatesBridge | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => Date;
  private readonly deps: ControllerDeps;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.snapshot = {
      state: null,
      lastCheckAt: deps.preferences.get(lastCheckPreferenceKey) ?? null,
      manual: null,
      restarting: false,
      restartError: null,
    };
  }

  getSnapshot = (): UpdatesSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(patch: Partial<UpdatesSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of [...this.listeners]) l();
  }

  private setState(state: UpdateState): void {
    if (this.snapshot.state === state) return;
    this.update({ state });
  }

  /** Starts listening to the main process; returns the function that stops. */
  attach(bridge: UpdatesBridge): () => void {
    this.bridge = bridge;
    let live = true;
    const off = bridge.onState((state) => {
      if (live) this.setState(state);
    });
    void bridge
      .get()
      .then((state) => {
        // A state pushed meanwhile is newer than the answer to get().
        if (live && this.snapshot.state === null) this.setState(state);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      off();
      if (this.bridge === bridge) this.bridge = null;
    };
  }

  /** The updater is there and this program is an installed one. */
  get supported(): boolean {
    return isSupported(this.snapshot.state);
  }

  private rememberCheck(): void {
    const at = this.now().toISOString();
    this.deps.preferences.set(lastCheckPreferenceKey, at);
    this.update({ lastCheckAt: at });
  }

  /**
   * An automatic check, when the schedule says so: right after the main window is shown (`atStartup`), then from a timer. Stays
   * silent: a failure changes nothing visible and is not counted as a check (no new "last checked" time, so the schedule tries
   * again at the next start or timer tick). Never while a download runs; an update that waits for its restart does not stop
   * it, so a newer one is still found (the main process keeps the waiting one until the newer one is verified).
   */
  async autoCheck(atStartup: boolean): Promise<void> {
    const bridge = this.bridge;
    const state = this.snapshot.state;
    if (!bridge || !isSupported(state) || state.checking) return;
    if (state.phase.kind === "downloading") return;
    if (!isCheckDue(this.deps.getMode(), this.snapshot.lastCheckAt, this.now(), atStartup)) return;
    try {
      const result = await bridge.check(false);
      this.setState(result.state);
      if (result.ok) this.rememberCheck();
    } catch {
      // Silent on purpose: an automatic check that cannot reach the server shows nothing.
    }
  }

  /** "Nach Updates suchen": the failure is reported with its code. */
  async checkNow(): Promise<void> {
    const bridge = this.bridge;
    if (!bridge) return;
    // The spinner shows at once, before the main process has pushed its first state.
    const before = this.snapshot.state;
    if (isSupported(before) && !before.checking) this.setState({ ...before, checking: true });
    try {
      const result = await bridge.check(true);
      this.setState(result.state);
      if (result.ok) {
        this.rememberCheck();
        const offer = isSupported(result.state) ? knownOffer(result.state.phase) : null;
        this.update({ manual: offer ? { kind: "found", version: offer.display } : { kind: "uptodate" } });
      } else {
        this.update({ manual: { kind: "error", error: result.error } });
      }
    } catch (cause) {
      this.update({ manual: { kind: "error", error: unexpected("HC-UPDATE-001", cause, this.now()) } });
      // Take the spinner back: the main process never answered.
      const state = this.snapshot.state;
      if (isSupported(state) && state.checking) this.setState({ ...state, checking: false });
    }
  }

  async download(): Promise<void> {
    const bridge = this.bridge;
    if (!bridge) return;
    try {
      await bridge.download();
    } catch (cause) {
      const state = this.snapshot.state;
      if (isSupported(state) && state.phase.kind === "available") {
        this.setState({ ...state, phase: { kind: "download-failed", offer: state.phase.offer, error: unexpected("HC-UPDATE-003", cause, this.now()) } });
      }
    }
  }

  /** Installs now. On success the program closes and this never settles; a failure is kept for the dialog. */
  async restart(): Promise<void> {
    const bridge = this.bridge;
    if (!bridge) return;
    this.update({ restarting: true, restartError: null });
    try {
      const result = await bridge.restartNow();
      this.update({ restarting: false, restartError: result.error });
    } catch (cause) {
      this.update({ restarting: false, restartError: unexpected("HC-UPDATE-004", cause, this.now()) });
    }
  }

  dismissRestartError(): void {
    this.update({ restartError: null });
  }

  async setInstallOnExit(on: boolean): Promise<void> {
    const bridge = this.bridge;
    if (!bridge) return;
    try {
      this.setState(await bridge.setInstallOnExit(on));
    } catch (cause) {
      this.update({ restartError: unexpected("HC-UPDATE-004", cause, this.now()) });
    }
  }
}

/** The one controller of the running page. */
export const updates = new UpdatesController({ preferences, getMode: () => settingsStore.getState().updateCheck });

export function useUpdates(): UpdatesSnapshot {
  return useSyncExternalStore(updates.subscribe, updates.getSnapshot, updates.getSnapshot);
}
