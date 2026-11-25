// A scriptable engine transport for unit tests: the test sees every command the client sends and plays the engine's
// answers by hand, without any engine process.
import type { EngineTransport, ExitInfo } from "../../../../app/src/engine/transport.ts";

export interface SentCommand {
  id: number;
  type: string;
  raw: Record<string, unknown>;
}

export class FakeTransport implements EngineTransport {
  readonly kind: "native" | "wasm";
  onMessage: ((header: string, payload: ArrayBuffer | null) => void) | null = null;
  onExit: ((info: ExitInfo) => void) | null = null;
  diagnostics = "";
  sent: SentCommand[] = [];
  killed = false;
  cancelFlagCalls: number[] = [];
  /** Set to make start() fail with this error. */
  startError: Error | null = null;
  /** Called for every command; return true when the test answered it itself. */
  autoReply: ((cmd: SentCommand, transport: FakeTransport) => void) | null = null;

  constructor(kind: "native" | "wasm" = "native") {
    this.kind = kind;
  }

  start(): Promise<void> {
    return this.startError ? Promise.reject(this.startError) : Promise.resolve();
  }

  send(header: string): void {
    if (this.killed) throw new Error("The fake engine was killed.");
    const raw = JSON.parse(header) as Record<string, unknown>;
    const cmd: SentCommand = { id: raw.id as number, type: raw.type as string, raw };
    this.sent.push(cmd);
    this.autoReply?.(cmd, this);
  }

  kill(): void {
    this.killed = true;
  }

  cancelRunning(requestId: number): boolean {
    this.cancelFlagCalls.push(requestId);
    return this.kind === "wasm";
  }

  /** The engine says something. */
  say(message: Record<string, unknown>, payload: ArrayBuffer | null = null): void {
    this.onMessage?.(JSON.stringify(message), payload);
  }

  /** The engine dies. */
  die(info: ExitInfo): void {
    this.onExit?.(info);
  }

  last(type?: string): SentCommand {
    const list = type ? this.sent.filter((s) => s.type === type) : this.sent;
    const cmd = list.at(-1);
    if (!cmd) throw new Error(`No command${type ? ` of type ${type}` : ""} was sent.`);
    return cmd;
  }
}

/** The answer of a healthy engine to hello. */
export function helloResult(replyTo: number, kind: "native" | "wasm" = "native"): Record<string, unknown> {
  return {
    type: "helloResult",
    replyTo,
    protocol: 1,
    engine: {
      name: "partcraft-engine",
      version: "v2026.11.5",
      versionFull: "v2026.11.5.13.12369",
      buildType: "Release",
      platform: kind,
      os: kind === "native" ? "windows-x64" : "wasm32",
      compiler: "fake 1.0",
      testCommands: false,
    },
    components: {
      occt: "8.0.2",
      planegcs: { source: "FreeCAD 1.1.4", commit: "4fd3bf32" },
      eigen: "3.4.0",
      boost: "1.86",
      nlohmannJson: "3.11.3",
    },
    capabilities: { pingWhileBusy: kind === "native", cancelWhileBusy: true },
    limits: { maxHeaderBytes: 16777216, maxPayloadBytes: 1073741824, payloadAlignment: 16, maxRequestId: 2147483647 },
  };
}

export const kernelResult = (replyTo: number, passed = true): Record<string, unknown> => ({
  type: "kernelSelftestResult",
  replyTo,
  passed,
  ...(passed ? {} : { problem: "step hole: volume 1 differs from the expected 2" }),
  volume: 73587.3,
  expectedVolume: 73587.3,
  faceCount: 8,
  expectedFaceCount: 8,
  volumeTolerance: 1e-6,
  steps: [],
  timeMs: 5.8,
});

export const solverResult = (replyTo: number, passed = true): Record<string, unknown> => ({
  type: "solverSelftestResult",
  replyTo,
  passed,
  ...(passed ? {} : { problem: "solver reported conflicting constraints" }),
  status: passed ? "solved" : "conflicting",
  algorithm: "DogLeg",
  dof: 0,
  expectedDof: 0,
  conflicting: [],
  redundant: [],
  maxResidual: 1e-14,
  residualTolerance: 1e-9,
  maxDeviation: 1e-14,
  reference: {},
  parameterCount: 12,
  constraintCount: 14,
  timeMs: 0.6,
});

/** Answers hello and both self-tests like a healthy engine. */
export function healthyEngine(cmd: SentCommand, t: FakeTransport): void {
  if (cmd.type === "hello") t.say(helloResult(cmd.id, t.kind));
  else if (cmd.type === "diagnostics.kernelSelftest") t.say(kernelResult(cmd.id));
  else if (cmd.type === "diagnostics.solverSelftest") t.say(solverResult(cmd.id));
  else if (cmd.type === "ping") t.say({ type: "pong", replyTo: cmd.id, busyWith: null, queued: 0 });
  else if (cmd.type === "shutdown") t.say({ type: "bye", replyTo: cmd.id });
}
