// Automated UI run of the spike, started by tests/ui-drive.ts over the DevTools protocol (Electron window and
// browser page alike): load time, picking, parameter rebuilds, stale replies, step errors, crash recovery and a
// larger mesh. Everything goes through the same store, session and viewport the buttons use.
import spring from "../../recipes/spring.json";
import type { Recipe, RebuildResult } from "../../protocol/protocol.ts";
import type { EngineSession, RecipeTiming } from "./engine-session.ts";
import type { NoticeStore } from "./notices.ts";
import type { RecipeStore } from "./recipe-store.ts";
import { spikeHooks } from "./spike-hooks.ts";
import type { RendererMode, Viewport } from "./viewport.ts";

interface Ctx {
  store: RecipeStore;
  session: EngineSession;
  notices: NoticeStore;
  rendererMode: RendererMode;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, fn: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() - t0 > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${what}`);
    await sleep(5);
  }
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length === 0 ? NaN : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const r3 = (x: number | undefined) => (x === undefined || Number.isNaN(x) ? null : Math.round(x * 1000) / 1000);

function summary(t: RecipeTiming[]) {
  const pick = (k: keyof RecipeTiming) => r3(median(t.map((x) => x[k] as number).filter((x) => typeof x === "number")));
  return {
    runs: t.length,
    roundTripMs: pick("roundTripMs"),
    toFrameMs: pick("toFrameMs"),
    engineTotalMs: pick("engineTotalMs"),
    engineRebuildMs: pick("engineRebuildMs"),
    engineMeshMs: pick("engineMeshMs"),
    engineEncodeMs: pick("engineEncodeMs"),
    transportMs: pick("transportMs"),
    hopMs: pick("hopMs"),
    payloadBytes: t[0]?.payloadBytes ?? null,
  };
}

function geometry(r: RebuildResult | null) {
  if (!r) return null;
  return r.bodies.map((b) => ({
    bodyId: b.bodyId, volume: b.volume, faceCount: b.faceCount, edgeCount: b.edgeCount,
    triangles: b.mesh.triangleCount, edgeSegments: b.mesh.edgeSegmentCount,
  }));
}

export function installAutotest(ctx: Ctx) {
  const { store, session, notices } = ctx;
  let phase = "idle";
  let outcome: { done: boolean; report?: unknown; error?: string } = { done: false };

  /** Waits for the next current result after `count` timings and for its frame. */
  async function nextFrame(count: number, what: string, timeoutMs = 30_000): Promise<RecipeTiming> {
    return waitFor(what, () => {
      const t = session.timings[session.timings.length - 1];
      return session.timings.length > count && t && t.toFrameMs !== undefined && session.snapshot().status !== "restarting" ? t : null;
    }, timeoutMs);
  }

  async function changeAndWait(name: string, value: number): Promise<RecipeTiming> {
    const n = session.timings.length;
    store.setParameter(name, value);
    return nextFrame(n, `rebuild after ${name}=${value}`);
  }

  function pickTest(vp: Viewport) {
    const r = session.snapshot().result!;
    const out: { faceId: number; surface: string; originStep: string; result: "ok" | "occluded" | "offscreen" | "wrong"; got?: number }[] = [];
    const raycastMs: number[] = [];
    for (const body of r.bodies) {
      for (const f of body.faces) {
        const p = vp.faceSamplePoint(body.bodyId, f.faceId)!;
        const c = vp.toClient(p);
        const rect = document.querySelector("canvas")!.getBoundingClientRect();
        if (c.x < rect.left || c.x > rect.right || c.y < rect.top || c.y > rect.bottom) {
          out.push({ faceId: f.faceId, surface: f.surface, originStep: f.originStep, result: "offscreen" });
          continue;
        }
        const hit = vp.pickAt(c.x, c.y);
        if (hit) raycastMs.push(hit.raycastMs);
        if (hit && hit.face.faceId === f.faceId) {
          out.push({ faceId: f.faceId, surface: f.surface, originStep: f.originStep, result: "ok" });
        } else {
          // Another face in front of the sample point is fine; a hit behind it or none is a failure.
          const occluded = hit !== null && vp.cameraDistance(hit.point) < vp.cameraDistance(p) - 0.01;
          out.push({ faceId: f.faceId, surface: f.surface, originStep: f.originStep, result: occluded ? "occluded" : "wrong", got: hit?.face.faceId });
        }
      }
    }
    return { faces: out, raycastMsMedian: r3(median(raycastMs)) };
  }

  async function crashTest(mode: "abort" | "nullcall" | "intdiv") {
    const before = geometry(session.snapshot().result);
    const crashes = session.snapshot().crashes;
    const n = session.timings.length;
    const noticeCount = notices.list.length;
    const t0 = performance.now();
    session.crash(mode);
    await waitFor(`crash ${mode} reported`, () => session.snapshot().crashes > crashes, 10_000);
    const detectedMs = performance.now() - t0;
    const t = await nextFrame(n, `body visible again after crash ${mode}`);
    const visibleMs = performance.now() - t0;
    const after = geometry(session.snapshot().result);
    const crashNotice = notices.list.slice(noticeCount).find((x) => x.level === "error");
    return {
      mode,
      detectedMs: r3(detectedMs),
      bodyVisibleAgainMs: r3(visibleMs),
      recoveryMsFromSession: r3(session.snapshot().lastRecoveryMs ?? NaN),
      replayRoundTripMs: r3(t.roundTripMs),
      sameGeometry: JSON.stringify(before) === JSON.stringify(after),
      noticeTitle: crashNotice?.title ?? null,
      noticeText: crashNotice?.text ?? null,
    };
  }

  async function run(opts: { setParamRuns?: number } = {}) {
    const runs = opts.setParamRuns ?? 15;
    const vp = await waitFor("viewport", () => spikeHooks.viewport, 30_000);
    await waitFor("first body on screen", () => vp.firstBodyFrameAt !== null, 30_000);
    const snap0 = session.snapshot();
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const report: Record<string, unknown> = {
      userAgent: navigator.userAgent,
      desktop: window.partcraftDesktop?.versions ?? null,
      crossOriginIsolated: window.crossOriginIsolated,
      engine: snap0.hello?.engine ?? null,
      capabilities: snap0.hello?.capabilities ?? null,
      sharedCancel: snap0.sharedCancel,
      viewport: {
        ...vp.info,
        canvas: { w: document.querySelector("canvas")!.width, h: document.querySelector("canvas")!.height },
        devicePixelRatio,
      },
      load: {
        firstBodyFrameMs: r3(vp.firstBodyFrameAt!),
        domContentLoadedMs: r3(nav?.domContentLoadedEventEnd),
        engineStartAndHelloMs: r3(snap0.startMs ?? NaN),
        wasmInstantiateMs: r3(snap0.instantiateMs ?? NaN),
        viewportInitMs: r3(vp.info.initMs),
        firstRecipe: session.timings[0] ?? null,
      },
      geometryP1a: geometry(snap0.result),
      stepsP1a: snap0.steps.map((s) => ({ stepId: s.stepId, status: s.status, cached: s.cached })),
    };

    phase = "picking";
    report.picking = pickTest(vp);

    phase = "setParameter";
    // Parameter rebuilds through the store (the slider path), alternating so each run really rebuilds.
    const timingsHole: RecipeTiming[] = [];
    for (let i = 0; i < runs; ++i) timingsHole.push(await changeAndWait("holeDiameter", i % 2 ? 20 : 24));
    report.setParameterHoleDiameter = summary(timingsHole);
    const timingsFillet: RecipeTiming[] = [];
    for (let i = 0; i < runs; ++i) timingsFillet.push(await changeAndWait("filletRadius", i % 2 ? 3 : 4));
    report.setParameterFilletRadius = summary(timingsFillet);
    report.cacheAfterFilletChange = session.snapshot().steps.map((s) => ({ stepId: s.stepId, cached: s.cached }));

    phase = "undo";
    // Undo goes back through the store; the engine gets a setParameter for the changed value.
    const vBefore = store.current.parameters.filletRadius;
    const nU = session.timings.length;
    store.undo();
    const tu = await nextFrame(nU, "rebuild after undo");
    report.undo = { from: vBefore, to: store.current.parameters.filletRadius, command: tu.command, roundTripMs: r3(tu.roundTripMs) };

    phase = "stale burst";
    // Five changes without waiting: only the newest may be shown.
    const burst = await session.burst("holeDiameter", [21, 22, 23, 24, 20]);
    await sleep(50);
    report.staleBurst = {
      sent: 5,
      staleDiscarded: burst.stale,
      shown: burst.shown,
      supersededIgnored: session.snapshot().supersededIgnored,
      displayedVersion: session.snapshot().displayedVersion,
      latestVersion: session.client.latestVersion,
      displayedIsLatest: session.snapshot().displayedVersion === session.client.latestVersion,
    };

    phase = "step error";
    // Step error: the fillet cannot be built; the body stays at the state after the hole.
    const tErr = await changeAndWait("filletRadius", 25);
    const errSnap = session.snapshot();
    report.stepError = {
      outcome: errSnap.result?.outcome,
      steps: errSnap.steps.map((s) => ({ stepId: s.stepId, status: s.status, message: s.message })),
      faceCount: errSnap.result?.bodies[0]?.faceCount,
      roundTripMs: r3(tErr.roundTripMs),
    };
    await changeAndWait("filletRadius", 3);

    // Crash recovery, all three modes.
    const crashResults = [];
    for (const mode of ["abort", "nullcall", "intdiv"] as const) {
      phase = `crash ${mode}`;
      crashResults.push(await crashTest(mode));
    }
    report.crashes = crashResults;

    phase = "watchdog";
    // Desktop only: a hung engine is found by the main process's watchdog.
    if (session.kind === "native" && window.partcraftDesktop) {
      const crashes = session.snapshot().crashes;
      const n = session.timings.length;
      const t0 = performance.now();
      const noticeCount = notices.list.length;
      session.simulateHang();
      await waitFor("watchdog report", () => session.snapshot().crashes > crashes, 15_000);
      const detectedMs = performance.now() - t0;
      await nextFrame(n, "body visible after watchdog restart");
      report.watchdog = {
        detectedMs: r3(detectedMs),
        bodyVisibleAgainMs: r3(performance.now() - t0),
        noticeText: notices.list.slice(noticeCount).find((x) => x.level === "error")?.text ?? null,
      };
    }

    phase = "spring";
    // A larger mesh: the spring (about 42 000 triangles), then back with undo.
    const nS = session.timings.length;
    store.replace(spring as Recipe, "spring");
    const ts = await nextFrame(nS, "spring on screen", 60_000);
    const springMeshOnly: RecipeTiming[] = [];
    for (let i = 0; i < 5; ++i) springMeshOnly.push(await changeAndWait("radius", i % 2 ? 15 : 15.5));
    const rect = document.querySelector("canvas")!.getBoundingClientRect();
    const rays: number[] = [];
    for (let i = 0; i < 25; ++i) {
      const h = vp.pickAt(rect.left + rect.width * (0.3 + 0.4 * ((i * 7) % 25) / 25), rect.top + rect.height * (0.3 + 0.4 * ((i * 11) % 25) / 25));
      if (h) rays.push(h.raycastMs);
    }
    report.spring = {
      firstBuild: ts,
      radiusChange: summary(springMeshOnly),
      geometry: geometry(session.snapshot().result),
      raycastHits: rays.length,
      raycastMsMedian: r3(median(rays)),
    };
    while (store.canUndo && "turns" in store.current.parameters) {
      const n = session.timings.length;
      store.undo();
      await nextFrame(n, "undo");
    }
    report.backToP1a = geometry(session.snapshot().result);

    const s = session.snapshot();
    report.final = {
      crashes: s.crashes,
      staleDiscarded: s.staleDiscarded,
      supersededIgnored: s.supersededIgnored,
      notices: notices.list.map((n) => ({ level: n.level, title: n.title, chars: n.text.length })),
      pageNavigations: performance.getEntriesByType("navigation").length,
      uiSurvived: true,
    };
    return report;
  }

  (window as unknown as { __partcraftSpike: unknown }).__partcraftSpike = {
    run,
    /** Starts run() in the background; poll status(). */
    start(setParamRuns: number) {
      outcome = { done: false };
      run({ setParamRuns }).then(
        (report) => (outcome = { done: true, report }),
        (e: unknown) => (outcome = { done: true, error: e instanceof Error ? `${e.message}
${e.stack ?? ""}` : String(e) }),
      );
      return true;
    },
    status() {
      const s = session.snapshot();
      return { phase, ...outcome, sessionStatus: s.status, crashes: s.crashes, timings: session.timings.length, displayedVersion: s.displayedVersion };
    },
    /** Coordinates of the middle of a face for real input events from the driver. */
    faceClientPoint(faceId: number) {
      const vp = spikeHooks.viewport;
      const r = session.snapshot().result;
      const b = r?.bodies[0];
      if (!vp || !b) return null;
      const p = vp.faceSamplePoint(b.bodyId, faceId);
      return p ? vp.toClient(p) : null;
    },
    /** Sends several parameter commands back to back (bypassing the UI's coalescing); see EngineSession.burst. */
    burst(name: string, values: number[]) {
      return session.burst(name, values);
    },
    faces() {
      return session.snapshot().result?.bodies[0]?.faces ?? [];
    },
    selection() {
      return spikeHooks.viewport?.selection ?? null;
    },
    ready() {
      return !!spikeHooks.viewport && spikeHooks.viewport.firstBodyFrameAt !== null;
    },
  };
}
