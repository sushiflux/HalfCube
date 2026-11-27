// The contract every engine build must keep, run against the native engine process. Needs a build with test commands
// (diagnostics.crash / diagnostics.hang).
import { afterAll, beforeAll, expect, it } from "vitest";
import { EngineCrashedError, isCancelled } from "../../../../app/src/engine/errors.ts";
import { DOCUMENT_FORMAT, PROTOCOL_ID, PROTOCOL_VERSION, type ErrorMessage, type HelloResult } from "../../../../app/src/engine/generated/protocol.ts";
import { describeUnless } from "./builds.ts";
import { delay, rawExchange, startEngine, type EngineLocation, type TestEngine } from "./harness.ts";

const SLOW = 30_000;

/** How each crash mode shows up. */
export interface CrashExpectation {
  kind: "exit" | "fatal";
  /** Regex the exit message must match. */
  message: Record<"abort" | "nullcall" | "intdiv", RegExp>;
  /** Native only: the Windows exit code of each mode. */
  code?: Record<"abort" | "nullcall" | "intdiv", number>;
}

export function defineContract(label: string, where: EngineLocation, crash: CrashExpectation, skip: string | false): void {
  describeUnless(skip, `${label} engine contract`, () => {
    let e: TestEngine;
    beforeAll(async () => {
      e = await startEngine(where);
    }, SLOW);
    afterAll(async () => {
      await e.client.stop();
      expect(e.schemaErrors, "every message and command matches the JSON Schema").toEqual([]);
    });

    it("handshake reports the protocol, the document format, the platform, the components and the capabilities", () => {
      const h = e.client.hello as HelloResult;
      expect(h.protocol).toBe(PROTOCOL_VERSION);
      expect(h.protocol).toBe(3);
      expect(h.protocolId).toBe(PROTOCOL_ID);
      expect(h.documentFormat).toBe(DOCUMENT_FORMAT);
      expect(h.engine.name).toBe("halfcube-engine");
      expect(h.engine.platform).toBe("native");
      expect(h.engine.testCommands).toBe(true);
      expect(h.components.occt).toBe("8.0.2");
      expect(h.components.planegcs.source).toMatch(/FreeCAD 1\.1\.4/);
      expect(h.capabilities.pingWhileBusy).toBe(true);
      expect(h.capabilities.cancelWhileBusy).toBe(true);
      expect(h.limits.payloadAlignment).toBe(16);
      expect(h.limits.maxRequestId).toBe(2147483647);
    });

    it("answers ping with pong", async () => {
      const r = await e.client.request({ type: "ping" }).reply;
      expect(r.message).toMatchObject({ type: "pong", busyWith: null, queued: 0 });
    });

    it("kernel self-test passes: valid shapes, volume and face count equal the closed form", async () => {
      const m = (await e.client.request({ type: "diagnostics.kernelSelftest" }).reply).message;
      expect(m.passed).toBe(true);
      expect(m.steps.map((s) => s.name)).toEqual(["box", "hole", "fillet"]);
      expect(m.steps.every((s) => s.valid)).toBe(true);
      expect(Math.abs(m.volume - m.expectedVolume) / m.expectedVolume).toBeLessThan(m.volumeTolerance);
      expect(m.faceCount).toBe(m.expectedFaceCount);
    });

    it("solver self-test passes: solved, no conflicts, residuals inside the tolerance", async () => {
      const m = (await e.client.request({ type: "diagnostics.solverSelftest" }).reply).message;
      expect(m.passed).toBe(true);
      expect(m.status).toBe("solved");
      expect(m.dof).toBe(m.expectedDof);
      expect(m.conflicting).toEqual([]);
      expect(m.maxResidual).toBeLessThan(m.residualTolerance);
    });

    it("answers cancel of an unknown id with notFound", async () => {
      const m = (await e.client.cancel(123456).reply).message;
      expect(m).toMatchObject({ type: "cancelResult", target: 123456, state: "notFound" });
    });

    it("refuses an unknown command and a wrongly typed field with the engine's own words", async () => {
      e.unchecked(() => e.client.sendRaw(JSON.stringify({ type: "bad.command", id: 900_001 })));
      await delay(150);
      const refused = e.unsolicited.find((m) => m.type === "error" && m.replyTo === 900_001) as ErrorMessage | undefined;
      // The id is not one the client is waiting for, so the answer lands in onUnsolicited.
      expect(refused?.code).toBe("unknown_command");
      expect(refused?.message).toMatch(/Unknown command "bad\.command"\. This engine knows: hello, ping, cancel/);

      e.unchecked(() => e.client.sendRaw(JSON.stringify({ type: "cancel", id: 900_002, target: "x" })));
      await delay(150);
      const wrong = e.unsolicited.find((m) => m.type === "error" && m.replyTo === 900_002) as ErrorMessage | undefined;
      expect(wrong?.code).toBe("bad_message");
      expect(wrong?.message).toMatch(/field "target" must be an integer/);
    });

    it("refuses commands before hello, a wrong protocol version and unreadable messages", async () => {
      const early = (await rawExchange(where, JSON.stringify({ type: "ping", id: 1 }))) as ErrorMessage;
      expect(early).toMatchObject({ code: "not_initialized", replyTo: 1 });
      const wrong = (await rawExchange(where, JSON.stringify({ type: "hello", id: 1, protocol: 99, protocolId: PROTOCOL_ID, client: "x" }))) as ErrorMessage;
      expect(wrong.code).toBe("protocol_mismatch");
      expect(wrong.message).toMatch(new RegExp(`protocol version ${PROTOCOL_VERSION}, the client "x" asked for version 99`));
      const old = (await rawExchange(where, JSON.stringify({ type: "hello", id: 1, protocol: 1, client: "old ui" }))) as ErrorMessage;
      expect(old.code).toBe("protocol_mismatch");
      const other = (await rawExchange(where, JSON.stringify({ type: "hello", id: 1, protocol: PROTOCOL_VERSION, protocolId: "0123456789abcdef", client: "other ui" }))) as ErrorMessage;
      expect(other.code).toBe("protocol_mismatch");
      expect(other.message).toContain(`protocol "${PROTOCOL_ID}" (version ${PROTOCOL_VERSION})`);
      expect(other.message).toContain(`named protocol "0123456789abcdef" (version ${PROTOCOL_VERSION})`);
      const noId = (await rawExchange(where, JSON.stringify({ type: "hello", id: 1, protocol: PROTOCOL_VERSION, client: "no id" }))) as ErrorMessage;
      expect(noId.code).toBe("protocol_mismatch");
      expect(noId.message).toContain("nothing (no protocolId in hello)");
      const broken = (await rawExchange(where, '{"type": "hello", ')) as ErrorMessage;
      expect(broken).toMatchObject({ code: "bad_message", replyTo: null });
      expect(broken.message).toMatch(/not valid JSON/);
    });

    it("runs diagnostics.hang busy for the asked time", async () => {
      const m = (await e.client.request({ type: "diagnostics.hang", mode: "busy", ms: 150 }).reply).message;
      expect(m.mode).toBe("busy");
      expect(m.ms).toBeGreaterThanOrEqual(150);
      expect(m.ms).toBeLessThan(2000);
    });

    it("cancels a command that is running right now", async () => {
      const work = e.client.request({ type: "diagnostics.hang", mode: "busy" });
      const outcome = work.reply.catch((x: unknown) => x);
      await delay(150);
      await e.client.cancel(work.id).reply.catch(() => null);
      const err = await outcome;
      expect(isCancelled(err)).toBe(true);
      expect((err as Error).message).toMatch(/diagnostics\.hang "busy" was cancelled after \d+ ms/);
      // The engine is usable afterwards.
      expect((await e.client.request({ type: "ping" }).reply).message.type).toBe("pong");
    });

    it.each(["abort", "nullcall", "intdiv"] as const)(
      "recovers by restart after the crash mode %s, and describes the crash completely",
      async (mode) => {
        const own = await startEngine(where);
        const doomed = own.client.request({ type: "diagnostics.crash", mode });
        const err = await doomed.reply.catch((x: unknown) => x);
        expect(err).toBeInstanceOf(EngineCrashedError);
        const info = (err as EngineCrashedError).info;
        expect(info.kind).toBe(crash.kind);
        expect(info.message).toMatch(crash.message[mode]);
        // Only the native engine has an exit code to compare.
        expect(crash.code ? (info.code ?? 0) >>> 0 : undefined).toBe(crash.code ? crash.code[mode] >>> 0 : undefined);
        expect(info.diagnostics ?? "").toContain(`diagnostics.crash "${mode}" requested by command ${doomed.id}`);
        expect(own.exits).toEqual([info]);
        expect(own.client.state).toBe("down");

        // Restart gives a working engine again.
        await own.client.restart();
        const kernel = (await own.client.request({ type: "diagnostics.kernelSelftest" }).reply).message;
        expect(kernel.passed).toBe(true);
        await own.client.stop();
        expect(own.schemaErrors).toEqual([]);
      },
      SLOW,
    );

    it("stops an engine that freezes (hang watchdog) and a restart brings a working one", async () => {
      const own = await startEngine(where);
      const frozen = own.client.request({ type: "diagnostics.hang", mode: "frozen" }, { timeoutMs: 400 });
      const t0 = performance.now();
      const err = await frozen.reply.catch((x: unknown) => x);
      const waited = performance.now() - t0;
      expect(err).toBeInstanceOf(EngineCrashedError);
      const info = (err as EngineCrashedError).info;
      expect(info.kind).toBe("hang");
      expect(info.message).toMatch(/did not answer diagnostics\.hang \(request \d+\) within 0\.4 s/);
      expect(waited).toBeGreaterThanOrEqual(390);
      expect(waited).toBeLessThan(5000);
      expect(own.exits).toHaveLength(1);
      await own.client.restart();
      expect((await own.client.request({ type: "diagnostics.solverSelftest" }).reply).message.passed).toBe(true);
      await own.client.stop();
    }, SLOW);
  });
}
