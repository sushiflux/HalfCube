// Engine session against a scripted fake transport: the startup status stream, problems with copyable details and
// restart handling.
import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_ID, PROTOCOL_VERSION } from "../../../app/src/engine/generated/protocol.ts";
import { EngineSession, type EngineSessionOptions } from "../../../app/src/engine/session.ts";
import type { EngineStatus } from "../../../app/src/engine/status.ts";
import type { ExitInfo } from "../../../app/src/engine/transport.ts";
import { FakeTransport, healthyEngine, helloResult, kernelResult } from "./helpers/fake-transport.ts";

function setup(options: Partial<EngineSessionOptions> = {}, onNewTransport?: (t: FakeTransport, index: number) => void) {
  const transports: FakeTransport[] = [];
  const session = new EngineSession({
    createTransport: () => {
      const t = new FakeTransport();
      t.autoReply = healthyEngine;
      onNewTransport?.(t, transports.length);
      transports.push(t);
      return t;
    },
    restartDelayMs: 0,
    appVersion: "HalfCube v2026.1.2.3.4 (</>)",
    ...options,
  });
  const seen: EngineStatus[] = [];
  session.subscribe((s) => seen.push(s));
  return { session, transports, seen, current: () => transports.at(-1)! };
}

const crashInfo: ExitInfo = {
  kind: "exit",
  message: "The engine process ended with exit code 3221225477 (0xC0000005, access violation).",
  code: 0xc0000005,
  diagnostics: "halfcube-engine: something printed before dying",
};

const stepStates = (s: EngineStatus) => s.steps.map((x) => `${x.id}:${x.state}`).join(" ");

