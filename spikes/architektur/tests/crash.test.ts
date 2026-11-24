// Crash recovery: the native process dies or the WebAssembly module traps; the client notices, restarts the
// engine and replays the recipe, and the result equals the one before the crash.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineCrashedError } from "../client/engine-client.ts";
import type { RebuildResult } from "../protocol/protocol.ts";
import { checkMesh, kinds, loadRecipe, missingBuild, startClient } from "./helpers.ts";

const p1a = loadRecipe("p1a");

// Windows exit codes of the native engine per crash mode (abort() exits with 3 once its dialog is disabled).
const nativeExit: Record<string, number> = { abort: 3, nullcall: 0xc0000005, intdiv: 0xc0000094 };
// How each mode surfaces from the WebAssembly module.
const wasmMessage: Record<string, RegExp> = {
  // Release builds (no ASSERTIONS): abort() ends in an "unreachable" trap with abort in the stack.
  abort: /RuntimeError: (Aborted\(|unreachable)/,
  nullcall: /RuntimeError: (null function or function signature mismatch|function signature mismatch)/,
  intdiv: /RuntimeError: divide by zero/,
};

for (const kind of kinds) {
  describe(`${kind} engine crash recovery`, { skip: missingBuild(kind) }, () => {
    for (const mode of ["abort", "nullcall", "intdiv"] as const) {
      it(`debugCrash ${mode}: crash is reported in full, restart replays the recipe`, async (t) => {
        const tc = await startClient(kind);
        const before = await tc.client.loadRecipe(p1a).reply;
        const b0 = (before.message as RebuildResult).bodies[0]!;
        const vBefore = tc.client.latestVersion;

        const crash = tc.client.request({ type: "debugCrash", mode }).reply;
        await assert.rejects(crash, (e: unknown) => e instanceof EngineCrashedError);
        assert.equal(tc.crashes.length, 1);
        const info = tc.crashes[0]!;
        if (kind === "native") {
          assert.equal(info.kind, "exit");
          assert.equal((info.code ?? 0) >>> 0, nativeExit[mode]);
          assert.match(info.diagnostics ?? "", new RegExp(`debugCrash "${mode}" requested`));
        } else {
          assert.equal(info.kind, "fatal");
          assert.match(info.message, wasmMessage[mode]!);
          assert.match(info.diagnostics ?? "", new RegExp(`debugCrash "${mode}" requested`));
        }
        t.diagnostic(`${kind} ${mode}: ${info.message.split("\n")[0]}`);

        const t0 = performance.now();
        const replay = await tc.client.restart();
        const restartMs = performance.now() - t0;
        assert.ok(replay);
        const r = replay.message as RebuildResult;
        assert.equal(r.type, "result");
        assert.equal(r.outcome, "ok");
        assert.ok(r.recipeVersion > vBefore, "replay uses a new recipe version");
        const b1 = r.bodies[0]!;
        assert.equal(b1.faceCount, b0.faceCount);
        assert.equal(b1.volume, b0.volume);
        assert.equal(checkMesh(replay.payload!, b1).triangles, checkMesh(before.payload!, b0).triangles);
        t.diagnostic(`restart + hello + replay of P1a: ${restartMs.toFixed(1)} ms`);
        await tc.client.stop();
        assert.deepEqual(tc.schemaErrors, []);
      });
    }
  });
}
