// Maps the engine session's status to what the loading screen and the loading panel show. Pure and free of React,
// so it can be tested on its own. Types only from the engine: this module never starts anything.
//
// The cause and the details of a problem come from the engine session in English and are shown unchanged (they quote
// the engine and the operating system); the headline per problem code is translated here.
import type { EnginePhase, EngineProblem, EngineProblemCode, EngineStatus, StartupStep, StartupStepId } from "../../engine/status.ts";
import type { MessageKey, MessageParams } from "../../i18n/types.ts";
import type { LoadingError, LoadingProgress, LoadingStep, LoadingStepState } from "./types.ts";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** Text while the step waits or runs, and once it is done. */
const stepLabels: Record<StartupStepId, readonly [active: MessageKey, done: MessageKey]> = {
  engine: ["loading.start.engineActive", "loading.start.engineDone"],
  kernel: ["loading.start.kernelActive", "loading.start.kernelDone"],
  solver: ["loading.start.solverActive", "loading.start.solverDone"],
};

const problemHeadlines: Record<EngineProblemCode, MessageKey> = {
  engine_start_failed: "engineProblem.engine_start_failed",
  engine_refused: "engineProblem.engine_refused",
  engine_crashed: "engineProblem.engine_crashed",
  engine_hung: "engineProblem.engine_hung",
  engine_connection_lost: "engineProblem.engine_connection_lost",
  kernel_selftest_failed: "engineProblem.kernel_selftest_failed",
  solver_selftest_failed: "engineProblem.solver_selftest_failed",
  engine_command_failed: "engineProblem.engine_command_failed",
  engine_restart_limit: "engineProblem.engine_restart_limit",
};

const stepStates: Record<StartupStep["state"], LoadingStepState | null> = {
  pending: "pending",
  running: "active",
  done: "done",
  failed: "failed",
  skipped: null, // not run: not shown, and the session does not count it in its progress either
};

export function engineProblemHeadline(code: EngineProblemCode, t: Translate): string {
  return t(problemHeadlines[code]);
}

/** The error card: translated headline, the stable code, the engine's cause and the full report, buttons: try again. */
export function engineProblemToError(problem: EngineProblem, t: Translate): LoadingError {
  return {
    headline: engineProblemHeadline(problem.code, t),
    code: problem.code,
    details: [
      { kind: "text", text: problem.message },
      { kind: "code", text: problem.details },
    ],
    actions: [{ id: "retry", label: t("common.retry"), primary: true }],
  };
}

function toLoadingSteps(steps: readonly StartupStep[], t: Translate): LoadingStep[] {
  const out: LoadingStep[] = [];
  for (const step of steps) {
    const state = stepStates[step.state];
    if (state === null) continue;
    const [active, done] = stepLabels[step.id];
    out.push({
      id: step.id,
      label: t(state === "done" ? done : active),
      state,
      ...(step.detail && (state === "done" || state === "failed") ? { detail: step.detail } : {}),
    });
  }
  return out;
}

/** The first start (full screen) or a later (re)start while the app runs (panel). */
export type EngineMode = "start" | "running";

/**
 * The loading input for the engine's status.
 * start: the steps of the first start; a failure becomes the error card.
 * running: the engine went away while the app runs (or is being started again): a heading, the reason as a warning
 * step with the engine's own cause as sub line, then the steps of the new start.
 */
export function engineStatusToProgress(status: EngineStatus, t: Translate, mode: EngineMode): LoadingProgress {
  const steps = toLoadingSteps(status.steps, t);
  const failedProblem = status.phase === "failed" ? status.problem : null;
  const error = failedProblem ? engineProblemToError(failedProblem, t) : undefined;

  if (mode === "start") {
    return { steps, ...(error ? { error } : {}) };
  }

  const restarting = status.phase === "restarting";
  const progress: LoadingProgress = {
    title: t(status.phase === "failed" ? "loading.panel.failedTitle" : restarting ? "loading.panel.restartingTitle" : "loading.panel.startingTitle"),
    steps,
  };
  if (restarting && status.problem) {
    progress.steps = [
      { id: "problem", label: engineProblemHeadline(status.problem.code, t), state: "warning", weight: 0 },
      ...steps,
    ];
    progress.subtitle = status.problem.message;
    progress.note = t("loading.panel.restartingNote");
  }
  if (error) progress.error = error;
  return progress;
}

export type EngineView = "none" | "screen" | "panel";

/**
 * What to show for the session phase. Until the loading screen has handed over (startupDone), it is the full screen,
 * also at the very end while the logo flies. Afterwards anything but a running engine is the panel over the work area.
 */
export function selectEngineView(phase: EnginePhase, startupDone: boolean): EngineView {
  if (!startupDone) return "screen";
  return phase === "ready" || phase === "stopped" || phase === "idle" ? "none" : "panel";
}
