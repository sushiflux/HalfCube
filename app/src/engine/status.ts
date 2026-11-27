// What the engine session tells the rest of the app: the startup progress for the loading screen and, when something
// goes wrong, a problem with the complete, copyable details. Types only, so the UI can import them cheaply.
import type { HelloResult, KernelSelftestResult, SolverSelftestResult } from "./generated/protocol.ts";

/**
 * Where the session is.
 * idle: not started. starting: first start with the startup steps. ready: the engine runs and passed its self-tests.
 * restarting: the engine went away and is being replaced (the last problem stays visible). failed: the engine cannot
 * be used; retry() starts over. stopped: stopped on purpose.
 */
export type EnginePhase = "idle" | "starting" | "ready" | "restarting" | "failed" | "stopped";

/** engine: start the engine and shake hands. kernel / solver: the self-tests of the geometry kernel and the sketch solver. */
export type StartupStepId = "engine" | "kernel" | "solver";

/** skipped: not run (self-tests are off, or a restart does not repeat them). */
export type StepState = "pending" | "running" | "done" | "failed" | "skipped";

export interface StartupStep {
  id: StartupStepId;
  state: StepState;
  /** Technical result in plain words, e.g. "OCCT 8.0.2, 8 faces, volume 73587.3 mm3, 5.8 ms". Not translated. */
  detail?: string;
  /** How long the step took (ms); set when it is done or failed. */
  durationMs?: number;
}

export type EngineProblemCode =
  /** The engine could not be started: the program is missing, the process did not spawn, the desktop bridge is missing. */
  | "engine_start_failed"
  /** The engine started but refused the handshake (for example a different protocol version). */
  | "engine_refused"
  /** The native engine process ended. */
  | "engine_crashed"
  /** The engine stopped answering and was stopped by a watchdog. */
  | "engine_hung"
  /** The connection to the engine broke (unreadable frames, closed channel). */
  | "engine_connection_lost"
  /** The kernel self-test ran and reported a wrong result. */
  | "kernel_selftest_failed"
  /** The solver self-test ran and reported a wrong result. */
  | "solver_selftest_failed"
  /** The engine answered a start-up command with an error. */
  | "engine_command_failed"
  /** The engine ended several times in a short time; automatic restarts stopped. */
  | "engine_restart_limit";

export interface EngineProblem {
  /** Stable code; the UI maps it to a translated headline. */
  code: EngineProblemCode;
  /** Startup step that was running (or the last one reached), null when the engine ran normally. */
  step: StartupStepId | null;
  /** Complete, specific cause in English, written by the app or the engine. Shown below the headline. */
  message: string;
  /**
   * Everything needed to report the problem, as plain text for a "copy" button: cause, step, time, engine and build
   * data, exit code, the engine's diagnostic output, raw error text. Contains the engine's file path.
   */
  details: string;
  /** When it happened, ISO 8601. */
  occurredAt: string;
}

export interface EngineStatus {
  phase: EnginePhase;
  /** Counts every start or restart attempt, 1 for the first start. */
  attempt: number;
  /** How many times the engine was replaced after a crash or hang (automatic or manual) in this session. */
  restarts: number;
  /** The three startup steps, always in this order. */
  steps: StartupStep[];
  /** 0..1, finished steps over the steps that run (skipped steps do not count). */
  progress: number;
  /** Handshake result of the running engine; null while none runs. */
  engine: HelloResult | null;
  /** Full results of the startup self-tests (for the diagnostics page); null when they did not run. */
  selftests: { kernel: KernelSelftestResult | null; solver: SolverSelftestResult | null };
  /** The current problem: set in phase failed, and in phase restarting until the new engine is ready. */
  problem: EngineProblem | null;
  /** Problems of this session, oldest first, at most 20. */
  history: EngineProblem[];
  /** Increases with every change, so the status can be used with useSyncExternalStore and for change detection. */
  revision: number;
}

export type StatusListener = (status: EngineStatus) => void;
