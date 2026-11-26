// The Electron engine host (supervision, forwarding, cleanup) against the real native engine, with the page side
// played by the real DesktopTransport, client and session. Only the Electron MessageChannelMain is replaced by a
// Node MessageChannel (see engine-ipc.ts for the Electron adapter).
import { MessageChannel, type MessagePort as NodeMessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineBridge, FromMain } from "../../../app/src/engine/bridge.ts";
import { EngineCrashedError } from "../../../app/src/engine/errors.ts";
import { EngineSession } from "../../../app/src/engine/session.ts";
import { DesktopTransport } from "../../../app/src/engine/transports/desktop-transport.ts";
import { EngineHost, type EngineHostOptions, type UiChannel } from "../../../desktop/src/engine-host.ts";
import { describeUnless, nativeTestingExe, skipUnlessNativeTesting } from "./helpers/builds.ts";
import { delay, processAlive } from "./helpers/harness.ts";

interface Rig {
  host: EngineHost;
  bridge: EngineBridge;
  /** Page ends of every channel the host opened, by generation. */
  pagePorts: Map<number, NodeMessagePort>;
  logs: string[];
  session(options?: Partial<ConstructorParameters<typeof EngineSession>[0]>): EngineSession;
}

const rigs: Rig[] = [];
const sessions: EngineSession[] = [];

function rig(options: Partial<EngineHostOptions> = {}, exe: string = nativeTestingExe): Rig {
  const pagePorts = new Map<number, NodeMessagePort>();
  const logs: string[] = [];
  const createChannel = (): UiChannel => {
    const { port1, port2 } = new MessageChannel();
    return {
      host: {
        postMessage: (m: FromMain) => port1.postMessage(m),
        onMessage: (h) => port1.on("message", h),
        onClose: (h) => port1.on("close", h),
        start: () => {},
        close: () => port1.close(),
      },
      deliver: (generation) => {
        pagePorts.set(generation, port2);
      },
    };
  };
  const host = new EngineHost({
    locate: () => ({ ok: true, exe }),
    createChannel,
    log: (l) => logs.push(l),
    closeDelayMs: 20,
    ...options,
  });
  const bridge: EngineBridge = { startEngine: () => host.start() };
  const r: Rig = {
    host,
    bridge,
    pagePorts,
    logs,
    session: (o = {}) => {
      const s = new EngineSession({
        createTransport: () => new DesktopTransport(bridge, async (g) => pagePorts.get(g) as unknown as MessagePort),
        restartDelayMs: 10,
        ...o,
      });
      sessions.push(s);
      return s;
    },
  };
  rigs.push(r);
  return r;
}

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop().catch(() => {});
  for (const r of rigs.splice(0)) r.host.kill();
});

