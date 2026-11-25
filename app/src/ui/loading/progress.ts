import type { LoadingProgress, LoadingStep } from "./types.ts";

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Overall progress 0..1. A caller-supplied percent wins. Otherwise: the weight of finished steps plus, for the
 * running (or failed) step, its weight times its measured fraction. A step without a measured fraction counts only
 * when it is finished, nothing is interpolated.
 */
export function overallProgress(progress: Pick<LoadingProgress, "steps" | "percent">): number {
  if (progress.percent !== undefined) return clamp01(progress.percent / 100);
  const total = progress.steps.reduce((sum, s) => sum + (s.weight ?? 1), 0);
  if (total <= 0) return 0;
  let done = 0;
  for (const step of progress.steps) {
    const weight = step.weight ?? 1;
    if (step.state === "done" || step.state === "warning") done += weight;
    else if ((step.state === "active" || step.state === "failed") && step.fraction !== undefined) {
      done += weight * clamp01(step.fraction);
    }
  }
  return clamp01(done / total);
}

/** Index of the step to show: the failed one, else the running one, else the first waiting one; length when all are done. */
export function currentStepIndex(steps: readonly LoadingStep[]): number {
  const failed = steps.findIndex((s) => s.state === "failed");
  if (failed >= 0) return failed;
  const active = steps.findIndex((s) => s.state === "active");
  if (active >= 0) return active;
  const pending = steps.findIndex((s) => s.state === "pending");
  return pending >= 0 ? pending : steps.length;
}

/** All steps finished and nothing failed. */
export function isComplete(progress: Pick<LoadingProgress, "steps" | "error">): boolean {
  return (
    progress.error === undefined &&
    progress.steps.length > 0 &&
    progress.steps.every((s) => s.state === "done" || s.state === "warning")
  );
}
