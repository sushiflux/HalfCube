// Engine harness for the end-to-end suite: runs the product's own engine session (createEngineSession, the same code the
// app uses) in the page it is loaded in, so the suite can drive the engine through the real transport: the native engine
// process behind the preload bridge of the Electron window.
// The page is a test tool, not part of the product. Tests start a run with window.__harness.run(name) and read the result.
import { createEngineSession, type EngineSession, type EngineStatus } from "../../../app/src/engine/index.ts";
import type { KernelSelftestResult, SolverSelftestResult } from "../../../app/src/engine/generated/protocol.ts";

export interface HarnessResult {
  crossOriginIsolated: boolean | undefined;
  /** Where the engine ran: the native engine process. */
  transport: "native";
  startup: { phase: string; steps: StepSummary[]; engine: string | undefined; protocol: number | undefined; problem: string | undefined };
  /** Distinct "phase | step states" lines seen while starting, in order. */
  stream: string[];
  kernel?: KernelSelftestResult;
  solver?: SolverSelftestResult;
}

interface StepSummary {
  id: string;
  state: string;
  detail: string | undefined;
}

declare global {
  interface Window {
    __harness: { run: (name: string) => Promise<HarnessResult> };
  }
}

const out = document.getElementById("out");

function summarize(status: EngineStatus): HarnessResult["startup"] {
  return {
    phase: status.phase,
    steps: status.steps.map((s) => ({ id: s.id, state: s.state, detail: s.detail })),
    engine: status.engine?.engine.name,
    protocol: status.engine?.protocol,
    problem: status.problem?.message,
  };
}

async function newSession(selftests: boolean): Promise<{ session: EngineSession; stream: string[]; transport: "native" }> {
  const stream: string[] = [];
  const session = createEngineSession({ startupSelftests: selftests, restartDelayMs: 50 });
  session.subscribe((s) => {
    const line = `${s.phase} | ${s.steps.map((x) => `${x.id}:${x.state}`).join(",")}`;
    if (stream[stream.length - 1] !== line) stream.push(line);
  });
  return { session, stream, transport: "native" };
}

async function run(name: string): Promise<HarnessResult> {
  const base = { crossOriginIsolated: (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated };
  if (name === "startup") {
    // The normal start: handshake, kernel self-test, solver self-test, as the loading screen shows them.
    const { session, stream, transport } = await newSession(true);
    const status = await session.start();
    const result: HarnessResult = { ...base, transport, startup: summarize(status), stream };
    if (status.selftests.kernel) result.kernel = status.selftests.kernel;
    if (status.selftests.solver) result.solver = status.selftests.solver;
    await session.stop();
    return result;
  }
  if (name === "selftests") {
    // Both self-tests as explicit commands through the transport, after a start without the automatic ones.
    const { session, stream, transport } = await newSession(false);
    const status = await session.start();
    const result: HarnessResult = { ...base, transport, startup: summarize(status), stream };
    result.kernel = (await session.client.request({ type: "diagnostics.kernelSelftest" }).reply).message;
    result.solver = (await session.client.request({ type: "diagnostics.solverSelftest" }).reply).message;
    await session.stop();
    return result;
  }
  throw new Error(`Unknown harness run "${name}".`);
}

window.__harness = {
  run: async (name) => {
    try {
      const result = await run(name);
      if (out) out.textContent = JSON.stringify(result, null, 1);
      return result;
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      if (out) out.textContent = `error: ${message}`;
      throw error;
    }
  },
};
if (out) out.textContent = "ready";
