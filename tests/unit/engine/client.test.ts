// Engine client against a scripted fake transport: correlation, errors, interim messages, superseding, crash and hang
// handling, restart. No engine process involved; the contract tests (native.test.ts, wasm.test.ts) cover the real ones.
import { describe, expect, it } from "vitest";
import { EngineClient, type EngineClientOptions } from "../../../app/src/engine/client.ts";
import {
  EngineCommandError,
  EngineCrashedError,
  EngineNotRunningError,
  EngineSupersededError,
  isCancelled,
} from "../../../app/src/engine/errors.ts";
import type { EngineMessage } from "../../../app/src/engine/generated/protocol.ts";
import type { ExitInfo } from "../../../app/src/engine/transport.ts";
import { FakeTransport, healthyEngine, helloResult } from "./helpers/fake-transport.ts";
import { ManualClock } from "./helpers/manual-clock.ts";

function setup(kind: "native" | "wasm" = "native", extra: Partial<EngineClientOptions> = {}) {
  const transports: FakeTransport[] = [];
  const clock = new ManualClock();
  const exits: ExitInfo[] = [];
  const unsolicited: EngineMessage[] = [];
  const client = new EngineClient({
    createTransport: () => {
      const t = new FakeTransport(kind);
      t.autoReply = healthyEngine;
      transports.push(t);
      return t;
    },
    clock,
    clientName: "unit-test",
    onExit: (i) => exits.push(i),
    onUnsolicited: (m) => unsolicited.push(m),
    ...extra,
  });
  return { client, transports, clock, exits, unsolicited, current: () => transports.at(-1)! };
}

describe("EngineClient start", () => {
  it("performs the hello handshake with protocol 1 and the client name", async () => {
    const { client, current } = setup();
    const hello = await client.start();
    expect(hello.engine.name).toBe("partcraft-engine");
    expect(current().sent[0]).toMatchObject({ type: "hello", id: 1, raw: { protocol: 1, client: "unit-test" } });
    expect(client.state).toBe("running");
    expect(client.hello).toBe(hello);
    expect(client.transportKind).toBe("native");
  });

  it("rejects with the engine's own text when the handshake is refused, and stops that engine", async () => {
    let refusing!: FakeTransport;
    const client = new EngineClient({
      createTransport: () => {
        refusing = new FakeTransport();
        refusing.autoReply = (cmd, t) =>
          t.say({ type: "error", replyTo: cmd.id, code: "protocol_mismatch", message: "The engine speaks protocol version 1, the client asked for 99.", command: "hello" });
        return refusing;
      },
    });
    await expect(client.start()).rejects.toMatchObject({ name: "EngineCommandError", code: "protocol_mismatch" });
    expect(refusing.killed).toBe(true);
    expect(client.state).toBe("down");
  });

  it("rejects with the transport's cause when the engine cannot be started", async () => {
    const t = new FakeTransport();
    t.startError = new Error("The engine could not be started (C:\\x\\engine.exe): spawn ENOENT");
    const client = new EngineClient({ createTransport: () => t });
    await expect(client.start()).rejects.toThrow(/spawn ENOENT/);
    expect(client.state).toBe("down");
    expect(t.killed).toBe(true);
  });

  it("refuses a second start while an engine runs", async () => {
    const { client } = setup();
    await client.start();
    await expect(client.start()).rejects.toThrow(/already started/);
  });
});

