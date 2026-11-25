// What drives the loading screen (full screen at program start) and the loading panel (inside the app).
// Real progress only: every step is something that really happens, and a step counts when it is finished.
// A fraction or a percent is given only where a real quantity exists (bytes loaded, faces transferred, timeline steps).
import type { ErrorBlock } from "../errorText.ts";

export type LoadingStepState = "pending" | "active" | "done" | "failed" | "warning";

export interface LoadingStep {
  /** Stable identifier, e.g. "engine", "kernel". */
  id: string;
  /** Text for the current state: "Engine wird gestartet" while active, "Engine gestartet" once done. */
  label: string;
  state: LoadingStepState;
  /** Shown beside the label, e.g. "18,4 von 41,2 MB" or "OCCT 8.0.2". */
  detail?: string;
  /** 0..1 progress inside this step, only where it can really be measured. */
  fraction?: number;
  /** Share of the overall progress; defaults to 1. */
  weight?: number;
}

export interface LoadingAction {
  id: string;
  label: string;
  primary?: boolean;
}

/** A failure shown on the loading screen itself, in full and copyable. */
export interface LoadingError {
  /** What failed, specific. */
  headline: string;
  /** Error code, e.g. "PC-ENGINE-001". */
  code: string;
  /** The detailed description behind the arrow. */
  details: readonly ErrorBlock[];
  /** Buttons next to Copy (retry, quit, reload ...); the caller handles them through onAction. */
  actions?: readonly LoadingAction[];
}

export interface LoadingProgress {
  /** Heading of the in-app panel, e.g. "Halterung_v3.step wird importiert". Not used by the start screen. */
  title?: string;
  /** Line under the heading, e.g. the file path and size. */
  subtitle?: string;
  steps: readonly LoadingStep[];
  /** Overall progress 0..100 when the caller measures it itself; otherwise it is derived from the steps. */
  percent?: number;
  error?: LoadingError;
  /** Short sentence next to the Cancel button: what Cancel does. */
  note?: string;
}