describe("EngineSession startup", () => {
  it("runs engine, kernel and solver in order and ends ready; the stream shows every step", async () => {
    const { session, seen } = setup();
    expect(session.getStatus().phase).toBe("idle");
    const final = await session.start();
    expect(final.phase).toBe("ready");
    expect(final.progress).toBe(1);
    expect(final.engine?.engine.name).toBe("halfcube-engine");
    expect(final.selftests.kernel?.passed).toBe(true);
    expect(final.selftests.solver?.passed).toBe(true);
    expect(final.problem).toBeNull();

    const states = seen.map(stepStates);
    const firstIndex = (text: string) => states.findIndex((s) => s === text);
    const order = [
      "engine:running kernel:pending solver:pending",
      "engine:done kernel:pending solver:pending",
      "engine:done kernel:running solver:pending",
      "engine:done kernel:done solver:pending",
      "engine:done kernel:done solver:running",
      "engine:done kernel:done solver:done",
    ].map(firstIndex);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Progress never goes back and every change gets a new revision.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.progress).toBeGreaterThanOrEqual(seen[i - 1]!.progress);
      expect(seen[i]!.revision).toBe(seen[i - 1]!.revision + 1);
    }
    expect(seen.at(-1)!.phase).toBe("ready");
    expect(final.steps[1]!.detail).toBe("OCCT 8.0.2, 8 faces, volume 73587.3 mm3, 5.8 ms");
    expect(final.steps.every((s) => typeof s.durationMs === "number")).toBe(true);
  });

  it("returns the same snapshot object between changes (usable with useSyncExternalStore)", async () => {
    const { session } = setup();
    await session.start();
    expect(session.getStatus()).toBe(session.getStatus());
  });

  it("skips the self-tests when they are switched off", async () => {
    const { session, current } = setup({ startupSelftests: false });
    const final = await session.start();
    expect(final.phase).toBe("ready");
    expect(stepStates(final)).toBe("engine:done kernel:skipped solver:skipped");
    expect(current().sent.map((s) => s.type)).toEqual(["hello"]);
  });

  it("start() while running returns the same run; whenReady resolves with the client", async () => {
    const { session } = setup();
    const a = session.start();
    const b = session.start();
    expect(b).toBe(a);
    const client = await session.whenReady();
    expect(client).toBe(session.client);
    expect((await a).phase).toBe("ready");
  });

  it("fails with the full cause when the engine cannot be started", async () => {
    const { session } = setup({}, (t) => {
      t.startError = new Error("The engine could not be started (C:\\app\\engine\\halfcube-engine.exe): spawn ENOENT");
    });
    const final = await session.start();
    expect(final.phase).toBe("failed");
    expect(stepStates(final)).toBe("engine:failed kernel:pending solver:pending");
    const p = final.problem!;
    expect(p.code).toBe("engine_start_failed");
    expect(p.step).toBe("engine");
    expect(p.message).toContain("spawn ENOENT");
    for (const part of ["HalfCube engine problem", "Program: HalfCube v2026.1.2.3.4 (</>)", "Code: engine_start_failed", "Step: start of the engine", "Cause: The engine could not be started", "--- Raw error text ---"]) {
      expect(p.details).toContain(part);
    }
    expect(final.history).toEqual([p]);
    await expect(session.whenReady()).rejects.toThrow(/spawn ENOENT/);
  });

  it("names a refused handshake with the engine's own text", async () => {
    const { session } = setup({}, (t) => {
      t.autoReply = (cmd, tr) =>
        tr.say({ type: "error", replyTo: cmd.id, code: "protocol_mismatch", message: "The engine speaks protocol version 2.", command: "hello" });
    });
    const final = await session.start();
    expect(final.problem).toMatchObject({ code: "engine_refused", step: "engine" });
    expect(final.problem!.message).toBe("The engine refused the handshake (protocol_mismatch): The engine speaks protocol version 2.");
  });

  it("names an engine that answers with another protocol id as a refused handshake, with both values", async () => {
    const { session } = setup({}, (t) => {
      t.autoReply = (cmd, tr) => tr.say({ ...helloResult(cmd.id), protocolId: "0123456789abcdef" });
    });
    const final = await session.start();
    expect(final.problem).toMatchObject({ code: "engine_refused", step: "engine" });
    expect(final.problem!.message).toBe(
      `The engine refused the handshake (protocol_mismatch): This program speaks protocol "${PROTOCOL_ID}" (version ${PROTOCOL_VERSION}), ` +
        `the engine answered with protocol "0123456789abcdef" (version ${PROTOCOL_VERSION}). User interface and engine come from different builds; reinstall HalfCube.`,
    );
  });

  it("fails on a wrong kernel self-test result and keeps the full result in the details", async () => {
    const { session } = setup({}, (t) => {
      t.autoReply = (cmd, tr) => {
        if (cmd.type === "diagnostics.kernelSelftest") tr.say(kernelResult(cmd.id, false));
        else healthyEngine(cmd, tr);
      };
    });
    const final = await session.start();
    expect(final.phase).toBe("failed");
    expect(stepStates(final)).toBe("engine:done kernel:failed solver:pending");
    expect(final.problem!.code).toBe("kernel_selftest_failed");
    expect(final.problem!.message).toBe("Kernel self-test failed: step hole: volume 1 differs from the expected 2");
    expect(final.problem!.details).toContain("--- Kernel self-test result ---");
    expect(final.problem!.details).toContain('"expectedFaceCount": 8');
    expect(final.problem!.details).toContain("Engine: halfcube-engine v2026.11.5.13.12369");
    expect(final.selftests.kernel?.passed).toBe(false);
  });

  it("reports an engine that dies during a self-test with exit code and diagnostics, and does not restart a first start", async () => {
    const { session, transports } = setup({}, (t) => {
      t.autoReply = (cmd, tr) => {
        if (cmd.type === "diagnostics.solverSelftest") tr.die(crashInfo);
        else healthyEngine(cmd, tr);
      };
    });
    const final = await session.start();
    expect(final.phase).toBe("failed");
    expect(final.problem).toMatchObject({ code: "engine_crashed", step: "solver" });
    expect(final.problem!.message).toBe(`The engine stopped unexpectedly. ${crashInfo.message}`);
    expect(final.problem!.details).toContain("Exit code: 3221225477 (0xC0000005)");
    expect(final.problem!.details).toContain("something printed before dying");
    expect(final.problem!.details).toContain("Connection: native engine process");
    expect(transports).toHaveLength(1);
  });

  it("retry() starts over after a failure", async () => {
    let failFirst = true;
    const { session } = setup({}, (t) => {
      if (failFirst) t.startError = new Error("first start failed");
      failFirst = false;
    });
    expect((await session.start()).phase).toBe("failed");
    const again = await session.retry();
    expect(again.phase).toBe("ready");
    expect(again.problem).toBeNull();
    expect(again.history).toHaveLength(1);
    expect(again.attempt).toBe(2);
  });
});

