// Transport measurements, native (stdio frames) vs WebAssembly (worker postMessage with transferred buffers).
// Usage: node tests/bench.ts [--out results.json] [--runs 15]
// Times are wall-clock medians on the client side, measured from sending a command to having its reply.
import { writeFileSync } from "node:fs";
import os from "node:os";
import type { RebuildResult } from "../protocol/protocol.ts";
import { kinds, loadRecipe, missingBuild, startClient, type Kind } from "./helpers.ts";

const args = process.argv.slice(2);
const outPath = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
const runs = args.includes("--runs") ? Number(args[args.indexOf("--runs") + 1]) : 15;

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const round = (x: number) => Math.round(x * 1000) / 1000;

async function timed<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const t0 = performance.now();
  const r = await fn();
  return [performance.now() - t0, r];
}

async function bench(kind: Kind) {
  const out: Record<string, unknown> = {};

  // Cold start: spawn or create the worker, load the module, handshake.
  const starts: number[] = [];
  for (let i = 0; i < 5; ++i) {
    const [ms, tc] = await timed(() => startClient(kind));
    starts.push(ms);
    await tc.client.stop();
  }
  out.startAndHelloMs = { median: round(median(starts)), runs: starts.map(round) };

  const tc = await startClient(kind);
  const c = tc.client;

  // Raw payload transport: engine fills N bytes, client receives them as an ArrayBuffer.
  const payload: Record<string, unknown> = {};
  for (const bytes of [0, 1 << 20, 4 << 20, 16 << 20, 64 << 20]) {
    const rt: number[] = [];
    const fill: number[] = [];
    for (let i = 0; i <= runs; ++i) {
      const [ms, r] = await timed(() => c.request({ type: "debugPayload", bytes }).reply);
      if (i === 0) continue; // warm-up
      rt.push(ms);
      fill.push((r.message as { fillMs: number }).fillMs);
    }
    const net = median(rt) - median(fill);
    payload[`${bytes}`] = {
      roundTripMs: round(median(rt)),
      engineFillMs: round(median(fill)),
      transportMs: round(net),
      mibPerS: bytes ? round(bytes / (1 << 20) / (net / 1000)) : null,
    };
  }
  out.debugPayload = payload;

  // P4b spring: full build, then an unchanged rebuild (all steps and the mesh cached) to isolate moving the mesh.
  const spring = loadRecipe("spring");
  const [buildMs, built] = await timed(() => c.loadRecipe(spring).reply);
  const br = built.message as RebuildResult;
  const cached: number[] = [];
  const engineCached: number[] = [];
  for (let i = 0; i <= runs; ++i) {
    const [ms, r] = await timed(() => c.setParameter("radius", 15).reply);
    if (i === 0) continue;
    cached.push(ms);
    engineCached.push((r.message as RebuildResult).timings.totalMs);
  }
  out.spring = {
    triangles: br.bodies[0]!.mesh.triangleCount,
    payloadBytes: br.payloadBytes,
    firstBuild: { roundTripMs: round(buildMs), engine: br.timings },
    cachedRebuild: {
      roundTripMs: round(median(cached)),
      engineTotalMs: round(median(engineCached)),
      transportMs: round(median(cached) - median(engineCached)),
    },
  };

  // Interactive edit on P1a: fillet radius 3 <-> 4 (block and hole cached, fillet and mesh recomputed).
  await c.loadRecipe(loadRecipe("p1a")).reply;
  const edit: number[] = [];
  const engineEdit: number[] = [];
  for (let i = 0; i <= runs; ++i) {
    const [ms, r] = await timed(() => c.setParameter("filletRadius", i % 2 ? 4 : 3).reply);
    if (i === 0) continue;
    edit.push(ms);
    engineEdit.push((r.message as RebuildResult).timings.totalMs);
  }
  out.p1aFilletEdit = {
    roundTripMs: round(median(edit)),
    engineTotalMs: round(median(engineEdit)),
    overheadMs: round(median(edit) - median(engineEdit)),
  };
  await c.stop();
  return out;
}

const results: Record<string, unknown> = {
  date: new Date().toISOString(),
  node: process.version,
  cpu: os.cpus()[0]?.model,
  runs,
};
for (const kind of kinds) {
  const skip = missingBuild(kind);
  results[kind] = skip ? { skipped: skip } : await bench(kind);
}
const text = JSON.stringify(results, null, 2);
if (outPath) writeFileSync(outPath, text + "\n");
console.log(text);
process.exit(0);
