import { describe, expect, it } from "vitest";
import { catalogues, createI18nStore, formatMessage, lookup } from "../../../app/src/i18n/core.ts";
import type { EngineProblem, EngineProblemCode, EngineStatus, StartupStep } from "../../../app/src/engine/status.ts";
import {
  engineProblemHeadline,
  engineProblemToError,
  engineStatusToProgress,
  selectEngineView,
} from "../../../app/src/ui/loading/engine.ts";
import { isComplete, overallProgress } from "../../../app/src/ui/loading/progress.ts";
import type { MessageKey, MessageParams } from "../../../app/src/i18n/types.ts";

const tFor = (lang: "de" | "en") => (key: MessageKey, params?: MessageParams) => formatMessage(lookup(catalogues[lang], key), params);
const en = tFor("en");
const de = tFor("de");

const step = (id: StartupStep["id"], state: StartupStep["state"], detail?: string): StartupStep => ({
  id,
  state,
  ...(detail ? { detail } : {}),
});

function status(patch: Partial<EngineStatus>): EngineStatus {
  return {
    phase: "starting",
    attempt: 1,
    restarts: 0,
    steps: [step("engine", "pending"), step("kernel", "pending"), step("solver", "pending")],
    progress: 0,
    engine: null,
    selftests: { kernel: null, solver: null },
    problem: null,
    history: [],
    revision: 1,
    ...patch,
  };
}

const problem = (code: EngineProblemCode, extra: Partial<EngineProblem> = {}): EngineProblem => ({
  code,
  step: "engine",
  message: "The engine program was not found: C:\\x\\partcraft-engine.exe",
  details: "Partcraft engine problem\nCode: engine_start_failed\n\nCause: not found",
  occurredAt: "2026-11-25T10:00:00.000Z",
  ...extra,
});

describe("first start (screen)", () => {
  it("shows the three real steps with their state and the right label for it", () => {
    const p = engineStatusToProgress(
      status({ steps: [step("engine", "done", "partcraft-engine 1.0"), step("kernel", "running"), step("solver", "pending")] }),
      en,
      "start",
    );
    expect(p.steps.map((s) => [s.id, s.state, s.label])).toEqual([
      ["engine", "done", "Engine started"],
      ["kernel", "active", "Checking the geometry kernel"],
      ["solver", "pending", "Checking the sketch solver"],
    ]);
    expect(p.steps[0]?.detail).toBe("partcraft-engine 1.0");
    expect(p.error).toBeUndefined();
  });

  it("is German in German", () => {
    const p = engineStatusToProgress(status({ steps: [step("engine", "running"), step("kernel", "pending"), step("solver", "pending")] }), de, "start");
    expect(p.steps[0]?.label).toBe("Engine wird gestartet");
  });

  it("derives the overall progress from the finished steps (one third each)", () => {
    const none = engineStatusToProgress(status({}), en, "start");
    expect(overallProgress(none)).toBe(0);
    const two = engineStatusToProgress(
      status({ steps: [step("engine", "done"), step("kernel", "done"), step("solver", "running")] }),
      en,
      "start",
    );
    expect(overallProgress(two)).toBeCloseTo(2 / 3);
  });

  it("is complete (hand-over) when all steps are done", () => {
    const p = engineStatusToProgress(
      status({ phase: "ready", steps: [step("engine", "done"), step("kernel", "done"), step("solver", "done")], progress: 1 }),
      en,
      "start",
    );
    expect(isComplete(p)).toBe(true);
  });

  it("does not show skipped steps", () => {
    const p = engineStatusToProgress(status({ steps: [step("engine", "running"), step("kernel", "skipped"), step("solver", "skipped")] }), en, "start");
    expect(p.steps.map((s) => s.id)).toEqual(["engine"]);
  });

  it("a failure becomes the error card: translated headline, code, the engine's cause unchanged, full report, retry", () => {
    const pr = problem("engine_start_failed");
    const p = engineStatusToProgress(
      status({ phase: "failed", steps: [step("engine", "failed"), step("kernel", "pending"), step("solver", "pending")], problem: pr }),
      de,
      "start",
    );
    expect(p.steps[0]?.state).toBe("failed");
    expect(p.error).toEqual({
      headline: "Engine konnte nicht gestartet werden",
      code: "engine_start_failed",
      details: [
        { kind: "text", text: pr.message },
        { kind: "code", text: pr.details },
      ],
      actions: [{ id: "retry", label: "Erneut versuchen", primary: true }],
    });
    expect(isComplete(p)).toBe(false);
  });

  it("shows the old problem as an error only in the failed phase", () => {
    const p = engineStatusToProgress(status({ phase: "starting", problem: problem("engine_crashed") }), en, "start");
    expect(p.error).toBeUndefined();
  });
});

