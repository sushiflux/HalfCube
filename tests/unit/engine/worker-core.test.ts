// The logic of the engine worker against a fake WebAssembly module: loading, queuing, memory handling, traps. The real
// module runs through the same code in wasm.test.ts.
import { describe, expect, it } from "vitest";
import {
  createEngineWorkerCore,
  type EngineModule,
  type ModuleLoader,
  type ModuleOverrides,
} from "../../../app/src/engine/worker/engine-worker-core.ts";
import type { FromWorker } from "../../../app/src/engine/worker/worker-protocol.ts";
import { PROTOCOL_VERSION } from "../../../app/src/engine/generated/protocol.ts";

interface FakeModule extends EngineModule {
  calls: string[];
  handled: { header: string; payload: number[] }[];
  overrides: ModuleOverrides;
  heap: Uint8Array;
}

function fakeModule(overrides: ModuleOverrides, behaviour: { version?: number; trap?: Error; mallocFails?: boolean } = {}): FakeModule {
  const heap = new Uint8Array(4096);
  let top = 16;
  const m: FakeModule = {
    calls: [],
    handled: [],
    overrides,
    heap,
    HEAPU8: heap,
    _hc_init(flags) {
      m.calls.push(`init(${flags})`);
      return behaviour.version ?? PROTOCOL_VERSION;
    },
    _malloc(n) {
      m.calls.push(`malloc(${n})`);
      if (behaviour.mallocFails) return 0;
      const p = top;
      top += n;
      return p;
    },
    _free(p) {
      m.calls.push(`free(${p})`);
    },
    _hc_handle(hp, hb, pp, pb) {
      if (behaviour.trap) throw behaviour.trap;
      const header = new TextDecoder().decode(heap.subarray(hp, hp + hb));
      m.handled.push({ header, payload: Array.from(heap.subarray(pp, pp + pb)) });
      // The engine answers synchronously, like the real module.
      overrides.onEngineMessage(JSON.stringify({ type: "pong", replyTo: 1, busyWith: null, queued: 0 }), pp ? new Uint8Array([9, 9]).buffer : null);
      overrides.print("hello from the module");
    },
  };
  return m;
}

function setup(behaviour: Parameters<typeof fakeModule>[1] = {}, loadFails?: Error) {
  const posted: { message: FromWorker; transfer: Transferable[] | undefined }[] = [];
  let module!: FakeModule;
  const load: ModuleLoader = async (_url, overrides) => {
    if (loadFails) throw loadFails;
    module = fakeModule(overrides, behaviour);
    return module;
  };
  const core = createEngineWorkerCore({ post: (message, transfer) => posted.push({ message, transfer }) }, load, () => 0);
  const kinds = () => posted.map((p) => p.message.kind);
  return { core, posted, kinds, module: () => module };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("engine worker core", () => {
  it("loads the module, initialises the engine (with cancel flags) and announces ready", async () => {
    const { core, kinds, module } = setup();
    const flags = new Int32Array(new SharedArrayBuffer(4));
    core.handle({ kind: "init", moduleUrl: "file:///x/halfcube-engine.mjs", cancelFlags: flags });
    await tick();
    expect(kinds()).toEqual(["ready"]);
    expect(module().calls).toEqual(["init(1)"]);
  });

  it("initialises without cancel flags when none are given", async () => {
    const { core, module } = setup();
    core.handle({ kind: "init", moduleUrl: "u", cancelFlags: null });
    await tick();
    expect(module().calls).toEqual(["init(0)"]);
  });

  it("writes the header into the module's memory, calls _hc_handle, frees the buffers and forwards replies with transfer", async () => {
    const { core, posted, module } = setup();
    core.handle({ kind: "init", moduleUrl: "u", cancelFlags: null });
    await tick();
    core.handle({ kind: "msg", header: '{"type":"ping","id":1}', payload: new Uint8Array([1, 2, 3]).buffer });
    expect(module().handled).toEqual([{ header: '{"type":"ping","id":1}', payload: [1, 2, 3] }]);
    expect(module().calls.filter((c) => c.startsWith("free"))).toHaveLength(2);
    const reply = posted.find((p) => p.message.kind === "msg")!;
    expect(reply.transfer).toHaveLength(1);
    expect(posted.some((p) => p.message.kind === "log" && p.message.text === "hello from the module")).toBe(true);
  });

  it("holds messages that arrive while the module loads and runs them after ready", async () => {
    const { core, kinds, module } = setup();
    core.handle({ kind: "init", moduleUrl: "u", cancelFlags: null });
    core.handle({ kind: "msg", header: '{"type":"ping","id":1}', payload: null });
    expect(kinds()).toEqual([]);
    await tick();
    expect(kinds().slice(0, 2)).toEqual(["ready", "msg"]);
    expect(module().handled).toHaveLength(1);
  });

  it("reports a module that cannot be loaded, with the URL and the cause", async () => {
    const { core, posted } = setup({}, new Error("Failed to fetch"));
    core.handle({ kind: "init", moduleUrl: "https://example.test/engine/halfcube-engine.mjs", cancelFlags: null });
    await tick();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.message).toEqual({
      kind: "fatal",
      message: expect.stringMatching(/^The WebAssembly engine could not be loaded from https:\/\/example\.test\/engine\/halfcube-engine\.mjs: Error: Failed to fetch/),
    });
  });

  it("refuses a module of another protocol version", async () => {
    const { core, posted } = setup({ version: PROTOCOL_VERSION + 1 });
    core.handle({ kind: "init", moduleUrl: "u", cancelFlags: null });
    await tick();
    expect(posted[0]!.message).toEqual({
      kind: "fatal",
      message: expect.stringMatching(new RegExp(`speaks protocol version ${PROTOCOL_VERSION + 1}, this program expects ${PROTOCOL_VERSION}`)),
    });
  });

  it("turns a trap into one fatal message and refuses everything afterwards", async () => {
    const { core, posted } = setup({ trap: Object.assign(new Error("divide by zero"), { name: "RuntimeError" }) });
    core.handle({ kind: "init", moduleUrl: "u", cancelFlags: null });
    await tick();
    core.handle({ kind: "msg", header: '{"type":"diagnostics.crash","id":2,"mode":"intdiv"}', payload: null });
    core.handle({ kind: "msg", header: '{"type":"ping","id":3}', payload: null });
    const fatals = posted.map((p) => p.message).filter((m) => m.kind === "fatal");
    expect(fatals).toHaveLength(2);
    expect(fatals[0]!.kind === "fatal" && fatals[0]!.message).toMatch(/^The WebAssembly engine crashed: RuntimeError: divide by zero/);
    expect(fatals[1]!.kind === "fatal" && fatals[1]!.message).toMatch(/stopped after an earlier fatal error/);
  });

  it("reports memory exhaustion instead of writing through a null pointer", async () => {
    const { core, posted } = setup({ mallocFails: true });
    core.handle({ kind: "init", moduleUrl: "u", cancelFlags: null });
    await tick();
    core.handle({ kind: "msg", header: '{"type":"ping","id":1}', payload: null });
    const fatal = posted.map((p) => p.message).find((m) => m.kind === "fatal");
    expect(fatal?.kind === "fatal" && fatal.message).toMatch(/Out of memory: \d+ bytes for a message header/);
  });
});