describeUnless(skipUnlessNativeTesting, "EngineHost with the real native engine", () => {
  it("serves the whole startup through the port: hello, kernel and solver self-test, ready", async () => {
    const r = rig();
    const s = r.session();
    const status = await s.start();
    expect(status.phase).toBe("ready");
    expect(status.engine?.engine.platform).toBe("native");
    expect(status.selftests.kernel?.passed && status.selftests.solver?.passed).toBe(true);
    expect(r.host.isRunning).toBe(true);
  }, 20_000);

  it("keeps pongs for its own pings away from the page", async () => {
    const r = rig({ pingIntervalMs: 50, pingTimeoutMs: 1000 });
    const unsolicited: unknown[] = [];
    const s = r.session({ onUnsolicited: (m) => unsolicited.push(m) });
    await s.start();
    await delay(400); // several watchdog rounds
    expect(unsolicited).toEqual([]);
    expect(s.getStatus().phase).toBe("ready");
  }, 20_000);

  it("does not stop an engine that computes for longer than the ping timeout (pings are answered while busy)", async () => {
    const r = rig({ pingIntervalMs: 50, pingTimeoutMs: 300 });
    const s = r.session();
    await s.start();
    const result = await s.client.request({ type: "diagnostics.hang", mode: "busy", ms: 1200 }).reply;
    expect(result.message.ms).toBeGreaterThanOrEqual(1200);
    expect(s.getStatus().phase).toBe("ready");
  }, 20_000);

  it("stops a frozen engine when its liveness pings stay unanswered, reports a hang and the session restarts it", async () => {
    const r = rig({ pingIntervalMs: 100, pingTimeoutMs: 500 });
    const s = r.session();
    await s.start();
    const firstPid = r.host.pid!;
    const frozen = s.client.request({ type: "diagnostics.hang", mode: "frozen" });
    const outcome = frozen.reply.catch((e: unknown) => e);
    const t0 = performance.now();
    const err = (await outcome) as EngineCrashedError;
    const waited = performance.now() - t0;
    expect(err).toBeInstanceOf(EngineCrashedError);
    expect(err.info.kind).toBe("hang");
    expect(err.info.message).toMatch(/did not answer a liveness check \(ping \d+\) within 0\.5 s and was stopped\. Its process id was \d+\./);
    expect(err.info.diagnostics).toContain('diagnostics.hang "frozen"');
    expect(waited).toBeGreaterThan(450);
    expect(waited).toBeLessThan(2500);
    await vi.waitFor(() => expect(processAlive(firstPid)).toBe(false), { timeout: 3000 });
    expect(s.getStatus().history.map((p) => p.code)).toEqual(["engine_hung"]);
    await vi.waitFor(() => expect(s.getStatus().phase).toBe("ready"), { timeout: 10_000 });
    expect(r.host.pid).not.toBe(firstPid);
    expect(s.getStatus().restarts).toBe(1);
  }, 30_000);

  it("uses ping every 1 s and a timeout of 5 s by default", async () => {
    const r = rig();
    const s = r.session({ autoRestart: false, startupSelftests: false });
    await s.start();
    const outcome = s.client.request({ type: "diagnostics.hang", mode: "frozen" }).reply.catch((e: unknown) => e);
    const t0 = performance.now();
    const err = (await outcome) as EngineCrashedError;
    const waited = performance.now() - t0;
    expect(err.info.message).toMatch(/within 5 s/);
    // Next tick at or after the first ping that stays unanswered for more than 5 s: between 5 and 7.5 s.
    expect(waited).toBeGreaterThan(5000);
    expect(waited).toBeLessThan(7500);
  }, 30_000);

  it("reports a crash with exit code and the engine's last words, and the session replaces the engine", async () => {
    const r = rig();
    const s = r.session();
    await s.start();
    const firstPid = r.host.pid!;
    const err = (await s.client.request({ type: "diagnostics.crash", mode: "intdiv" }).reply.catch((e: unknown) => e)) as EngineCrashedError;
    expect(err.info).toMatchObject({ kind: "exit", code: 0xc0000094 });
    expect(err.info.diagnostics).toContain('diagnostics.crash "intdiv" requested');
    const problem = s.getStatus().problem!;
    expect(problem.code).toBe("engine_crashed");
    expect(problem.details).toContain("Exit code: 3221225620 (0xC0000094)");
    await vi.waitFor(() => expect(s.getStatus().phase).toBe("ready"), { timeout: 10_000 });
    expect(r.host.pid).not.toBe(firstPid);
    expect((await s.client.request({ type: "ping" }).reply).message.type).toBe("pong");
  }, 30_000);

  it("kills the engine when the page goes away (reload, window closed)", async () => {
    const r = rig();
    const s = r.session();
    await s.start();
    const pid = r.host.pid!;
    r.pagePorts.get(1)!.close();
    await vi.waitFor(() => expect(processAlive(pid)).toBe(false), { timeout: 3000 });
    expect(r.host.isRunning).toBe(false);
  }, 20_000);

  it("kills the previous engine when the page asks for a new one", async () => {
    const r = rig();
    const first = await r.bridge.startEngine();
    expect(first).toEqual({ ok: true, generation: 1 });
    const pid1 = r.host.pid!;
    const second = await r.bridge.startEngine();
    expect(second).toEqual({ ok: true, generation: 2 });
    await vi.waitFor(() => expect(processAlive(pid1)).toBe(false), { timeout: 3000 });
    expect(r.host.pid).not.toBe(pid1);
  }, 20_000);

  it("ignores garbage from the page and keeps serving", async () => {
    const r = rig();
    const s = r.session();
    await s.start();
    const port = r.pagePorts.get(1)!;
    port.postMessage("not an object");
    port.postMessage({ kind: "msg", header: 42, payload: null });
    port.postMessage({ kind: "msg", header: "{}", payload: "no" });
    await delay(100);
    expect(r.logs.filter((l) => l.includes("ignored a message from the page"))).toHaveLength(3);
    expect((await s.client.request({ type: "ping" }).reply).message.type).toBe("pong");
  }, 20_000);

  it("graceful stop sends shutdown and the process ends", async () => {
    const r = rig();
    const s = r.session({ startupSelftests: false });
    await s.start();
    const pid = r.host.pid!;
    await r.host.stop();
    expect(processAlive(pid)).toBe(false);
    expect(r.host.isRunning).toBe(false);
  }, 20_000);
});

describe("EngineHost start failures", () => {
  it("returns the complete cause when the program is missing, and the session reports it", async () => {
    const r = rig({}, "C:\\does-not-exist\\halfcube-engine.exe");
    const s = r.session();
    const status = await s.start();
    expect(status.phase).toBe("failed");
    expect(status.problem?.code).toBe("engine_start_failed");
    expect(status.problem?.message).toMatch(/The engine could not be started \(C:\\does-not-exist\\halfcube-engine\.exe\): spawn .*ENOENT/);
    expect(status.problem?.message).toContain("Engine program: C:\\does-not-exist\\halfcube-engine.exe");
  });

  it("passes on what the locator says when the program cannot be found", async () => {
    const r = rig({ locate: () => ({ ok: false, message: "The engine program is missing from the installation. Reinstall HalfCube.", details: "Looked for: X" }) });
    expect(await r.bridge.startEngine()).toEqual({
      ok: false,
      message: "The engine program is missing from the installation. Reinstall HalfCube.",
      details: "Looked for: X",
    });
  });
});