describe("while the app runs (panel)", () => {
  it("an automatic restart: heading, the reason as warning step, the engine's cause as sub line, then the new start", () => {
    const pr = problem("engine_crashed", { message: "The engine stopped unexpectedly. Exit code 0xC0000005" });
    const p = engineStatusToProgress(
      status({
        phase: "restarting",
        restarts: 1,
        problem: pr,
        steps: [step("engine", "running"), step("kernel", "skipped"), step("solver", "skipped")],
      }),
      en,
      "running",
    );
    expect(p.title).toBe("Restarting the engine");
    expect(p.subtitle).toBe(pr.message);
    expect(p.note).toBe("This happens automatically, you do not need to do anything.");
    expect(p.steps.map((s) => [s.id, s.state])).toEqual([
      ["problem", "warning"],
      ["engine", "active"],
    ]);
    expect(p.steps[0]?.label).toBe("The engine crashed");
    expect(p.error).toBeUndefined();
    expect(overallProgress(p)).toBe(0);
  });

  it("the restart limit shows the full error with a retry", () => {
    const pr = problem("engine_restart_limit", { message: "The engine stopped 4 times within 60 s (limit 3)." });
    const p = engineStatusToProgress(status({ phase: "failed", problem: pr, steps: [step("engine", "pending"), step("kernel", "pending"), step("solver", "pending")] }), en, "running");
    expect(p.title).toBe("The engine is not available");
    expect(p.error?.code).toBe("engine_restart_limit");
    expect(p.error?.headline).toBe("The engine was restarted too often, automatic restarts stopped");
    expect(p.error?.actions?.[0]?.id).toBe("retry");
    expect(p.subtitle).toBeUndefined();
  });

  it("a new start after retry is a plain 'starting' panel without a reason", () => {
    const p = engineStatusToProgress(status({ phase: "starting", problem: null }), en, "running");
    expect(p.title).toBe("Starting the engine");
    expect(p.steps.some((s) => s.id === "problem")).toBe(false);
  });
});

describe("which view", () => {
  it("is the full screen until it has handed over, whatever the phase", () => {
    for (const phase of ["idle", "starting", "ready", "failed", "restarting", "stopped"] as const) {
      expect(selectEngineView(phase, false)).toBe("screen");
    }
  });

  it("afterwards only a running engine shows nothing; restarting and failed show the panel", () => {
    expect(selectEngineView("ready", true)).toBe("none");
    expect(selectEngineView("stopped", true)).toBe("none");
    expect(selectEngineView("restarting", true)).toBe("panel");
    expect(selectEngineView("failed", true)).toBe("panel");
    expect(selectEngineView("starting", true)).toBe("panel");
  });
});

describe("problem headlines", () => {
  const codes: EngineProblemCode[] = [
    "engine_start_failed",
    "engine_refused",
    "engine_crashed",
    "engine_hung",
    "engine_connection_lost",
    "kernel_selftest_failed",
    "solver_selftest_failed",
    "engine_command_failed",
    "engine_restart_limit",
  ];

  it("exist for every problem code in both languages and differ per code", () => {
    for (const t of [en, de]) {
      const headlines = codes.map((c) => engineProblemHeadline(c, t));
      expect(headlines.every((h) => h.trim() !== "")).toBe(true);
      expect(new Set(headlines).size).toBe(codes.length);
    }
  });

  it("the error card keeps the report text untouched", () => {
    const pr = problem("kernel_selftest_failed", { message: "Kernel self-test failed: volume 0", details: "line1\nline2" });
    const error = engineProblemToError(pr, en);
    expect(error.details).toEqual([
      { kind: "text", text: "Kernel self-test failed: volume 0" },
      { kind: "code", text: "line1\nline2" },
    ]);
  });
});

describe("language switch", () => {
  it("the same status follows the language", () => {
    const store = createI18nStore({ preferences: { get: () => undefined, set: () => undefined }, initialLanguage: () => "en" });
    const s = status({ steps: [step("engine", "running"), step("kernel", "pending"), step("solver", "pending")] });
    expect(engineStatusToProgress(s, store.getState().t, "start").steps[0]?.label).toBe("Starting the engine");
    store.setLanguage("de");
    expect(engineStatusToProgress(s, store.getState().t, "start").steps[0]?.label).toBe("Engine wird gestartet");
  });
});
