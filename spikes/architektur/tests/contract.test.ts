// Contract tests: the same messages against the native engine and the WebAssembly engine.
// Run: npm test (both engines must be built, see README).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Reply } from "../client/engine-client.ts";
import { NativeTransport } from "../client/native-transport.ts";
import type { EngineError, ProgressEvent, RebuildResult, Recipe } from "../protocol/protocol.ts";
import {
  checkMesh, delay, engineExe, kinds, loadRecipe, missingBuild, p1aVolume, startClient, transportFor, validateRecipe,
  type Kind, type TestClient,
} from "./helpers.ts";

const p1a = loadRecipe("p1a");
const spring = loadRecipe("spring");
const spin: Recipe = {
  format: "halfcube.recipe",
  formatVersion: 0,
  parameters: { ms: 5000 },
  steps: [{ id: "spin", type: "debug.spin", ms: "ms" }],
};

function result(r: Reply): RebuildResult {
  if (r.message.type !== "result") assert.fail(`expected a result, got ${JSON.stringify(r.message)}`);
  return r.message;
}
function error(r: Reply): EngineError {
  if (r.message.type !== "error") assert.fail(`expected an error, got ${JSON.stringify(r.message).slice(0, 400)}`);
  return r.message;
}

/** Sends one raw header on a fresh transport and returns the first reply (for handshake tests). */
async function rawExchange(kind: Kind, header: string, debug = true): Promise<unknown> {
  const t = transportFor(kind, { debug });
  const got = new Promise<unknown>((resolve) => { t.onMessage = (h) => resolve(JSON.parse(h)); });
  await t.start();
  t.send(header);
  const m = await got;
  t.kill();
  return m;
}

describe("recipes", () => {
  it("example recipes match the recipe schema", () => {
    for (const r of [p1a, spring, spin]) assert.ok(validateRecipe(r), JSON.stringify(validateRecipe.errors));
  });
});