describe("EngineClient requests", () => {
  it("correlates answers by replyTo, also when they arrive out of order", async () => {
    const { client, current } = setup();
    await client.start();
    current().autoReply = null;
    const a = client.request({ type: "ping" });
    const b = client.request({ type: "diagnostics.kernelSelftest" });
    expect([a.id, b.id]).toEqual([2, 3]);
    current().say({ type: "kernelSelftestResult", replyTo: 3, passed: true });
    current().say({ type: "pong", replyTo: 2, busyWith: null, queued: 0 });
    expect((await b.reply).message.type).toBe("kernelSelftestResult");
    expect((await a.reply).message.type).toBe("pong");
    expect(client.pendingCount).toBe(0);
  });

  it("rejects with EngineCommandError carrying code, text, detail and command", async () => {
    const { client, current } = setup();
    await client.start();
    current().autoReply = (cmd, t) =>
      t.say({ type: "error", replyTo: cmd.id, code: "internal", message: "Command failed inside the engine.", detail: "std::bad_alloc", command: cmd.type });
    const err = await client.request({ type: "diagnostics.solverSelftest" }).reply.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineCommandError);
    expect(err).toMatchObject({ code: "internal", message: "Command failed inside the engine.", detail: "std::bad_alloc", command: "diagnostics.solverSelftest" });
  });

  it("recognises a cancelled command", async () => {
    const { client, current } = setup();
    await client.start();
    current().autoReply = (cmd, t) => t.say({ type: "error", replyTo: cmd.id, code: "cancelled", message: "cancelled" });
    const err = await client.request({ type: "diagnostics.hang", mode: "busy" }).reply.catch((e: unknown) => e);
    expect(isCancelled(err)).toBe(true);
  });

  it("hands messages without an open request to onUnsolicited", async () => {
    const { client, current, unsolicited } = setup();
    await client.start();
    current().say({ type: "error", replyTo: null, code: "bad_message", message: "not JSON" });
    current().say({ type: "pong", replyTo: 999, busyWith: null, queued: 0 });
    expect(unsolicited.map((m) => m.type)).toEqual(["error", "pong"]);
  });

  it("routes interim messages to onProgress and keeps the request open", async () => {
    const { client, current } = setup();
    await client.start();
    current().autoReply = null;
    const seen: string[] = [];
    const h = client.request({ type: "diagnostics.hang", mode: "busy", ms: 100 }, { onProgress: (m) => seen.push(`${m.type}`) });
    current().say({ type: "progress", replyTo: h.id, done: 1, of: 4 });
    current().say({ type: "progress", replyTo: h.id, done: 2, of: 4 });
    expect(client.pendingCount).toBe(1);
    current().say({ type: "hangResult", replyTo: h.id, mode: "busy", ms: 100 });
    expect((await h.reply).message.type).toBe("hangResult");
    expect(seen).toEqual(["progress", "progress"]);
  });

  it("rejects at once when no engine is running", async () => {
    const { client } = setup();
    await expect(client.request({ type: "ping" }).reply).rejects.toBeInstanceOf(EngineNotRunningError);
  });

  it("rejects when the transport throws on send", async () => {
    const { client, current } = setup();
    await client.start();
    current().killed = true;
    await expect(client.request({ type: "ping" }).reply).rejects.toThrow(/Sending ping \(request 2\) to the engine failed/);
    expect(client.pendingCount).toBe(0);
  });
});

describe("EngineClient cancel and superseding", () => {
  it("sets the shared cancel flag before the cancel command (WebAssembly)", async () => {
    const { client, current } = setup("wasm");
    await client.start();
    current().autoReply = null;
    const work = client.request({ type: "diagnostics.hang", mode: "busy" });
    client.cancel(work.id);
    expect(current().cancelFlagCalls).toEqual([work.id]);
    expect(current().last("cancel").raw).toMatchObject({ target: work.id });
  });

  it("drops the answer of a superseded request, cancels it in the engine and delivers the newer one", async () => {
    const { client, current, unsolicited } = setup();
    await client.start();
    current().autoReply = null;
    const first = client.request({ type: "diagnostics.hang", mode: "busy", ms: 50 }, { supersedeKey: "drag" });
    const second = client.request({ type: "diagnostics.hang", mode: "busy", ms: 50 }, { supersedeKey: "drag" });
    await expect(first.reply).rejects.toBeInstanceOf(EngineSupersededError);
    const cancel = current().last("cancel");
    expect(cancel.raw).toMatchObject({ target: first.id });
    // The engine still answers everything it was sent; none of that may leak.
    current().say({ type: "cancelResult", replyTo: cancel.id, target: first.id, state: "running" });
    current().say({ type: "error", replyTo: first.id, code: "cancelled", message: "cancelled" });
    current().say({ type: "hangResult", replyTo: second.id, mode: "busy", ms: 50 });
    expect((await second.reply).message).toMatchObject({ type: "hangResult" });
    expect(unsolicited).toEqual([]);
    expect(client.pendingCount).toBe(0);
  });

  it("does not cancel a superseded request when asked not to", async () => {
    const { client, current } = setup();
    await client.start();
    current().autoReply = null;
    const first = client.request({ type: "diagnostics.hang", mode: "busy" }, { supersedeKey: "k" });
    client.request({ type: "diagnostics.hang", mode: "busy" }, { supersedeKey: "k", cancelSuperseded: false });
    await expect(first.reply).rejects.toBeInstanceOf(EngineSupersededError);
    expect(current().sent.filter((s) => s.type === "cancel")).toHaveLength(0);
  });

  it("does not supersede requests with other keys", async () => {
    const { client, current } = setup();
    await client.start();
    current().autoReply = null;
    const a = client.request({ type: "ping" }, { supersedeKey: "a" });
    client.request({ type: "ping" }, { supersedeKey: "b" });
    current().say({ type: "pong", replyTo: a.id, busyWith: null, queued: 0 });
    await expect(a.reply).resolves.toBeDefined();
  });
});

