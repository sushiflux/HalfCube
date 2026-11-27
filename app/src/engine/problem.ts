// Turns what went wrong into an EngineProblem: a specific cause plus the complete text for the "copy" button.
// The headline per code is the UI's job (translated); the cause and the details are written here, in English,
// because they quote the engine and the operating system.
import { EngineCommandError, EngineCrashedError } from "./errors.ts";
import type { HelloResult, KernelSelftestResult, SolverSelftestResult } from "./generated/protocol.ts";
import type { EngineProblem, EngineProblemCode, StartupStepId } from "./status.ts";
import type { ExitInfo } from "./transport.ts";
import { branding } from "../branding.ts";

/** What the problem report knows about the situation. */
export interface ProblemContext {
  step: StartupStepId | null;
  attempt: number;
  restarts: number;
  transport: "native" | null;
  engine: HelloResult | null;
  /** Product version line for the report, e.g. "HalfCube v2026.11.5.13.12369 (</>)". */
  appVersion: string | undefined;
  at: Date;
}

const stepNames: Record<StartupStepId, string> = {
  engine: "start of the engine",
  kernel: "kernel self-test",
  solver: "solver self-test",
};

const MAX_DIAGNOSTICS_CHARS = 6000;

function describeEngine(h: HelloResult | null): string[] {
  if (!h) return ["Engine: not connected (no handshake)"];
  const e = h.engine;
  return [
    `Engine: ${e.name} ${e.versionFull} (${e.version}), ${e.platform} ${e.os}, ${e.buildType}${e.testCommands ? ", test commands on" : ""}`,
    `Compiler: ${e.compiler}`,
    `Protocol: ${h.protocol}`,
    `Components: OCCT ${h.components.occt}, planegcs ${h.components.planegcs.source}, Eigen ${h.components.eigen}, Boost ${h.components.boost}`,
  ];
}

function tail(text: string | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  return t.length > MAX_DIAGNOSTICS_CHARS ? `[...]${t.slice(-MAX_DIAGNOSTICS_CHARS)}` : t;
}

function assemble(
  code: EngineProblemCode,
  message: string,
  ctx: ProblemContext,
  extra: { exit?: ExitInfo; raw?: string; sections?: [string, string][] } = {},
): EngineProblem {
  const lines: string[] = [
    `${branding.name} engine problem`,
    ctx.appVersion ? `Program: ${ctx.appVersion}` : "",
    `Time: ${ctx.at.toISOString()}`,
    `Code: ${code}`,
    `Step: ${ctx.step ? stepNames[ctx.step] : "engine running normally"}`,
    `Attempt: ${ctx.attempt} (engine replaced ${ctx.restarts} time${ctx.restarts === 1 ? "" : "s"} before)`,
    `Connection: ${ctx.transport === "native" ? "native engine process" : "none"}`,
    "",
    `Cause: ${message}`,
    "",
    ...describeEngine(ctx.engine),
  ].filter((l, i, all) => l !== "" || all[i - 1] !== "");
  const exit = extra.exit;
  if (exit) {
    lines.push("", `Exit kind: ${exit.kind}`);
    if (exit.code !== undefined && exit.code !== null) lines.push(`Exit code: ${exit.code} (0x${(exit.code >>> 0).toString(16).toUpperCase().padStart(8, "0")})`);
    if (exit.signal) lines.push(`Signal: ${exit.signal}`);
  }
  for (const [title, body] of extra.sections ?? []) lines.push("", `--- ${title} ---`, body);
  const diag = tail(exit?.diagnostics);
  if (diag) lines.push("", "--- Engine diagnostic output (end) ---", diag);
  if (extra.raw) lines.push("", "--- Raw error text ---", extra.raw);
  return { code, step: ctx.step, message, details: lines.join("\n"), occurredAt: ctx.at.toISOString() };
}

const rawText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}${e.stack ? `\n${e.stack}` : ""}` : String(e));

/** The engine ended, hung or lost its connection. */
export function problemFromExit(info: ExitInfo, ctx: ProblemContext): EngineProblem {
  const code: EngineProblemCode =
    info.kind === "hang" ? "engine_hung" : info.kind === "error" ? "engine_connection_lost" : "engine_crashed";
  const prefix =
    code === "engine_crashed" ? "The engine stopped unexpectedly. " : code === "engine_hung" ? "The engine stopped responding. " : "";
  return assemble(code, `${prefix}${info.message}`, ctx, { exit: info });
}

/**
 * Any error thrown while starting the engine or running a startup command: the transport could not start, the
 * handshake was refused, the engine died, or a command came back with an error.
 */
export function problemFromError(error: unknown, ctx: ProblemContext, phase: "start" | "command"): EngineProblem {
  if (error instanceof EngineCrashedError) return problemFromExit(error.info, ctx);
  if (error instanceof EngineCommandError) {
    const refused = phase === "start";
    return assemble(
      refused ? "engine_refused" : "engine_command_failed",
      `${refused ? "The engine refused the handshake" : `The engine rejected the command "${error.command ?? "unknown"}"`} (${error.code}): ${error.message}`,
      ctx,
      error.detail ? { raw: error.detail } : {},
    );
  }
  const text = error instanceof Error ? error.message : String(error);
  return assemble("engine_start_failed", text, ctx, { raw: rawText(error) });
}

/** A self-test ran to the end and reported a wrong result. */
export function problemFromSelftest(which: "kernel" | "solver", result: KernelSelftestResult | SolverSelftestResult, ctx: ProblemContext): EngineProblem {
  const name = which === "kernel" ? "Kernel" : "Solver";
  const message = `${name} self-test failed: ${result.problem ?? "the engine reported no reason"}`;
  return assemble(which === "kernel" ? "kernel_selftest_failed" : "solver_selftest_failed", message, ctx, {
    sections: [[`${name} self-test result`, JSON.stringify(result, null, 2)]],
  });
}

/** The engine ended too often in a short time. */
export function problemFromRestartLimit(recent: EngineProblem[], limit: { max: number; windowMs: number }, ctx: ProblemContext): EngineProblem {
  const seconds = Math.round(limit.windowMs / 1000);
  const last = recent.at(-1);
  const message =
    `The engine stopped ${recent.length} times within ${seconds} s (limit ${limit.max}); automatic restarts were stopped.` +
    (last ? ` The last cause: ${last.message}` : "");
  const sections: [string, string][] = recent.map((p, i) => [`Problem ${i + 1} of ${recent.length} (${p.occurredAt}, ${p.code})`, p.details]);
  return assemble("engine_restart_limit", message, ctx, { sections });
}