for (const kind of kinds) {
  describe(`${kind} engine`, { skip: missingBuild(kind) }, () => {
    let tc: TestClient;
    before(async () => { tc = await startClient(kind); });
    after(async () => {
      await tc.client.stop();
      assert.deepEqual(tc.schemaErrors, [], "every message matches protocol.schema.json");
    });

    it("handshake reports protocol 0 and the platform's capabilities", () => {
      const h = tc.client.hello!;
      assert.equal(h.protocol, 0);
      assert.equal(h.engine.kernel, "OCCT 8.0.2");
      assert.equal(h.engine.platform, kind === "native" ? "windows-x64" : "wasm32");
      assert.equal(h.capabilities.debugCommands, true);
      assert.equal(h.capabilities.pingWhileBusy, kind === "native");
      assert.equal(h.capabilities.cancelWhileBusy, true);
      assert.equal(h.limits.payloadAlignment, 16);
    });

    it("refuses commands before hello, a wrong protocol and broken messages", async () => {
      const early = (await rawExchange(kind, JSON.stringify({ type: "ping", id: 1 }))) as EngineError;
      assert.equal(early.code, "not_initialized");
      assert.equal(early.replyTo, 1);
      const wrong = (await rawExchange(kind, JSON.stringify({ type: "hello", id: 1, protocol: 99, client: "x" }))) as EngineError;
      assert.equal(wrong.code, "protocol_mismatch");
      assert.match(wrong.message, /protocol version 0, the client asked for 99/);
      const broken = (await rawExchange(kind, "{\"type\": \"hello\", ")) as EngineError;
      assert.equal(broken.code, "bad_message");
      assert.equal(broken.replyTo, null);
      assert.match(broken.message, /not valid JSON: JSON parse error at byte \d+/);
    });

    it("debug commands are refused unless enabled", async () => {
      const t = await startClient(kind, { debug: false });
      const e = error(await t.client.request({ type: "debugPayload", bytes: 4 }).reply);
      assert.equal(e.code, "debug_disabled");
      const r = error(await t.client.loadRecipe(spin).reply);
      assert.equal(r.code, "bad_recipe");
      assert.match(r.message, /debug\.spin.*needs debug commands enabled/);
      await t.client.stop();
    });

    it("answers ping and unknown commands", async () => {
      const p = await tc.client.request({ type: "ping" }).reply;
      assert.equal(p.message.type, "pong");
      tc.unchecked(() => tc.client.sendRaw(JSON.stringify({ type: "frobnicate", id: 9999 })));
      await delay(100);
      // id 9999 is not pending in the client, so the reply arrives as unsolicited
      const u = tc.unsolicited.find((m) => m.replyTo === 9999) as EngineError | undefined;
      assert.equal(u?.code, "unknown_command");
    });

    it("setParameter without a recipe fails with no_recipe", async () => {
      const t = await startClient(kind);
      const e = error(await t.client.setParameter("x", 1).reply);
      assert.equal(e.code, "no_recipe");
      await t.client.stop();
    });

    it("rejects malformed recipes with the JSON path of the problem", async () => {
      const bad = structuredClone(p1a) as unknown as { steps: Record<string, unknown>[] };
      bad.steps[2]!.radius = "filletRadiu";
      const e = error(await tc.unchecked(() => tc.client.loadRecipe(bad as unknown as Recipe)).reply);
      assert.equal(e.code, "bad_recipe");
      assert.equal(e.message, 'The recipe cannot be used: recipe.steps[2].radius: unknown parameter "filletRadiu"');
      const bad2 = structuredClone(p1a) as unknown as { steps: Record<string, unknown>[] };
      delete bad2.steps[0]!.size;
      const e2 = error(await tc.unchecked(() => tc.client.loadRecipe(bad2 as unknown as Recipe)).reply);
      assert.equal(e2.message, "The recipe cannot be used: recipe.steps[0].size: missing");
    });

    it("builds P1a: valid, hand-calculated volume, watertight mesh with face ids", async () => {
      const progress: ProgressEvent[] = [];
      const r = await tc.client.loadRecipe(p1a, (p) => progress.push(p)).reply;
      const res = result(r);
      assert.equal(res.outcome, "ok");
      assert.deepEqual(res.steps.map((s) => [s.stepId, s.status, s.check?.valid]), [
        ["block", "ok", true], ["hole", "ok", true], ["fillet", "ok", true],
      ]);
      assert.deepEqual(progress.map((p) => p.stage + ":" + p.stepId), ["step:block", "step:hole", "step:fillet", "mesh:null"]);
      assert.ok(progress.every((p) => p.recipeVersion === res.recipeVersion));
      const b = res.bodies[0]!;
      assert.equal(res.bodies.length, 1);
      assert.equal(b.faceCount, 8);
      assert.equal(b.edgeCount, 17);
      const expected = p1aVolume(80, 50, 20, 20, 3);
      assert.ok(Math.abs(b.volume - expected) / expected < 1e-6, `volume ${b.volume} vs hand calculation ${expected}`);
      assert.deepEqual(b.bbox, { min: [0, 0, 0], max: [80, 50, 20] });
      const origins = new Map(b.faces.map((f) => [f.surface, f.originStep]));
      assert.equal(origins.get("torus"), "fillet");
      assert.equal(origins.get("cylinder"), "hole");
      assert.ok(b.faces.filter((f) => f.surface === "plane").every((f) => f.originStep === "block"));
      const m = checkMesh(r.payload!, b);
      assert.equal(m.triangles, 1402); // same count as the kernel test (E2)
      assert.ok(m.indicesInRange && m.faceIdsMatchRanges && m.normalsUnit);
      assert.equal(m.openEdges, 0, "mesh is watertight");
      assert.ok(Math.abs(m.meshVolume - b.volume) / b.volume < 0.005, `mesh volume ${m.meshVolume}`);
      assert.ok(m.edgeSegments > 0);
      assert.equal(r.payload!.byteLength, res.payloadBytes);
    });

    it("setParameter rebuilds only the affected steps", async () => {
      const r1 = result(await tc.client.setParameter("filletRadius", 4).reply);
      assert.deepEqual(r1.steps.map((s) => s.cached), [true, true, false]);
      const r2 = result(await tc.client.setParameter("holeDiameter", 24).reply);
      assert.deepEqual(r2.steps.map((s) => s.cached), [true, false, false]);
      const v = p1aVolume(80, 50, 20, 24, 4);
      assert.ok(Math.abs(r2.bodies[0]!.volume - v) / v < 1e-6);
      // The cache keeps one result per step, so going back to d=20 recomputes the hole.
      const r3 = result(await tc.client.setParameter("holeDiameter", 20).reply);
      assert.deepEqual(r3.steps.map((s) => s.cached), [true, false, false]);
    });

    it("a failing fillet reports the full error and keeps the body before it", async () => {
      const r = result(await tc.client.setParameter("filletRadius", 25).reply);
      assert.equal(r.outcome, "error");
      const f = r.steps[2]!;
      assert.equal(f.status, "error");
      assert.equal(
        f.message,
        'Fillet "fillet" with radius 25 mm on the top edge of hole "hole" could not be built (OCCT: IsDone() == false, ' +
          "faulty contours 1, stripe status StartsolFailure). The radius is probably too large for the neighbouring faces.",
      );
      assert.equal(r.bodies[0]!.lastStepId, "hole");
      assert.equal(r.bodies[0]!.faceCount, 7);
      const ok = result(await tc.client.setParameter("filletRadius", 3).reply);
      assert.equal(ok.outcome, "ok");
    });

    it("a hole beside the body is a warning, and the dependent fillet an error", async () => {
      const r = result(await tc.client.setParameter("holeX", 200).reply);
      assert.equal(r.outcome, "error");
      assert.deepEqual(r.steps.map((s) => s.status), ["ok", "warning", "error"]);
      assert.match(r.steps[1]!.message, /does not touch body "body1"; nothing was removed/);
      assert.match(r.steps[2]!.message, /top edge of hole "hole" was not found/);
      result(await tc.client.setParameter("holeX", 40).reply);
    });

    it("rejects stale versions and unknown parameters", async () => {
      const stale = error(await tc.client.request({ type: "setParameter", recipeVersion: 0, name: "holeX", value: 1 }).reply);
      assert.equal(stale.code, "stale_version");
      const unknown = error(await tc.client.setParameter("nope", 1).reply);
      assert.equal(unknown.code, "unknown_parameter");
      assert.match(unknown.message, /Known parameters: filletRadius, height, holeDiameter, holeX, holeY, length, width\./);
    });

    it("marks replies for older recipe versions as stale", async () => {
      const a = tc.client.setParameter("filletRadius", 2);
      const b = tc.client.setParameter("filletRadius", 3);
      const [ra, rb] = await Promise.all([a.reply, b.reply]);
      assert.equal(rb.stale, false);
      assert.equal(result(rb).recipeVersion, tc.client.latestVersion);
      // The older one is either superseded (engine skipped it) or a result the UI must drop.
      if (ra.message.type === "error") assert.equal(ra.message.code, "superseded");
      else assert.equal(ra.stale, true);
    });

    it("moves a 4 MiB payload intact", async () => {
      const r = await tc.client.request({ type: "debugPayload", bytes: 4 * 1024 * 1024 }).reply;
      assert.equal(r.message.type, "debugPayloadResult");
      const bytes = new Uint8Array(r.payload!);
      let h = 2166136261;
      for (const x of bytes) h = Math.imul(h ^ x, 16777619) >>> 0;
      assert.equal(h, (r.message as { fnv1a: number }).fnv1a);
      assert.equal(bytes[12345], (12345 * 31) & 255);
    });

    it("builds the P4b spring with about 42k triangles", async () => {
      const r = await tc.client.loadRecipe(spring).reply;
      const res = result(r);
      assert.equal(res.outcome, "ok");
      const b = res.bodies[0]!;
      const expected = Math.PI * 4 * 5 * Math.hypot(2 * Math.PI * 15, 10); // wire area * helix length
      assert.ok(Math.abs(b.volume - expected) / expected < 1e-3, `volume ${b.volume} vs ${expected}`);
      const m = checkMesh(r.payload!, b);
      assert.ok(m.triangles > 40000 && m.triangles < 45000, `triangles ${m.triangles}`);
      assert.equal(m.openEdges, 0);
    });

    it("cancels a running rebuild", async () => {
      await tc.client.loadRecipe({ ...spin, parameters: { ms: 0 } }).reply;
      const h = tc.client.setParameter("ms", 5000);
      await delay(300);
      const t0 = performance.now();
      const c = tc.client.cancel(h.id);
      const r = error(await h.reply);
      const elapsed = performance.now() - t0;
      assert.equal(r.code, "cancelled");
      assert.match(r.message, /was cancelled after \d+ ms; the recipe change itself is kept/);
      assert.ok(elapsed < 1000, `cancel took ${elapsed} ms`);
      const cr = await c.reply;
      assert.equal(cr.message.type, "cancelResult");
      // Native reads the cancel while computing; WebAssembly reads it after the command ended (shared flag did the work).
      assert.equal((cr.message as { state: string }).state, kind === "native" ? "running" : "notRunning");
      const after = result(await tc.client.setParameter("ms", 0).reply);
      assert.equal(after.outcome, "ok");
    });
  });
}