describe("EngineClient crash handling", () => {
  it("rejects every open request with the exit info and reports once", async () => {
    const { client, current, exits } = setup();
    await client.start();
    current().autoReply = null;
    const a = client.request({ type: "diagnostics.kernelSelftest" });
    const b = client.request({ type: "diagnostics.solverSelftest" });
    const info: ExitInfo = { kind: "exit", message: "The engine process ended with exit code 3221225477 (0xC0000005, access violation).", code: 0xc0000005 };
    current().die(info);
    for (const r of [a, b]) {
      const e = await r.reply.catch((x: unknown) => x);
      expect(e).toBeInstanceOf(EngineCrashedError);
      expect((e as EngineCrashedError).info).toBe(info);
    }
    expect(exits).toEqual([info]);
    expect(client.state).toBe("down");
    expect(client.hello).toBeNull();
    await expect(client.request({ type: "ping" }).reply).rejects.toBeInstanceOf(EngineNotRunningError);
  });

  it("closes the connection when the engine sends a header that is not JSON", async () => {
    const { client, current, exits } = setup();
    await client.start();
    current().autoReply = null;
    const pending = client.request({ type: "ping" });
    current().onMessage?.("{not json", null);
    await expect(pending.reply).rejects.toBeInstanceOf(EngineCrashedError);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.kind).toBe("error");
    expect(exits[0]!.message).toMatch(/cannot be read/);
    expect(current().killed).toBe(true);
  });

  it("ignores late events of an engine that was replaced", async () => {
    const { client, transports, exits } = setup();
    await client.start();
    const old = transports[0]!;
    await client.restart();
    expect(old.killed).toBe(true);
    old.die({ kind: "exit", message: "late" });
    old.say({ type: "pong", replyTo: 1, busyWith: null, queued: 0 });
    expect(exits).toEqual([]);
    expect(client.state).toBe("running");
  });
});

describe("EngineClient restart and stop", () => {
  it("restart() replaces the engine, rejects open requests and starts ids at 1 again", async () => {
    const { client, transports, current } = setup();
    await client.start();
    current().autoReply = null;
    const open = client.request({ type: "diagnostics.hang", mode: "busy" });
    current().autoReply = healthyEngine;
    const restarted = client.restart();
    await expect(open.reply).rejects.toThrow(/restarted/);
    await restarted;
    expect(transports).toHaveLength(2);
    expect(transports[1]!.sent[0]).toMatchObject({ type: "hello", id: 1 });
  });

  it("stop() sends shutdown, waits for bye, kills the engine and makes no exit report", async () => {
    const { client, current, exits } = setup();
    await client.start();
    await client.stop();
    expect(current().sent.at(-1)).toMatchObject({ type: "shutdown" });
    expect(current().killed).toBe(true);
    expect(client.state).toBe("idle");
    current().die({ kind: "exit", message: "exit 0", code: 0 });
    expect(exits).toEqual([]);
  });

  it("stop() kills an engine that does not say goodbye", async () => {
    const { client, current } = setup();
    await client.start();
    current().autoReply = null;
    await client.stop(20);
    expect(current().killed).toBe(true);
  });
});

