// What the update views show for a state of the updater: which shape the dot on the info icon has and which state the update
// slot of "Über HalfCube" is in. Pure; the components only draw what this says.
import type { NewerDownloadFailure, UpdateError, UpdatePhase, UpdateState } from "./types.ts";

/** The state of the update slot in "Über HalfCube" (one slot, one state at a time). */
export type SlotKind = "none" | "checking" | "uptodate" | "found" | "dl" | "ready" | "exit" | "failed" | "faildl";

/** The shape on the info icon: nothing, dot, ring (downloading), ring and check (ready), hollow dot (on exit), warning triangle. */
export type IconKind = "none" | "found" | "dl" | "ready" | "exit" | "failed";

export type SupportedState = Extract<UpdateState, { supported: true }>;

export function isSupported(state: UpdateState | null): state is SupportedState {
  return state !== null && state.supported;
}

export function slotKind(state: SupportedState): SlotKind {
  const { phase } = state;
  // A running check replaces the quiet states only; with an update known the check button alone shows the spinner.
  if (state.checking && (phase.kind === "none" || phase.kind === "up-to-date" || phase.kind === "check-failed")) return "checking";
  switch (phase.kind) {
    case "none":
      return "none";
    case "up-to-date":
      return "uptodate";
    case "available":
      return "found";
    case "downloading":
      return "dl";
    case "ready":
      return "ready";
    case "on-exit":
      return "exit";
    case "check-failed":
      return "failed";
    case "download-failed":
      return "faildl";
  }
}

export function iconKind(state: UpdateState | null): IconKind {
  if (!isSupported(state)) return "none";
  switch (state.phase.kind) {
    case "available":
      return "found";
    case "downloading":
      return "dl";
    case "ready":
      return "ready";
    case "on-exit":
      return "exit";
    case "check-failed":
    case "download-failed":
      return "failed";
    case "none":
    case "up-to-date":
      return "none";
  }
}

/** The download is complete and being verified (the progress is at 100 % and the phase is not ready yet). */
export function isVerifying(phase: UpdatePhase): boolean {
  return phase.kind === "downloading" && phase.percent >= 100;
}

export function downloadPercent(phase: UpdatePhase): number {
  return phase.kind === "downloading" ? Math.max(0, Math.min(100, Math.round(phase.percent))) : 0;
}

/** The offered update of a phase, or null when the phase has none. */
export function offerOf(phase: UpdatePhase) {
  switch (phase.kind) {
    case "available":
    case "downloading":
    case "ready":
    case "on-exit":
    case "download-failed":
      return phase.offer;
    case "none":
    case "up-to-date":
    case "check-failed":
      return null;
  }
}

/** Whether the update window has something to show for this state (it never opens without an offered update). */
export function updateWindowValid(state: UpdateState | null): boolean {
  return isSupported(state) && offerOf(state.phase) !== null;
}

/** "Nach Updates suchen" is off while a download runs. */
export function checkDisabled(state: SupportedState): boolean {
  return state.phase.kind === "downloading";
}

/** "Nach Updates suchen" is filled only while nothing is known or a search runs; with another main action that one is filled. */
export function checkIsPrimary(kind: SlotKind): boolean {
  return kind === "none" || kind === "checking";
}

/**
 * The main action of the slot (show the update, show the progress, restart now, details, try again) is the one filled button
 * whenever there is one. Up to date has no main action, so the slot then has no filled button at all.
 */
export function mainActionIsPrimary(kind: SlotKind): boolean {
  return !checkIsPrimary(kind) && kind !== "uptodate";
}

/** A newer update whose download failed while an older one stays ready or scheduled, or null. */
export function newerFailure(phase: UpdatePhase): NewerDownloadFailure | null {
  return (phase.kind === "ready" || phase.kind === "on-exit") && phase.newerDownloadFailed ? phase.newerDownloadFailed : null;
}

/** The error the "Details" view shows: that of a failed check, or that of a newer download that failed; null when there is none. */
export function detailError(phase: UpdatePhase): { error: UpdateError; source: "check" | "newer" } | null {
  if (phase.kind === "check-failed") return { error: phase.error, source: "check" };
  const newer = newerFailure(phase);
  return newer ? { error: newer.error, source: "newer" } : null;
}
