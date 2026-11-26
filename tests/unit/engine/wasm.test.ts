// The real WebAssembly engine (build with test commands) loaded through the real worker code in a Node worker thread,
// behind the real client and the browser's WorkerTransport.
import { expect, it } from "vitest";
import { EngineCrashedError } from "../../../app/src/engine/errors.ts";
import { WorkerTransport } from "../../../app/src/engine/transports/worker-transport.ts";
import { describeUnless, skipUnlessWasmRelease, skipUnlessWasmTesting, wasmReleaseDir, wasmTestingDir, wasmModuleUrl } from "./helpers/builds.ts";
import { defineContract } from "./helpers/contract.ts";
import { defineModelContract } from "./helpers/model-contract.ts";
import { startEngine } from "./helpers/harness.ts";
import { nodeWorkerPort } from "./helpers/node-worker-port.ts";

const wasm = { kind: "wasm" as const, path: wasmTestingDir };

defineContract(
  "wasm",
  wasm,
  {
    kind: "fatal",
    message: {
      // Release builds (no ASSERTIONS): abort() ends in an "unreachable" trap.
      abort: /The WebAssembly engine crashed: RuntimeError: (Aborted\(|unreachable)/,
      nullcall: /The WebAssembly engine crashed: RuntimeError: (null function or function signature mismatch|function signature mismatch)/,
      intdiv: /The WebAssembly engine crashed: RuntimeError: divide by zero/,
    },
  },
  skipUnlessWasmTesting,
);

describeUnless(skipUnlessWasmTesting, "wasm engine specifics", () => {
  it("hello names the WebAssembly platform and reports that ping waits for the running command", async () => {
    const e = await startEngine(wasm);
    expect(e.client.hello?.engine).toMatchObject({ platform: "wasm", os: "wasm32", testCommands: true });
    expect(e.client.hello?.capabilities).toEqual({ pingWhileBusy: false, cancelWhileBusy: true });
    expect(e.client.transportKind).toBe("wasm");
    await e.client.stop();
  });

  it("without the shared cancel flag the engine says it cannot cancel a running command", async () => {
    const e = await startEngine(wasm, { sharedCancel: false });
    expect(e.client.hello?.capabilities.cancelWhileBusy).toBe(false);
    await e.client.stop();
  });

  it("applies the default time limit of the WebAssembly engine to a frozen engine (short limit via options)", async () => {
    const e = await startEngine(wasm, { defaultTimeoutMs: 300 });
    const err = await e.client.request({ type: "diagnostics.hang", mode: "frozen" }).reply.catch((x: unknown) => x);
    expect(err).toBeInstanceOf(EngineCrashedError);
    expect((err as EngineCrashedError).info.kind).toBe("hang");
    expect((err as EngineCrashedError).info.message).toMatch(/The engine worker was terminated\.$/);
    await e.client.restart();
    expect((await e.client.request({ type: "ping" }).reply).message.type).toBe("pong");
    await e.client.stop();
  });

  it("a trapped module is never reused: the worker is thrown away and a restart loads a fresh one", async () => {
    const e = await startEngine(wasm);
    const first = e.transports[0]!;
    await e.client.request({ type: "diagnostics.crash", mode: "intdiv" }).reply.catch(() => null);
    expect(e.client.state).toBe("down");
    await e.client.restart();
    expect(e.transports[1]).not.toBe(first);
    expect((await e.client.request({ type: "diagnostics.kernelSelftest" }).reply).message.passed).toBe(true);
    await e.client.stop();
  });

  it("reports a module that cannot be loaded with the URL", async () => {
    const t = new WorkerTransport({ createPort: () => nodeWorkerPort(), moduleUrl: "file:///nowhere/halfcube-engine.mjs" });
    await expect(t.start()).rejects.toThrow(/The WebAssembly engine could not be loaded from file:\/\/\/nowhere\/halfcube-engine\.mjs: /);
  });

  it("gives up when the module does not become ready in time", async () => {
    const t = new WorkerTransport({
      // A worker that never answers: an empty module worker.
      createPort: () => nodeWorkerPort(new URL("./helpers/silent-worker.mjs", import.meta.url)),
      moduleUrl: wasmModuleUrl(wasmTestingDir),
      startTimeoutMs: 200,
    });
    await expect(t.start()).rejects.toThrow(/did not become ready within 0\.2 s/);
  });
});

describeUnless(skipUnlessWasmRelease, "wasm release build", () => {
  it("passes both self-tests and refuses test commands", async () => {
    const e = await startEngine({ kind: "wasm", path: wasmReleaseDir });
    expect(e.client.hello?.engine.testCommands).toBe(false);
    expect((await e.client.request({ type: "diagnostics.kernelSelftest" }).reply).message.passed).toBe(true);
    expect((await e.client.request({ type: "diagnostics.solverSelftest" }).reply).message.passed).toBe(true);
    const err = await e.client.request({ type: "diagnostics.hang", mode: "busy", ms: 1 }).reply.catch((x: unknown) => x);
    expect(err).toMatchObject({ code: "test_commands_disabled" });
    await e.client.stop();
    expect(e.schemaErrors).toEqual([]);
  });
});

defineModelContract("wasm", wasm, skipUnlessWasmTesting);