describe("EngineClient hang watchdog", () => {
  it("stops a WebAssembly engine that does not answer within the default limit and reports a hang", async () => {
    const { client, current, clock, exits } = setup("wasm");
    await client.start();
    current().autoReply = null;
    current().diagnostics = "[stderr] diagnostics.hang frozen requested";
    const stuck = client.request({ type: "diagnostics.hang", mode: "frozen" });
    const outcome = stuck.reply.catch((e: unknown) => e);
    clock.advance(59_999);
    expect(exits).toEqual([]);
    clock.advance(1);
    const e = (await outcome) as EngineCrashedError;
    expect(e).toBeInstanceOf(EngineCrashedError);
    expect(e.info.kind).toBe("hang");
    expect(e.info.message).toBe(
      "The engine did not answer diagnostics.hang (request 2) within 60 s (waited 60.0 s) and was stopped. The engine worker was terminated.",
    );
    expect(e.info.diagnostics).toContain("frozen requested");
    expect(current().killed).toBe(true);
    expect(exits).toHaveLength(1);
    expect(client.state).toBe("down");
  });

  it("does not limit compute commands on the native engine by default (the main process pings it)", async () => {
    const { client, current, clock, exits } = setup("native");
    await client.start();
    current().autoReply = null;
    client.request({ type: "diagnostics.hang", mode: "busy" }).reply.catch(() => {});
    clock.advance(10 * 60_000);
    expect(exits).toEqual([]);
  });

  it("applies a per-request limit on the native engine too", async () => {
    const { client, current, clock, exits } = setup("native");
    await client.start();
    current().autoReply = null;
    const r = client.request({ type: "diagnostics.hang", mode: "busy" }, { timeoutMs: 2000 });
    const outcome = r.reply.catch((e: unknown) => e);
    clock.advance(2000);
    expect(((await outcome) as EngineCrashedError).info.kind).toBe("hang");
    expect(exits).toHaveLength(1);
  });

  it("does not count the time a WebAssembly command waits behind a long one", async () => {
    const { client, current, clock, exits } = setup("wasm");
    await client.start();
    current().autoReply = null;
    const long = client.request({ type: "diagnostics.hang", mode: "busy", ms: 50_000 }, { timeoutMs: 100_000 });
    const quick = client.request({ type: "ping" });
    clock.advance(50_000);
    current().say({ type: "hangResult", replyTo: long.id, mode: "busy", ms: 50_000 });
    await long.reply;
    // The ping has waited 50 s, but its 5 s only start now.
    clock.advance(4999);
    expect(exits).toEqual([]);
    current().say({ type: "pong", replyTo: quick.id, busyWith: null, queued: 0 });
    await quick.reply;
    clock.advance(60_000);
    expect(exits).toEqual([]);
  });

  it("lets an interim message keep a long command alive", async () => {
    const { client, current, clock, exits } = setup("wasm");
    await client.start();
    current().autoReply = null;
    const r = client.request({ type: "diagnostics.hang", mode: "busy" }, { timeoutMs: 1000 });
    for (let i = 0; i < 5; i++) {
      clock.advance(900);
      current().say({ type: "progress", replyTo: r.id });
    }
    expect(exits).toEqual([]);
    clock.advance(1000);
    expect(exits).toHaveLength(1);
    await r.reply.catch(() => {});
  });

  it("answers ping on the native engine even while it computes (direct lane, 5 s limit)", async () => {
    const { client, current, clock, exits } = setup("native");
    await client.start();
    current().autoReply = null;
    client.request({ type: "diagnostics.hang", mode: "frozen" }).reply.catch(() => {});
    const ping = client.request({ type: "ping" });
    const outcome = ping.reply.catch((e: unknown) => e);
    clock.advance(5000);
    expect(((await outcome) as EngineCrashedError).info.kind).toBe("hang");
    expect(exits).toHaveLength(1);
  });
});

describe("EngineClient hello details", () => {
  it("keeps the hello result readable after the handshake", async () => {
    const { client } = setup("wasm");
    const hello = await client.start();
    expect(hello).toMatchObject({ protocol: 1, engine: { platform: "wasm" } });
    expect(helloResult(1, "wasm")).toMatchObject({ type: "helloResult" });
  });
});
