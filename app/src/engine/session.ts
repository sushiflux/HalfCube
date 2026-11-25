// Engine session: owns the engine client and everything around it that the app needs to know.
//   - the startup sequence (start engine -> kernel self-test -> solver self-test -> ready) as a status stream the
//     loading screen subscribes to,
//   - restart handling: an engine that crashes or hangs while the app runs is replaced automatically, with a limit so
//     a broken installation does not restart in a loop,
//   - problems with complete, copyable details.
// The status is an immutable snapshot per change, so it works directly with React's useSyncExternalStore:
//   const status = useSyncExternalStore(session.subscribe, session.getStatus);
import { EngineClient, type EngineClientOptions } from "./client.ts";
import type { HelloResult, KernelSelftestResult, SolverSelftestResult } from "./generated/protocol.ts";
import {
  problemFromError,
  problemFromExit,
  problemFromRestartLimit,
  problemFromSelftest,
  type ProblemContext,
} from "./problem.ts";
import type {
  EngineProblem,
  EngineStatus,
  StartupStep,
  StartupStepId,
  StatusListener,
} from "./status.ts";
import type { ExitInfo } from "./transport.ts";

export interface RestartLimit {
  /** Automatic restarts allowed inside windowMs; one more and the session gives up (phase failed). */
  max: number;
  windowMs: number;
}

export interface EngineSessionOptions extends Omit<EngineClientOptions, "onExit"> {
  /** Run the kernel and solver self-tests at the first start. Default true. */
  startupSelftests?: boolean;
  /** Repeat the self-tests after an automatic restart. Default false (the handshake is enough for the same binary). */
  restartSelftests?: boolean;
  /** Replace an engine that crashed or hung while the app runs. Default true. */
  autoRestart?: boolean;
  /** Default: 3 restarts within 60 s. */
  restartLimit?: RestartLimit;
  /** Pause before an automatic restart (ms). Default 250. */
  restartDelayMs?: number;
  /** Product version line for problem reports. */
  appVersion?: string;
  /** Monotonic millisecond clock for step durations; tests inject one. Default performance.now. */
  now?: () => number;
}

const STEP_ORDER: StartupStepId[] = ["engine", "kernel", "solver"];
const MAX_HISTORY = 20;

function freshSteps(first: StartupStep["state"], rest: StartupStep["state"]): StartupStep[] {
  return STEP_ORDER.map((id, i) => ({ id, state: i === 0 ? first : rest }));
}

export class EngineSession {
  readonly client: EngineClient;
  private status: EngineStatus;
  private readonly listeners = new Set<StatusListener>();
  private readonly opts: EngineSessionOptions;
  private readonly limit: RestartLimit;
  /** Times of the automatic restarts inside the limit window (monotonic ms). */
  private restartTimes: number[] = [];
  /** Problems that count towards the restart limit, newest last. */
  private recent: EngineProblem[] = [];
  /** Changes whenever the session is stopped or a new run begins; a run that finds it changed gives up quietly. */
  private token = 0;
  private running: Promise<EngineStatus> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly waiters: { resolve: (c: EngineClient) => void; reject: (e: Error) => void }[] = [];

  constructor(opts: EngineSessionOptions) {
    this.opts = opts;
    this.limit = opts.restartLimit ?? { max: 3, windowMs: 60_000 };
    this.client = new EngineClient({ ...opts, onExit: (info) => this.onClientExit(info) });
    this.status = {
      phase: "idle",
      attempt: 0,
      restarts: 0,
      steps: freshSteps("pending", "pending"),
      progress: 0,
      engine: null,
      selftests: { kernel: null, solver: null },
      problem: null,
      history: [],
      revision: 0,
    };
  }

  // ---------------------------------------------------------------------------------------------- status stream

  /** Current snapshot. Stable between changes (same object), so it can be used with useSyncExternalStore. */
  getStatus = (): EngineStatus => this.status;