describe("native engine only", { skip: missingBuild("native") }, () => {
  it("answers ping while busy and cancels a queued command", async () => {
    const tc = await startClient("native");
    await tc.client.loadRecipe({ ...spin, parameters: { ms: 0 } }).reply;
    const busy = tc.client.setParameter("ms", 3000);
    await delay(200);
    const pong = await tc.client.request({ type: "ping" }).reply;
    assert.equal((pong.message as { busyWith: number }).busyWith, busy.id);
    const queued = tc.client.request({ type: "debugPayload", bytes: 16 });
    await delay(50);
    const c = await tc.client.cancel(queued.id).reply;
    assert.equal((c.message as { state: string }).state, "queued");
    await tc.client.cancel(busy.id).reply;
    assert.equal(error(await busy.reply).code, "cancelled");
    assert.equal(error(await queued.reply).code, "cancelled");
    await tc.client.stop();
    assert.deepEqual(tc.schemaErrors, []);
  });

  it("a newer recipe version supersedes the running rebuild", async () => {
    const tc = await startClient("native");
    await tc.client.loadRecipe({ ...spin, parameters: { ms: 0 } }).reply;
    const slow = tc.client.setParameter("ms", 3000);
    await delay(200);
    const fast = tc.client.setParameter("ms", 1);
    const e = error(await slow.reply);
    assert.equal(e.code, "superseded");
    assert.match(e.message, /was stopped because version 2 arrived while it was running/);
    assert.equal(result(await fast.reply).outcome, "ok");
    await tc.client.stop();
  });

  it("exits with code 0 after shutdown and on end of input", async () => {
    for (const how of ["shutdown", "eof"] as const) {
      const t = new NativeTransport({ exe: engineExe });
      const exited = new Promise<number | null | undefined>((r) => { t.onExit = (i) => r(i.code); });
      await t.start();
      t.send(JSON.stringify({ type: "hello", id: 1, protocol: 0, client: "t" }));
      if (how === "shutdown") t.send(JSON.stringify({ type: "shutdown", id: 2 }));
      else t.closeInput();
      assert.equal(await exited, 0, how);
    }
  });
});