describe("EngineSession restart handling", () => {
  it("replaces an engine that crashes while running, keeps the problem visible meanwhile and ends ready", async () => {
    const { session, transports, seen } = setup();
    await session.start();
    transports[0]!.die(crashInfo);
    expect(session.getStatus()).toMatchObject({ phase: "restarting", restarts: 1 });
    expect(session.getStatus().problem?.code).toBe("engine_crashed");
    await vi.waitFor(() => expect(session.getStatus().phase).toBe("ready"));
    const s = session.getStatus();
    expect(s.problem).toBeNull();
    expect(s.history.map((p) => p.code)).toEqual(["engine_crashed"]);
    expect(s.restarts).toBe(1);
    expect(transports).toHaveLength(2);
    // A restart does the handshake only; the self-tests are not repeated.
    expect(transports[1]!.sent.map((c) => c.type)).toEqual(["hello"]);
    expect(seen.some((x) => x.phase === "restarting")).toBe(true);
  });

  it("repeats the self-tests after a restart when asked to", async () => {
    const { session, transports } = setup({ restartSelftests: true });
    await session.start();
    transports[0]!.die(crashInfo);
    await vi.waitFor(() => expect(session.getStatus().phase).toBe("ready"));
    expect(transports[1]!.sent.map((c) => c.type)).toEqual(["hello", "diagnostics.kernelSelftest", "diagnostics.solverSelftest"]);
  });

  it("reports a hang as engine_hung with the watchdog's text", async () => {
    const { session, transports } = setup({ autoRestart: false });
    await session.start();
    transports[0]!.die({ kind: "hang", message: "The engine did not answer a liveness check (ping 2147483647) within 5 s and was stopped. Its process id was 4242." });
    expect(session.getStatus().phase).toBe("failed");
    expect(session.getStatus().problem).toMatchObject({ code: "engine_hung" });
    expect(session.getStatus().problem!.message).toContain("process id was 4242");
  });

  it("gives up with engine_restart_limit when the engine keeps dying", async () => {
    const { session, transports } = setup({ restartLimit: { max: 2, windowMs: 60_000 } });
    await session.start();
    for (let i = 0; i < 2; i++) {
      transports.at(-1)!.die(crashInfo);
      await vi.waitFor(() => expect(session.getStatus().phase).toBe("ready"));
    }
    transports.at(-1)!.die(crashInfo);
    const s = session.getStatus();
    expect(s.phase).toBe("failed");
    expect(s.problem!.code).toBe("engine_restart_limit");
    expect(s.problem!.message).toContain("stopped 3 times within 60 s (limit 2)");
    expect(s.problem!.details).toContain("--- Problem 1 of 3");
    await expect(session.whenReady()).rejects.toThrow(/automatic restarts were stopped/);
    expect(transports).toHaveLength(3);
    // The user can still try again by hand.
    const again = await session.retry();
    expect(again.phase).toBe("ready");
  });

  it("retries a restart that fails to start, within the limit", async () => {
    let n = 0;
    const { session, transports } = setup({}, (t, index) => {
      if (index === 1) t.startError = new Error("cannot spawn");
      n++;
    });
    await session.start();
    transports[0]!.die(crashInfo);
    await vi.waitFor(() => expect(session.getStatus().phase).toBe("ready"));
    expect(n).toBe(3);
    expect(session.getStatus().history.map((p) => p.code)).toEqual(["engine_crashed", "engine_start_failed"]);
  });

  it("a manual restart() replaces the engine and counts it", async () => {
    const { session, transports } = setup();
    await session.start();
    const s = await session.restart();
    expect(s.phase).toBe("ready");
    expect(s.restarts).toBe(1);
    expect(transports[0]!.killed).toBe(true);
    expect(transports).toHaveLength(2);
  });

  it("whenReady keeps waiting through a restart", async () => {
    const { session, transports } = setup();
    await session.start();
    transports[0]!.die(crashInfo);
    const ready = session.whenReady();
    await expect(ready).resolves.toBe(session.client);
  });

  it("stop() ends the session for good", async () => {
    const { session, transports } = setup();
    await session.start();
    await session.stop();
    expect(session.getStatus().phase).toBe("stopped");
    expect(transports[0]!.killed).toBe(true);
    await expect(session.whenReady()).rejects.toThrow(/not running/);
    // An exit after a deliberate stop is not a crash.
    transports[0]!.die(crashInfo);
    expect(session.getStatus().phase).toBe("stopped");
  });
});