  /** Calls the listener after every change; returns the function that removes it. */
  subscribe = (listener: StatusListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Resolves with the client as soon as the engine is ready (at once when it is). Rejects when the session fails or
   * is stopped; a restart after a crash keeps waiting.
   */
  whenReady(): Promise<EngineClient> {
    if (this.status.phase === "ready") return Promise.resolve(this.client);
    if (this.status.phase === "failed" || this.status.phase === "stopped") {
      return Promise.reject(new Error(this.status.problem?.message ?? "The engine session is not running."));
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  // ------------------------------------------------------------------------------------------------- control

  /**
   * Starts the engine and runs the startup steps. Resolves with the final status of this run: phase ready or failed.
   * Never rejects. Calling it again while a run is in progress or the engine is ready returns that run.
   */
  start(): Promise<EngineStatus> {
    if (this.running) return this.running;
    if (this.status.phase === "ready") return Promise.resolve(this.status);
    return this.beginRun("starting");
  }

  /** "Try again" after a failure: forgets the restart history and starts from the beginning with the self-tests. */
  retry(): Promise<EngineStatus> {
    this.recent = [];
    this.restartTimes = [];
    this.client.kill("The engine was stopped for a new start.");
    this.token++;
    this.running = null;
    this.clearRestartTimer();
    return this.beginRun("starting");
  }

  /** Replaces a running engine (for example after the user changed a setting that needs a fresh engine). */
  restart(): Promise<EngineStatus> {
    this.client.kill("The engine was restarted.");
    this.token++;
    this.running = null;
    this.clearRestartTimer();
    this.update({ restarts: this.status.restarts + 1 });
    return this.beginRun("restarting");
  }

  /** Stops the engine for good (program exit). The status becomes "stopped". */
  async stop(): Promise<void> {
    this.token++;
    this.running = null;
    this.clearRestartTimer();
    this.update({ phase: "stopped", engine: null });
    this.failWaiters(new Error("The engine session was stopped."));
    await this.client.stop();
  }

  // ------------------------------------------------------------------------------------------------ internals

  private beginRun(kind: "starting" | "restarting"): Promise<EngineStatus> {
    const token = ++this.token;
    const selftests = kind === "starting" ? (this.opts.startupSelftests ?? true) : (this.opts.restartSelftests ?? false);
    const attempt = this.status.attempt + 1;
    this.update({
      phase: kind,
      attempt,
      steps: freshSteps("running", selftests ? "pending" : "skipped"),
      progress: 0,
      engine: null,
      selftests: kind === "starting" ? { kernel: null, solver: null } : this.status.selftests,
      // A restart keeps showing why it happens; a fresh start has no problem yet.
      problem: kind === "starting" ? null : this.status.problem,
    });
    this.updateProgress();
    const run = this.run(token, kind, selftests).finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  private async run(token: number, kind: "starting" | "restarting", selftests: boolean): Promise<EngineStatus> {
    const alive = () => token === this.token;
    let step: StartupStepId = "engine";
    try {
      const t0 = this.clock();
      const hello = await this.client.start();
      if (!alive()) return this.status;
      this.finishStep("engine", t0, describeEngine(hello));
      this.update({ engine: hello });

      if (selftests) {
        step = "kernel";
        this.setStep("kernel", { state: "running" });
        const tKernel = this.clock();
        const kernel = (await this.client.request({ type: "diagnostics.kernelSelftest" }).reply).message;
        if (!alive()) return this.status;
        if (!kernel.passed) {
          this.failStep("kernel", tKernel, kernel.problem);
          this.update({ selftests: { ...this.status.selftests, kernel } });
          return this.fail(token, problemFromSelftest("kernel", kernel, this.context("kernel")), kind);
        }
        this.finishStep("kernel", tKernel, describeKernel(kernel, hello));
        this.update({ selftests: { ...this.status.selftests, kernel } });

        step = "solver";
        this.setStep("solver", { state: "running" });
        const tSolver = this.clock();
        const solver = (await this.client.request({ type: "diagnostics.solverSelftest" }).reply).message;
        if (!alive()) return this.status;
        if (!solver.passed) {
          this.failStep("solver", tSolver, solver.problem);
          this.update({ selftests: { ...this.status.selftests, solver } });
          return this.fail(token, problemFromSelftest("solver", solver, this.context("solver")), kind);
        }
        this.finishStep("solver", tSolver, describeSolver(solver, hello));
        this.update({ selftests: { ...this.status.selftests, solver } });
      }

      this.update({ phase: "ready", problem: null });
      this.settleWaiters();
      return this.status;
    } catch (e) {
      if (!alive()) return this.status;
      this.failStep(step, this.clock(), undefined);
      const problem = problemFromError(e, this.context(step), step === "engine" ? "start" : "command");
      this.client.kill("The engine was stopped after a failed start.");
      return this.fail(token, problem, kind);
    }
  }

  /** A run ended with a problem. A restart that fails may be retried within the limit; a first start never is. */
  private fail(token: number, problem: EngineProblem, kind: "starting" | "restarting"): EngineStatus {
    if (token !== this.token) return this.status;
    this.record(problem);
    if (kind === "restarting" && this.opts.autoRestart !== false && this.scheduleRestart(problem)) return this.status;
    this.update({ phase: "failed", problem, engine: null });
    this.failWaiters(new Error(problem.message));
    return this.status;
  }

  private onClientExit(info: ExitInfo): void {
    // During a run the failing request or the failing start() reports the same event; handling it there is enough.
    if (this.running || this.status.phase !== "ready") return;
    const problem = problemFromExit(info, this.context(null));
    this.record(problem);
    this.update({ engine: null, problem });
    if (this.opts.autoRestart === false || !this.scheduleRestart(problem)) {
      this.update({ phase: "failed" });
      this.failWaiters(new Error(problem.message));
    }
  }

  /** Plans the automatic restart; returns false (and records the give-up problem) when the limit is exhausted. */
  private scheduleRestart(problem: EngineProblem): boolean {
    const now = this.clock();
    this.restartTimes = this.restartTimes.filter((t) => now - t < this.limit.windowMs);
    if (this.restartTimes.length >= this.limit.max) {
      const giveUp = problemFromRestartLimit(this.recent.slice(-(this.limit.max + 1)), this.limit, this.context(problem.step));
      this.record(giveUp);
      this.update({ phase: "failed", problem: giveUp, engine: null });
      this.failWaiters(new Error(giveUp.message));
      return true; // handled: the session is in its final failed state
    }
    this.restartTimes.push(now);
    const token = ++this.token;
    this.update({
      phase: "restarting",
      problem,
      engine: null,
      restarts: this.status.restarts + 1,
      steps: freshSteps("pending", "pending"),
      progress: 0,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (token !== this.token) return;
      void this.beginRun("restarting");
    }, this.opts.restartDelayMs ?? 250);
    return true;
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  // ------------------------------------------------------------------------------------------ status updates

  private clock(): number {
    return (this.opts.now ?? (() => performance.now()))();
  }

  private context(step: StartupStepId | null): ProblemContext {
    return {
      step,
      attempt: this.status.attempt,
      restarts: this.status.restarts,
      transport: this.client.lastTransportKind,
      engine: this.status.engine ?? this.client.hello,
      appVersion: this.opts.appVersion,
      at: new Date(),
    };
  }

  private record(problem: EngineProblem): void {
    this.recent = [...this.recent.slice(-9), problem];
    this.update({ history: [...this.status.history, problem].slice(-MAX_HISTORY) });
  }

  private setStep(id: StartupStepId, patch: Partial<StartupStep>): void {
    this.update({ steps: this.status.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
    this.updateProgress();
  }

  private finishStep(id: StartupStepId, startedAt: number, detail: string): void {
    this.setStep(id, { state: "done", detail, durationMs: this.clock() - startedAt });
  }

  private failStep(id: StartupStepId, startedAt: number, detail: string | undefined): void {
    this.setStep(id, { state: "failed", ...(detail ? { detail } : {}), durationMs: this.clock() - startedAt });
  }

  private updateProgress(): void {
    const counted = this.status.steps.filter((s) => s.state !== "skipped");
    const progress = counted.length === 0 ? 1 : counted.filter((s) => s.state === "done").length / counted.length;
    if (progress !== this.status.progress) this.update({ progress });
  }

  private update(patch: Partial<Omit<EngineStatus, "revision">>): void {
    this.status = { ...this.status, ...patch, revision: this.status.revision + 1 };
    for (const l of [...this.listeners]) {
      try {
        l(this.status);
      } catch (e) {
        // A broken listener must not break the engine session.
        console.error("An engine status listener threw:", e);
      }
    }
  }

  private settleWaiters(): void {
    for (const w of this.waiters.splice(0)) w.resolve(this.client);
  }

  private failWaiters(error: Error): void {
    for (const w of this.waiters.splice(0)) w.reject(error);
  }
}

// -------------------------------------------------------------------------------------------- step descriptions

function describeEngine(h: HelloResult): string {
  const e = h.engine;
  return `${e.name} ${e.version}, ${e.platform} ${e.os}, protocol ${h.protocol}`;
}

function describeKernel(r: KernelSelftestResult, h: HelloResult): string {
  return `OCCT ${h.components.occt}, ${r.faceCount} faces, volume ${r.volume.toFixed(1)} mm3, ${r.timeMs.toFixed(1)} ms`;
}

function describeSolver(r: SolverSelftestResult, h: HelloResult): string {
  return `planegcs ${h.components.planegcs.source}, ${r.constraintCount} constraints, ${r.dof} degrees of freedom left, ${r.timeMs.toFixed(1)} ms`;
}
