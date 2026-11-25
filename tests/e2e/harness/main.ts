// Engine harness for the end-to-end suite: runs the product's own engine session (createEngineSession, the same code the
// app uses) in the page it is loaded in, so the suite can drive the engine through the real transport: the WebAssembly
// engine in a Web Worker in a browser, the native engine process behind the preload bridge in the Electron window.
// The page is a test tool, not part of the product. Tests start a run with window.__harness.run(name) and read the result.
import { createEngineSession, WASM_ENGINE_FOLDER, WASM_MODULE_FILE, type EngineSession, type EngineStatus } from "../../../app/src/engine/index.ts";
import type { KernelSelftestResult, SolverSelftestResult } from "../../../app/src/engine/generated/protocol.ts";

export interface HarnessResult {
  crossOriginIsolated: boolean | undefined;
  /** Where the engine ran: the Web Worker (browser) or the native process (desktop). */
  transport: "worker" | "native";
  startup: { phase: string; steps: StepSummary[]; engine: string | undefined; protocol: number | undefined; problem: string | undefined };
  /** Distinct "phase | step states" lines seen while starting, in order. */
  stream: string[];
  kernel?: KernelSelftestResult;
  solver?: SolverSelftestResult;
  hang?: { ms: number; name: string; info: unknown; afterPhase: string; restarts: number; history: string[] };
  trap?: { name: string; info: unknown; afterPhase: string; restarts: number };
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
const params = new URLSearchParams(location.search);
/** "engine" is the product engine, "engine-testing" the variant with crash and hang commands (browser only). */
const folder = params.get("folder") ?? WASM_ENGINE_FOLDER;

/** Resolves with the status as soon as `done` is true for it (also when it already is); rejects after `timeoutMs`. */
function untilStatus(session: EngineSession, done: (status: EngineStatus) => boolean, timeoutMs = 20_000): Promise<EngineStatus> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`The engine session did not reach the expected state within ${timeoutMs} ms; it is "${session.getStatus().phase}".`));
    }, timeoutMs);
    const check = () => {
      const status = session.getStatus();
      if (!done(status)) return;
      unsubscribe();
      clearTimeout(timer);
      resolve(status);
    };
    unsubscribe = session.subscribe(check);
    check();
  });
}

function summarize(status: EngineStatus): HarnessResult["startup"] {
  return {
    phase: status.phase,
    steps: status.steps.map((s) => ({ id: s.id, state: s.state, detail: s.detail })),
    engine: status.engine?.engine.name,
    protocol: status.engine?.protocol,
    problem: status.problem?.message,
  };
}

async function newSession(selftests: boolean): Promise<{ session: EngineSession; stream: string[]; transport: "worker" | "native" }> {
  const stream: string[] = [];
  // The harness page lives in /harness/, the engine folders next to it at the root.
  const wasmModuleUrl = new URL(`/${folder}/${WASM_MODULE_FILE}`, location.origin).href;
  const session = createEngineSession({ wasmModuleUrl, startupSelftests: selftests, restartDelayMs: 50 });
  session.subscribe((s) => {
    const line = `${s.phase} | ${s.steps.map((x) => `${x.id}:${x.state}`).join(",")}`;
    if (stream[stream.length - 1] !== line) stream.push(line);
  });
  return { session, stream, transport: window.desktopBridge ? "native" : "worker" };
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
  if (name === "hang-and-trap") {
    // Needs the testing engine: a frozen engine is stopped by the watchdog, a trap ends the engine; both are replaced.
    const { session, stream, transport } = await newSession(false);
    const status = await session.start();
    const result: HarnessResult = { ...base, transport, startup: summarize(status), stream };
    const t0 = performance.now();
    const hang = await session.client.request({ type: "diagnostics.hang", mode: "frozen" }, { timeoutMs: 500 }).reply.catch((e: Error & { info?: unknown }) => e);
    const hangMs = Math.round(performance.now() - t0);
    const afterHang = await untilStatus(session, (s) => s.phase === "ready" && s.restarts === 1);
    result.hang = {
      ms: hangMs,
      name: hang instanceof Error ? hang.name : "no error",
      info: (hang as { info?: unknown }).info,
      afterPhase: afterHang.phase,
      restarts: afterHang.restarts,
      history: afterHang.history.map((p) => p.code),
    };
    const trap = await session.client.request({ type: "diagnostics.crash", mode: "intdiv" }).reply.catch((e: Error & { info?: unknown }) => e);
    const afterTrap = await untilStatus(session, (s) => s.phase === "ready" && s.restarts === 2);
    result.trap = {
      name: trap instanceof Error ? trap.name : "no error",
      info: (trap as { info?: unknown }).info,
      afterPhase: afterTrap.phase,
      restarts: afterTrap.restarts,
    };
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
