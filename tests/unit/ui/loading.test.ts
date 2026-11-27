import { describe, expect, it } from "vitest";
import { buildScenario, progressAt, scenarioDuration, type Scenario } from "../../../app/src/dev/scenarios.ts";
import { currentStepIndex, isComplete, overallProgress } from "../../../app/src/ui/loading/progress.ts";
import type { LoadingStep } from "../../../app/src/ui/loading/types.ts";

const step = (id: string, state: LoadingStep["state"], extra: Partial<LoadingStep> = {}): LoadingStep => ({
  id,
  label: id,
  state,
  ...extra,
});

describe("overall progress is real, nothing is interpolated", () => {
  it("counts finished steps only when no fraction is measured", () => {
    const steps = [step("a", "done"), step("b", "active"), step("c", "pending"), step("d", "pending")];
    expect(overallProgress({ steps })).toBeCloseTo(0.25);
  });

  it("adds the measured fraction of the running step", () => {
    const steps = [step("a", "done"), step("b", "active", { fraction: 0.5 }), step("c", "pending"), step("d", "pending")];
    expect(overallProgress({ steps })).toBeCloseTo(0.375);
  });

  it("respects the weights", () => {
    const steps = [step("a", "done", { weight: 60 }), step("b", "active", { weight: 40, fraction: 0.5 })];
    expect(overallProgress({ steps })).toBeCloseTo(0.8);
  });

  it("a caller-supplied percent wins and is clamped", () => {
    expect(overallProgress({ steps: [step("a", "pending")], percent: 42 })).toBeCloseTo(0.42);
    expect(overallProgress({ steps: [], percent: 140 })).toBe(1);
    expect(overallProgress({ steps: [], percent: -5 })).toBe(0);
  });

  it("is 0 without steps and ignores a fraction on a pending step", () => {
    expect(overallProgress({ steps: [] })).toBe(0);
    expect(overallProgress({ steps: [step("a", "pending", { fraction: 0.9 })] })).toBe(0);
  });

  it("a warning counts as finished", () => {
    expect(overallProgress({ steps: [step("a", "warning"), step("b", "pending")] })).toBeCloseTo(0.5);
  });
});

describe("current step and completion", () => {
  it("shows the failed step, else the running one, else the first waiting one", () => {
    expect(currentStepIndex([step("a", "done"), step("b", "failed"), step("c", "pending")])).toBe(1);
    expect(currentStepIndex([step("a", "done"), step("b", "active"), step("c", "pending")])).toBe(1);
    expect(currentStepIndex([step("a", "done"), step("b", "pending")])).toBe(1);
    expect(currentStepIndex([step("a", "done"), step("b", "done")])).toBe(2);
  });

  it("is complete only when every step is finished and nothing failed", () => {
    expect(isComplete({ steps: [step("a", "done"), step("b", "warning")] })).toBe(true);
    expect(isComplete({ steps: [step("a", "done"), step("b", "active")] })).toBe(false);
    expect(isComplete({ steps: [] })).toBe(false);
    expect(
      isComplete({
        steps: [step("a", "done")],
        error: { headline: "x", code: "C", details: [] },
      }),
    ).toBe(false);
  });
});

describe("demo scenarios (dev only) behave like real progress would", () => {
  const names = ["start", "start-error", "panel-open", "panel-open-error", "panel-step", "panel-restart"];

  it.each(names.flatMap((n) => (["de", "en"] as const).map((l) => [n, l] as const)))("%s in %s never goes backwards", (name, lang) => {
    const scenario = buildScenario(name, lang) as Scenario;
    expect(scenario).toBeDefined();
    const total = scenarioDuration(scenario);
    let last = -1;
    for (let t = 0; t <= total + 50; t += 25) {
      const p = overallProgress(progressAt(scenario, t));
      expect(p).toBeGreaterThanOrEqual(last - 1e-9);
      last = p;
    }
  });

  it("start finishes complete, start-error breaks with a full error", () => {
    const ok = buildScenario("start", "en") as Scenario;
    expect(isComplete(progressAt(ok, scenarioDuration(ok) + 10))).toBe(true);
    const bad = buildScenario("start-error", "en") as Scenario;
    const failed = progressAt(bad, 10);
    expect(failed.error?.code).toBe("HC-ENGINE-001");
    expect(failed.steps[0]?.state).toBe("failed");
    expect(failed.steps.slice(1).every((s) => s.state === "pending")).toBe(true);
  });

  it("a measured step fails at its measured point, not before", () => {
    const bad: Scenario = {
      steps: [{ id: "read", active: "Reading", done: "Read", measured: true, detail: (f) => String(f), weight: 1, durationMs: 7000 }],
      fail: { step: 0, fraction: 0.45, error: { headline: "x", code: "HC-TEST-001", details: [] } },
    };
    expect(progressAt(bad, 1000).error).toBeUndefined();
    expect(progressAt(bad, 4000).error?.code).toBe("HC-TEST-001");
  });

  it("every demo text exists in both languages and is not empty", () => {
    for (const name of names) {
      const de = buildScenario(name, "de") as Scenario;
      const en = buildScenario(name, "en") as Scenario;
      expect(de.steps.map((s) => s.id)).toEqual(en.steps.map((s) => s.id));
      for (const s of [...de.steps, ...en.steps]) {
        expect(s.active).not.toBe("");
        expect(s.done).not.toBe("");
      }
    }
  });
});