describe("native and WebAssembly answer the same", { skip: missingBuild("native") || missingBuild("wasm") }, () => {
  // Drops what legitimately differs between platforms: timings and the per-step milliseconds.
  function normalise(r: Reply) {
    const m = structuredClone(r.message) as unknown as Record<string, unknown>;
    delete m.timings;
    for (const s of (m.steps as { ms?: number }[] | undefined) ?? []) delete s.ms;
    return m;
  }
  function closeEnough(a: unknown, b: unknown, path: string, diffs: string[]) {
    if (typeof a === "number" && typeof b === "number") {
      if (a !== b && Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))) diffs.push(`${path}: ${a} != ${b}`);
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) { diffs.push(`${path}: length ${a.length} != ${b.length}`); return; }
      a.forEach((x, i) => closeEnough(x, b[i], `${path}[${i}]`, diffs));
      return;
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) closeEnough((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, diffs);
      return;
    }
    if (a !== b) diffs.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  }

  async function scenario(kind: Kind) {
    const tc = await startClient(kind);
    const c = tc.client;
    const out: Reply[] = [];
    out.push(await c.loadRecipe(p1a).reply);
    out.push(await c.setParameter("holeDiameter", 24).reply);
    out.push(await c.setParameter("filletRadius", 25).reply);
    out.push(await c.setParameter("filletRadius", 3).reply);
    out.push(await c.setParameter("holeX", 200).reply);
    out.push(await c.request({ type: "setParameter", recipeVersion: 1, name: "holeX", value: 40 }).reply);
    out.push(await c.setParameter("nope", 1).reply);
    out.push(await c.loadRecipe(spring).reply);
    await c.stop();
    assert.deepEqual(tc.schemaErrors, []);
    return out;
  }

  it("for the same command sequence", async (t) => {
    const nat = await scenario("native");
    const wasm = await scenario("wasm");
    assert.equal(nat.length, wasm.length);
    const report: string[] = [];
    for (let i = 0; i < nat.length; ++i) {
      const diffs: string[] = [];
      closeEnough(normalise(nat[i]!), normalise(wasm[i]!), `reply[${i}]`, diffs);
      const pa = nat[i]!.payload, pb = wasm[i]!.payload;
      const sha = (p: ArrayBuffer | null) => (p ? createHash("sha256").update(new Uint8Array(p)).digest("hex").slice(0, 16) : "none");
      report.push(`reply[${i}] ${nat[i]!.message.type}: payload native ${sha(pa)} wasm ${sha(pb)}, ${diffs.length} differences`);
      // The spring's tessellation is allowed to differ slightly (the kernel test saw 42088 triangles on Windows
      // and 42096 in WebAssembly): mesh counts, buffer offsets, per-face triangle ranges and the payload size.
      // Geometry (volume, area, faces, edges, bbox) and every status and message must match.
      const meshOnly = /^reply\[7\]\.(payloadBytes|bodies\[0\]\.(mesh\.|faces\[\d+\]\.triangle))/;
      const unexpected = diffs.filter((d) => !meshOnly.test(d));
      assert.deepEqual(unexpected, [], `reply ${i} differs`);
      if (diffs.length) report.push(...diffs.map((d) => "  tolerated " + d));
      if (nat[i]!.message.type === "result") {
        const tri = (r: Reply) => (r.message as RebuildResult).bodies.map((b) => b.mesh.triangleCount).join("/");
        report.push(`  triangles native ${tri(nat[i]!)} wasm ${tri(wasm[i]!)}`);
      }
    }
    t.diagnostic(report.join("\n"));
  });
});
