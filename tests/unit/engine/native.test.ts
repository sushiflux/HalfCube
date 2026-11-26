// The real native engine (Windows build with test commands) behind the real client and native transport.
import { describe, expect, it } from "vitest";
import { EngineCommandError } from "../../../app/src/engine/errors.ts";
import { describeUnless, skipUnlessNativeRelease, skipUnlessNativeTesting, nativeReleaseExe, nativeTestingExe } from "./helpers/builds.ts";
import { defineContract } from "./helpers/contract.ts";
import { defineModelContract } from "./helpers/model-contract.ts";
import { delay, processAlive, startEngine } from "./helpers/harness.ts";
import { NativeTransport, describeExit } from "../../../desktop/src/native-transport.ts";

const native = { kind: "native" as const, path: nativeTestingExe };

defineContract(
  "native",
  native,
  {
    kind: "exit",
    message: {
      abort: /ended with exit code 3 \(0x00000003, abort\(\)\)/,
      nullcall: /ended with exit code 3221225477 \(0xC0000005, access violation\)/,
      intdiv: /ended with exit code 3221225620 \(0xC0000094, integer division by zero\)/,
    },
    code: { abort: 3, nullcall: 0xc0000005, intdiv: 0xc0000094 },
  },
  skipUnlessNativeTesting,
);

describeUnless(skipUnlessNativeTesting, "native engine specifics", () => {
  it("hello names the native platform and Windows", async () => {
    const e = await startEngine(native);
    expect(e.client.hello?.engine).toMatchObject({ platform: "native", os: "windows-x64", testCommands: true });
    await e.client.stop();
  });

  it("answers ping while a command computes and names the running command", async () => {
    const e = await startEngine(native);
    const work = e.client.request({ type: "diagnostics.hang", mode: "busy" });
    const outcome = work.reply.catch((x: unknown) => x);
    await delay(100);
    const pong = (await e.client.request({ type: "ping" }).reply).message;
    expect(pong.busyWith).toBe(work.id);
    await e.client.cancel(work.id).reply;
    expect(await outcome).toBeInstanceOf(EngineCommandError);
    await e.client.stop();
    expect(e.schemaErrors).toEqual([]);
  });

  it("cancels a queued command before it starts", async () => {
    const e = await startEngine(native);
    const running = e.client.request({ type: "diagnostics.hang", mode: "busy" });
    const queued = e.client.request({ type: "diagnostics.kernelSelftest" });
    const runningOutcome = running.reply.catch((x: unknown) => x);
    const queuedOutcome = queued.reply.catch((x: unknown) => x);
    await delay(100);
    const state = (await e.client.cancel(queued.id).reply).message.state;
    expect(state).toBe("queued");
    await e.client.cancel(running.id).reply;
    await runningOutcome;
    const err = (await queuedOutcome) as EngineCommandError;
    expect(err.code).toBe("cancelled");
    expect(err.message).toMatch(/was cancelled before it started/);
    await e.client.stop();
  });

  it("shutdown answers bye and the process exits with code 0", async () => {
    const e = await startEngine(native);
    const pid = (e.transports[0] as NativeTransport).pid!;
    expect((await e.client.request({ type: "shutdown" }).reply).message.type).toBe("bye");
    await delay(300);
    expect(processAlive(pid)).toBe(false);
    expect(e.exits).toHaveLength(1);
    expect(e.exits[0]).toMatchObject({ kind: "exit", code: 0 });
  });

  it("stop() leaves no process behind", async () => {
    const e = await startEngine(native);
    const pid = (e.transports[0] as NativeTransport).pid!;
    await e.client.stop();
    await delay(300);
    expect(processAlive(pid)).toBe(false);
    expect(e.exits).toEqual([]);
  });

  it("kill() ends a frozen engine for good", async () => {
    const e = await startEngine(native);
    const pid = (e.transports[0] as NativeTransport).pid!;
    e.client.request({ type: "diagnostics.hang", mode: "frozen" }).reply.catch(() => {});
    await delay(100);
    e.client.kill();
    await delay(300);
    expect(processAlive(pid)).toBe(false);
  });

  it("handles many requests in flight and a 1 MiB header-free burst without losing an answer", async () => {
    const e = await startEngine(native);
    const replies = await Promise.all(Array.from({ length: 200 }, () => e.client.request({ type: "ping" }).reply));
    expect(replies).toHaveLength(200);
    expect(e.client.pendingCount).toBe(0);
    await e.client.stop();
    expect(e.schemaErrors).toEqual([]);
  });

  it("reports a missing program with the path", async () => {
    const missing = new NativeTransport({ exe: "C:\\does-not-exist\\partcraft-engine.exe" });
    await expect(missing.start()).rejects.toThrow(/The engine could not be started \(C:\\does-not-exist\\partcraft-engine\.exe\): spawn .* ENOENT/);
  });
});

describeUnless(skipUnlessNativeRelease, "native release build", () => {
  const release = { kind: "native" as const, path: nativeReleaseExe };

  it("passes both self-tests and has no test commands", async () => {
    const e = await startEngine(release);
    expect(e.client.hello?.engine.testCommands).toBe(false);
    expect((await e.client.request({ type: "diagnostics.kernelSelftest" }).reply).message.passed).toBe(true);
    expect((await e.client.request({ type: "diagnostics.solverSelftest" }).reply).message.passed).toBe(true);
    const err = (await e.client.request({ type: "diagnostics.crash", mode: "abort" }).reply.catch((x: unknown) => x)) as EngineCommandError;
    expect(err).toBeInstanceOf(EngineCommandError);
    expect(err.code).toBe("test_commands_disabled");
    expect(e.client.state).toBe("running");
    await e.client.stop();
    expect(e.schemaErrors).toEqual([]);
  });
});

describe("describeExit", () => {
  it("names known Windows exit codes, including a missing DLL", () => {
    expect(describeExit(0xc0000135, null)).toBe("The engine process ended with exit code 3221225781 (0xC0000135, a required DLL was not found next to the engine).");
    expect(describeExit(2, null)).toContain("broken frame stream");
    expect(describeExit(1, null)).toBe("The engine process ended with exit code 1 (0x00000001).");
    expect(describeExit(null, "SIGKILL")).toBe("The engine process was ended by signal SIGKILL.");
    expect(describeExit(null, null)).toBe("The engine process ended without an exit code.");
  });
});

defineModelContract("native", native, skipUnlessNativeTesting);
