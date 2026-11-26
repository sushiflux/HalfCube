// End-to-end suite of the architecture spike (Playwright + node:test). It checks the spike's goals from outside:
//   G1  the Electron window shows the body computed by the native engine process
//   G2  the browser page shows the body computed by the WebAssembly engine in a Web Worker
//   G3  both engines answer the same message interface (contract tests, schema, equal geometry)
//   G4  a real click on a face selects it and names its face id (both targets)
//   G5  a parameter change rebuilds the body; stale answers are not shown
//   G6  desktop: engine killed (button, taskkill, real hang): UI survives, shows the full copyable error, engine restarts, recipe replayed
//   G7  browser: WebAssembly trap kills the worker: it is recreated and the recipe replayed
//   G8  everything above also works when WebGPU is off (forced WebGL2, hidden WebGPU, no GPU)
//   Icons  the Electron window and the browser page carry the project's logo (not Electron's default icon)
//
// Run: npm run build:ui, then npm run test:e2e   (see tests/e2e/harness.ts for environment variables)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { after, describe, it, type TestContext } from "node:test";
import type { Page } from "playwright-core";
import { startClient, loadRecipe, type Kind } from "../helpers.ts";
import { meshViews } from "../../protocol/mesh.ts";
import type { BodyResult, RebuildResult } from "../../protocol/protocol.ts";
import {
  iconDistance, windowIconPng,
  canvasBox, canvasContextKind, canvasShot, clickCanvas, dismissNotices, lf, currentPick, dd, engineProcesses, enginesOf, evidence, imageDiff, imageStats, killPid, launchDesktop, launchWeb,
  notices, numberInput, pidAlive, pixelAt, root, setParam, sleep, stepRows, stopPreview, suspendPid, triangles, waitForBody,
  type Launched, type LaunchOptions, type PickText,
} from "./harness.ts";

type Target = "desktop" | "web";
const launchers = { desktop: launchDesktop, web: launchWeb };
const P1A_TRIANGLES = 1402;
const SPRING_TRIANGLES_NATIVE = 42088;

async function withApp<T>(target: Target, opts: LaunchOptions, fn: (l: Launched) => Promise<T>): Promise<T> {
  const l = await launchers[target](opts);
  try {
    await waitForBody(l.page);
    return await fn(l);
  } finally {
    await l.close();
  }
}

const shot = async (l: Launched, name: string) => evidence(`${l.kind}-${name}.png`, await l.page.screenshot());

/** Polls until fn returns a truthy value; throws with `what` after the timeout. No fixed sleeps. */
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms: ${what}`);
    await sleep(25);
  }
}

const version = async (page: Page) => Number((await dd(page, "Angezeigte Version").innerText()).trim());
const crashCount = async (page: Page) => Number((await dd(page, "Abstürze").innerText()).trim().split(/\s/)[0]);
const engineStatus = (page: Page) => page.getByTestId("engine-status").innerText();

async function waitReady(page: Page) {
  await until("engine ready", async () => /ready$/.test(await engineStatus(page)));
}

/** Waits for the displayed version to change from `v0` and the session to be idle again. */
async function waitRebuilt(page: Page, v0: number): Promise<number> {
  const v = await until(`displayed version above ${v0}`, async () => (await version(page)) > v0 && (await version(page)));
  await waitReady(page);
  return v;
}

/** Expected faces of P1a from the native engine, read straight from the protocol (independent of the UI). */
async function expectedFaces(): Promise<Map<number, BodyResult["faces"][number]>> {
  const tc = await startClient("native");
  try {
    const r = await tc.client.loadRecipe(loadRecipe("p1a")).reply;
    assert.equal(r.message.type, "result");
    const body = (r.message as RebuildResult).bodies[0]!;
    return new Map(body.faces.map((f) => [f.faceId, f]));
  } finally {
    await tc.client.stop();
  }
}

// ======================================================================= G3

/** One key per triangle: face id and the three corners (rounded to 1e-3 mm) from the smallest corner on, so the key does not depend on vertex numbering. */
function triangleKeys(v: ReturnType<typeof meshViews>): string[] {
  const corner = (i: number) => `${Math.round(v.positions[3 * i]! * 1e3)},${Math.round(v.positions[3 * i + 1]! * 1e3)},${Math.round(v.positions[3 * i + 2]! * 1e3)}`;
  const out: string[] = [];
  for (let t = 0; t < v.indices.length / 3; ++t) {
    const c = [corner(v.indices[3 * t]!), corner(v.indices[3 * t + 1]!), corner(v.indices[3 * t + 2]!)];
    const m = c.indexOf([...c].sort()[0]!);
    out.push(`${v.faceIds[t]}:${c[m]!}|${c[(m + 1) % 3]!}|${c[(m + 2) % 3]!}`);
  }
  return out;
}

describe("G3: one message interface for both engines", () => {
  it("contract and crash tests pass against native and WebAssembly (no skips)", (t: TestContext) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // the nested run must be a normal run
    const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "tests/contract.test.ts", "tests/crash.test.ts"], {
      cwd: root, encoding: "utf8", env,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    evidence("g3-contract-run.txt", out);
    const num = (name: string) => Number(new RegExp(`ℹ ${name} (\\d+)`).exec(out)?.[1] ?? NaN);
    t.diagnostic(`tests ${num("tests")} pass ${num("pass")} fail ${num("fail")} skipped ${num("skipped")}`);
    assert.equal(r.status, 0, out.slice(-3000));
    assert.equal(num("fail"), 0);
    assert.equal(num("skipped"), 0, "a skipped suite means an engine was not built");
    assert.equal(num("pass"), num("tests"));
    assert.ok(num("tests") >= 41);
  });

  it("both engines return equal geometry and the same triangles (corners within 1e-3 mm, same faces) for the same commands", async (t: TestContext) => {
    const nat = await startClient("native");
    const wasm = await startClient("wasm");
    try {
      const lines: string[] = [];
      const steps: { name: string; value: number }[] = [{ name: "holeDiameter", value: 24 }, { name: "filletRadius", value: 5 }, { name: "length", value: 90 }];
      const rn = [await nat.client.loadRecipe(loadRecipe("p1a")).reply];
      const rw = [await wasm.client.loadRecipe(loadRecipe("p1a")).reply];
      for (const s of steps) {
        rn.push(await nat.client.setParameter(s.name, s.value).reply);
        rw.push(await wasm.client.setParameter(s.name, s.value).reply);
      }
      rn.forEach((a, i) => {
        const b = rw[i]!;
        assert.equal(a.message.type, "result");
        assert.equal(b.message.type, "result");
        const ma = (a.message as RebuildResult).bodies[0]!, mb = (b.message as RebuildResult).bodies[0]!;
        assert.equal(ma.faceCount, mb.faceCount);
        assert.equal(ma.edgeCount, mb.edgeCount);
        assert.ok(Math.abs(ma.volume - mb.volume) <= 1e-6 * ma.volume, `volume ${ma.volume} vs ${mb.volume}`);
        assert.equal(ma.mesh.triangleCount, mb.mesh.triangleCount);
        const va = meshViews(a.payload!, ma), vb = meshViews(b.payload!, mb);
        assert.deepEqual(Array.from(va.faceIds).sort(), Array.from(vb.faceIds).sort(), "triangles per face");
        const ka = triangleKeys(va), kb = triangleKeys(vb);
        let missing = 0;
        const setB = new Map<string, number>();
        for (const k of kb) setB.set(k, (setB.get(k) ?? 0) + 1);
        for (const k of ka) {
          const n = setB.get(k) ?? 0;
          if (n === 0) missing++;
          else setB.set(k, n - 1);
        }
        const orderDiffs = va.indices.reduce((n, v, k) => n + (v === vb.indices[k] ? 0 : 1), 0);
        lines.push(`step ${i}: ${ma.mesh.triangleCount} triangles, triangles without a partner at 1e-3 mm: ${missing}, index entries in a different order: ${orderDiffs}`);
        assert.equal(missing, 0, `every native triangle has an equal WebAssembly triangle (same face, same corners, same orientation)`);
      });
      t.diagnostic(lines.join("\n"));
      evidence("g3-mesh-compare.txt", lines.join("\n"));
    } finally {
      await nat.client.stop();
      await wasm.client.stop();
    }
  });

  it("the UI uses one client and one protocol definition for both transports", async () => {
    const session = readFileSync(new URL("../../app/src/engine-session.ts", import.meta.url), "utf8");
    assert.equal((session.match(/new EngineClient\(/g) ?? []).length, 1, "exactly one EngineClient in the UI session");
    assert.match(session, /import .*from "\.\.\/\.\.\/protocol\/protocol\.ts"/);
    // Neither transport carries its own message types: both import them from the shared protocol.
    for (const f of ["client/native-transport.ts", "client/worker-transport.ts", "client/engine-client.ts"]) {
      const src = readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
      assert.doesNotMatch(src, /interface (HelloResult|RebuildResult|StepStatus)\b/, `${f} must not redefine protocol types`);
    }
  });

  it("both transports deliver a stale-marked reply for older versions in a burst (protocol level)", async (t: TestContext) => {
    for (const kind of ["native", "wasm"] as Kind[]) {
      const tc = await startClient(kind);
      try {
        await tc.client.loadRecipe(loadRecipe("p1a")).reply;
        const values = [21, 22, 23, 24, 25, 20];
        const handles = values.map((v) => tc.client.setParameter("holeDiameter", v));
        const arrivals: { idx: number; type: string; stale: boolean; version: number; code?: string }[] = [];
        await Promise.all(
          handles.map((h, idx) =>
            h.reply.then((r) => {
              const m = r.message;
              arrivals.push({ idx, type: m.type, stale: r.stale, version: m.recipeVersion, ...(m.type === "error" ? { code: m.code } : {}) });
            }),
          ),
        );
        const latest = tc.client.latestVersion;
        const current = arrivals.filter((a) => a.type === "result" && !a.stale);
        t.diagnostic(`${kind}: ${JSON.stringify(arrivals)}`);
        assert.equal(current.length, 1, `${kind}: exactly one current result`);
        assert.equal(current[0]!.version, latest);
        assert.equal(current[0]!.idx, values.length - 1);
        for (const a of arrivals.filter((x) => x.idx !== values.length - 1)) {
          assert.ok(a.stale || a.code === "superseded" || a.code === "cancelled", `${kind}: older reply ${JSON.stringify(a)} must be stale or superseded`);
          assert.ok(a.version < latest);
        }
      } finally {
        await tc.client.stop();
      }
    }
  });
});

// ======================================================================= G1, G2

describe("G1: Electron window shows the body from the native engine process", () => {
  it("shows P1a, from a child engine process of the window, in a hardened page", async (t: TestContext) => {
    const before = new Set(engineProcesses().map((p) => p.pid));
    const l = await launchDesktop();
    try {
      const tri = await waitForBody(l.page);
      await shot(l, "g1-p1a");
      assert.equal(tri, P1A_TRIANGLES);
      assert.match(await engineStatus(l.page), /nativ \(Prozess\) · ready/);
      assert.equal((await dd(l.page, "Kern").innerText()).trim(), "OCCT 8.0.2 · windows-x64");
      assert.equal(await canvasContextKind(l.page), "webgpu", "automatic mode draws with WebGPU on this machine");
      const rows = await stepRows(l.page);
      assert.deepEqual(rows.map((r) => [r.id, r.type, r.status]), [["block", "box", "ok"], ["hole", "hole", "ok"], ["fillet", "fillet", "ok"]]);

      // The OS shows exactly one new engine process, a child of the Electron main process.
      const mine = engineProcesses().filter((p) => !before.has(p.pid));
      assert.equal(mine.length, 1, `engine processes started by this window: ${JSON.stringify(mine)}`);
      assert.deepEqual(enginesOf(l.mainPid!).map((e) => e.pid), [mine[0]!.pid], "the engine descends from the launched Electron process");
      assert.match(mine[0]!.commandLine, /halfcube-engine\.exe/);
      t.diagnostic(`engine pid ${mine[0]!.pid}, parent ${mine[0]!.parentPid}: ${mine[0]!.commandLine}`);

      // Something is really drawn: body pixels, edge lines.
      const png = await canvasShot(l.page);
      const st = await imageStats(l.page, png);
      t.diagnostic(`canvas ${st.width}x${st.height}, foreground ${st.foreground}, edge pixels ${st.edgePixels}`);
      assert.ok(st.foreground > 0.08 * st.width * st.height, "the body covers a visible part of the canvas");
      assert.ok(st.edgePixels > 300, "B-rep edge lines are drawn");

      // Security baseline as seen from inside the page.
      const caps = await l.page.evaluate(() => ({
        require: typeof (globalThis as { require?: unknown }).require,
        process: typeof (globalThis as { process?: unknown }).process,
        module: typeof (globalThis as { module?: unknown }).module,
        bridge: Object.keys((window as unknown as { halfCubeDesktop?: object }).halfCubeDesktop ?? {}),
        origin: location.origin,
        isolated: crossOriginIsolated,
      }));
      t.diagnostic(JSON.stringify(caps));
      assert.deepEqual([caps.require, caps.process, caps.module], ["undefined", "undefined", "undefined"]);
      assert.deepEqual([...caps.bridge].sort(), ["kind", "startEngine", "versions"]);
      assert.equal(caps.origin, "app://halfcube");
      assert.deepEqual(l.pageErrors, []);
      assert.deepEqual(l.consoleErrors, []);
    } finally {
      const pid = l.mainPid;
      await l.close();
      // No engine is left behind when the window closes.
      await until("engine process gone after closing the window", () => enginesOf(pid!).length === 0, 8000);
    }
  });

  it("reloading the window starts a new engine and leaves no orphan", async () => {
    await withApp("desktop", {}, async (l) => {
      const old = enginesOf(l.mainPid!);
      assert.equal(old.length, 1);
      await l.page.reload();
      await waitForBody(l.page);
      const now = enginesOf(l.mainPid!);
      assert.equal(now.length, 1, "exactly one engine after reload");
      assert.notEqual(now[0]!.pid, old[0]!.pid);
      assert.ok(!pidAlive(old[0]!.pid), "the engine of the old page is gone");
    });
  });
});

describe("G2: browser page shows the body from the WebAssembly engine in a Web Worker", () => {
  after(() => stopPreview());
  it("shows P1a from a worker; no native engine process is involved", async (t: TestContext) => {
    const before = new Set(engineProcesses().map((p) => p.pid));
    await withApp("web", {}, async (l) => {
      assert.equal(await triangles(l.page), P1A_TRIANGLES);
      await shot(l, "g2-p1a");
      assert.match(await engineStatus(l.page), /WebAssembly \(Worker\) · ready/);
      assert.equal((await dd(l.page, "Kern").innerText()).trim(), "OCCT 8.0.2 · wasm32");
      assert.equal(await canvasContextKind(l.page), "webgpu", "automatic mode draws with WebGPU on this machine");
      const workers = l.page.workers().map((w) => w.url());
      t.diagnostic(`workers: ${workers.join(", ")}`);
      assert.ok(workers.some((u) => u.endsWith("/engine/engine-worker.mjs")), `an engine worker exists: ${workers}`);
      const rows = await stepRows(l.page);
      assert.deepEqual(rows.map((r) => [r.id, r.type, r.status]), [["block", "box", "ok"], ["hole", "hole", "ok"], ["fillet", "fillet", "ok"]]);
      const after = engineProcesses().filter((p) => !before.has(p.pid));
      assert.equal(after.length, 0, "the browser page started no native engine");
      const st = await imageStats(l.page, await canvasShot(l.page));
      t.diagnostic(`canvas ${st.width}x${st.height}, foreground ${st.foreground}, edge pixels ${st.edgePixels}`);
      assert.ok(st.foreground > 0.08 * st.width * st.height);
      assert.ok(st.edgePixels > 300);
      assert.equal(await l.page.evaluate(() => crossOriginIsolated), true);
      assert.deepEqual(l.pageErrors, []);
      assert.deepEqual(l.consoleErrors, []);
    });
  });
});

// ======================================================================= icons

describe("Icons: the project's logo is the window icon and the page favicon", () => {
  after(() => stopPreview());
  const asset = (name: string) => readFileSync(new URL(`../../assets/${name}`, import.meta.url));

  it("the browser page declares the logo as its icon, serves it, and asks for no /favicon.ico", async (t: TestContext) => {
    await withApp("web", {}, async (l) => {
      const page = l.page;
      const links = await page.locator("link[rel~=icon]").evaluateAll((els) => els.map((e) => ({ href: (e as HTMLLinkElement).href, type: e.getAttribute("type") })));
      t.diagnostic(JSON.stringify(links));
      assert.equal(links.length, 1);
      assert.equal(links[0]!.type, "image/png");
      const res = await page.request.get(links[0]!.href);
      assert.equal(res.status(), 200);
      assert.equal(res.headers()["content-type"], "image/png");
      const body = await res.body();
      assert.ok(body.equals(asset("halfcube-icon-64.png")), "the served icon is the shipped logo icon");
      // The icon is a resampled copy of the project's logo: the same drawing, only smaller.
      const big = asset("halfcube-icon-512.png");
      assert.ok((await iconDistance(page, body, big, 64)) < 6, "the 64 px icon shows the same picture as the 512 px one");
      assert.deepEqual(l.consoleErrors, [], "no 404 for the favicon or anything else");
      evidence("web-icon-favicon.png", body);
    });
  });

  it("the Electron window holds the logo as its icon (read back from the operating system)", async (t: TestContext) => {
    await withApp("desktop", {}, async (l) => {
      const hwnd = await l.app!.evaluate(({ BrowserWindow }) => String(BrowserWindow.getAllWindows()[0]!.getNativeWindowHandle().readBigUInt64LE(0)));
      const png = windowIconPng(hwnd);
      assert.ok(png, "the window has an icon of its own");
      evidence("desktop-icon-from-os.png", png);
      const st = await imageStats(l.page, png);
      t.diagnostic(`window icon ${st.width}x${st.height}`);
      const d = await iconDistance(l.page, png, asset("halfcube-icon-512.png"), Math.min(st.width, 64));
      t.diagnostic(`mean colour difference to the logo: ${d.toFixed(2)}`);
      assert.ok(d < 14, `the window icon shows the logo (difference ${d})`);
      // Control: the check can tell the logo from another picture (a plain blue square, like a generic default icon).
      const plain = Buffer.from(
        await l.page.evaluate(async () => {
          const c = new OffscreenCanvas(64, 64);
          const g = c.getContext("2d")!;
          g.fillStyle = "#2b7fc4";
          g.fillRect(0, 0, 64, 64);
          return Array.from(new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer()));
        }),
      );
      assert.ok((await iconDistance(l.page, png, plain, Math.min(st.width, 64))) > 30, "the control picture is clearly different");
    });
  });
});

// ======================================================================= G4, G5, G8 (shared bodies)

interface PickReport {
  clicks: number;
  hits: number;
  faces: number[];
  surfaces: string[];
}

/** Scans the body with real clicks and checks every overlay against the engine's own face list. */
async function checkPicking(l: Launched, expected: Map<number, BodyResult["faces"][number]>, cols: number, rows: number, label: string): Promise<PickReport> {
  const page = l.page;
  const png = await canvasShot(page);
  const st = await imageStats(page, png);
  const box = (await page.getByTestId("viewport").boundingBox())!;
  const sx = st.width / box.width;
  const b = st.box!;
  const fx0 = b.x0 / sx / box.width, fx1 = b.x1 / sx / box.width, fy0 = b.y0 / sx / box.height, fy1 = b.y1 / sx / box.height;
  // Scan the bounding box of the body.
  const hits: { fx: number; fy: number; pick: PickText }[] = [];
  let clicks = 0;
  for (let r = 0; r < rows; ++r) {
    for (let c = 0; c < cols; ++c) {
      const fx = fx0 + ((fx1 - fx0) * (c + 0.5)) / cols, fy = fy0 + ((fy1 - fy0) * (r + 0.5)) / rows;
      await clickCanvas(page, fx, fy);
      clicks++;
      await page.evaluate(() => new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res()))));
      const pick = await currentPick(page);
      if (pick) hits.push({ fx, fy, pick });
    }
  }
  for (const h of hits) {
    const e = expected.get(h.pick.faceId);
    assert.ok(e, `${label}: overlay names face ${h.pick.faceId}, which the engine does not have`);
    assert.equal(h.pick.surface, e.surface, `${label}: surface of face ${h.pick.faceId}`);
    assert.equal(h.pick.originStep, e.originStep, `${label}: origin step of face ${h.pick.faceId}`);
    assert.equal(h.pick.triangleCount, e.triangleCount, `${label}: triangle count of face ${h.pick.faceId}`);
  }
  const faces = [...new Set(hits.map((h) => h.pick.faceId))].sort((a, b2) => a - b2);
  const surfaces = [...new Set(hits.map((h) => h.pick.surface))].sort();
  // The click that was picked is where the highlight appears: for one hit per surface type, the pixel under the
  // click changes colour after the click, and a click outside the body clears the selection again.
  await clickCanvas(page, 0.02, 0.5);
  assert.equal(await currentPick(page), null, `${label}: a click on the background clears the selection`);
  const clear = await canvasShot(page);
  for (const surface of surfaces) {
    const h = hits.find((x) => x.pick.surface === surface)!;
    const pt = await clickCanvas(page, h.fx, h.fy);
    await until(`${label}: ${surface} face selected`, async () => (await currentPick(page))?.surface === surface);
    await page.evaluate(() => new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res()))));
    const selected = await canvasShot(page);
    const diff = await imageDiff(page, clear, selected);
    const atClick = await pixelAt(page, selected, (pt.x - box.x) * sx, (pt.y - box.y) * sx);
    const before = await pixelAt(page, clear, (pt.x - box.x) * sx, (pt.y - box.y) * sx);
    assert.ok(diff > 150, `${label}: highlighting the ${surface} face changes the picture (${diff} pixels)`);
    assert.ok(
      Math.abs(atClick[0] - before[0]) + Math.abs(atClick[1] - before[1]) + Math.abs(atClick[2] - before[2]) > 12,
      `${label}: the pixel under the click is highlighted (${before} -> ${atClick})`,
    );
    await clickCanvas(page, 0.02, 0.5);
  }
  return { clicks, hits: hits.length, faces, surfaces };
}

function pickSuite(target: Target) {
  it(`G4 (${target}): real clicks select faces and show their ids, consistent with the engine's face list`, async (t: TestContext) => {
    const expected = await expectedFaces();
    await withApp(target, {}, async (l) => {
      const rep = await checkPicking(l, expected, 28, 18, target);
      t.diagnostic(JSON.stringify(rep));
      evidence(`${target}-g4-pick.json`, JSON.stringify({ ...rep, expectedFaces: [...expected.values()] }, null, 2));
      assert.ok(rep.hits > 50, "most clicks inside the body's box hit it");
      assert.deepEqual(rep.surfaces, ["cylinder", "plane", "torus"]);
      assert.ok(rep.faces.length >= 5, `distinct faces hit: ${rep.faces}`);
      // The fillet is face 1 in the engine's list: the overlay says so with its origin step.
      const torus = [...expected.values()].find((f) => f.surface === "torus")!;
      assert.ok(rep.faces.includes(torus.faceId));
      await shot(l, "g4-last");
    });
  });

  it(`G4 (${target}): a drag rotates the view and does not change the selection`, async () => {
    await withApp(target, {}, async (l) => {
      const page = l.page;
      const box = (await page.getByTestId("viewport").boundingBox())!;
      const before = await canvasShot(page);
      await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45, { steps: 8 });
      await page.mouse.up();
      await page.evaluate(() => new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res()))));
      const after = await canvasShot(page);
      assert.ok((await imageDiff(page, before, after)) > 1000, "the view rotated");
      assert.equal(await currentPick(page), null, "a drag does not select a face");
    });
  });
}

function paramSuite(target: Target) {
  it(`G5 (${target}): a parameter change rebuilds only what depends on it and the picture changes`, async (t: TestContext) => {
    await withApp(target, {}, async (l) => {
      const page = l.page;
      const v0 = await version(page);
      const a = await canvasShot(page);
      await setParam(page, "Verrundung", 6);
      const v1 = await waitRebuilt(page, v0);
      let rows = await stepRows(page);
      t.diagnostic(`after fillet radius: ${JSON.stringify(rows)}`);
      assert.deepEqual(rows.map((r) => r.timing === "Cache"), [true, true, false], "block and hole come from the cache, the fillet is recomputed");
      const b = await canvasShot(page);
      assert.ok((await imageDiff(page, a, b)) > 100, "the body looks different with another fillet radius");
      const triFillet = await triangles(page);

      await setParam(page, "Bohrung", 26);
      const v2 = await waitRebuilt(page, v1);
      rows = await stepRows(page);
      assert.deepEqual(rows.map((r) => r.timing === "Cache"), [true, false, false], "only the block is cached after a hole change");
      const c = await canvasShot(page);
      assert.ok((await imageDiff(page, b, c)) > 100);
      await shot(l, "g5-hole26");

      await setParam(page, "Länge", 120);
      const v3 = await waitRebuilt(page, v2);
      assert.ok(v3 > v2 && v2 > v1 && v1 > v0, "every change raises the displayed version");

      // Undo goes back through the recipe store and rebuilds again.
      await page.getByRole("button", { name: "Rückgängig" }).click();
      await waitRebuilt(page, v3);
      assert.equal(await numberInput(page, "Länge").inputValue(), "80");
      assert.equal(await numberInput(page, "Bohrung").inputValue(), "26");
      t.diagnostic(`triangles after fillet change ${triFillet}`);
    });
  });

  it(`G5 (${target}): a failing step shows the full engine message, keeps the body, and the UI stays usable`, async () => {
    await withApp(target, {}, async (l) => {
      const page = l.page;
      const v0 = await version(page);
      await setParam(page, "Verrundung", 25);
      await waitRebuilt(page, v0);
      const rows = await stepRows(page);
      assert.deepEqual(rows.map((r) => r.status), ["ok", "ok", "error"]);
      const msg = await page.locator("li.step.error .step-msg pre").innerText();
      assert.match(msg, /could not be built/);
      assert.ok(msg.length > 80, "message is complete, not cut");
      const fully = await page.locator("li.step.error .step-msg pre").evaluate((el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1);
      assert.ok(fully, "message text is fully visible");
      assert.ok((await page.locator("li.step.error .step-msg button", { hasText: "Kopieren" }).count()) === 1, "message has a Copy button");
      const st = await imageStats(page, await canvasShot(page));
      assert.ok(st.foreground > 0.05 * st.width * st.height, "the body before the failing step is still shown");
      await setParam(page, "Verrundung", 3);
      await until("recovered from the step error", async () => (await stepRows(page)).every((r) => r.status === "ok"));
    });
  });

  it(`G5 (${target}): five commands sent back to back: older replies are discarded by the UI, only the newest is shown`, async (t: TestContext) => {
    await withApp(target, {}, async (l) => {
      const page = l.page;
      const staleBefore = Number((await dd(page, "Veraltet verworfen").innerText()).trim().split(/\s/)[0]);
      const v0 = await version(page);
      await page.evaluate(() => {
        const w = window as unknown as { __versions: number[] };
        w.__versions = [];
        const read = () => {
          const dt = [...document.querySelectorAll("dt")].find((d) => d.textContent === "Angezeigte Version");
          const v = Number(dt?.nextElementSibling?.textContent);
          if (Number.isFinite(v) && w.__versions[w.__versions.length - 1] !== v) w.__versions.push(v);
        };
        new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true });
      });
      const res = await page.evaluate(() =>
        (window as unknown as { __halfcubeSpike: { burst(n: string, v: number[]): Promise<{ stale: number; shown: number }> } }).__halfcubeSpike.burst("holeDiameter", [21, 22, 23, 24, 20]),
      );
      await waitReady(page);
      const seen = await page.evaluate(() => (window as unknown as { __versions: number[] }).__versions);
      const staleAfter = Number((await dd(page, "Veraltet verworfen").innerText()).trim().split(/\s/)[0]);
      t.diagnostic(`burst result ${JSON.stringify(res)}; displayed versions ${seen.join(",")}; counter ${staleBefore} -> ${staleAfter}`);
      assert.equal(res.stale, 4, "four of the five replies were discarded as stale");
      assert.equal(res.shown, 1, "one reply was shown");
      assert.equal(staleAfter - staleBefore, 4, "the on-screen counter shows the four discarded replies");
      assert.deepEqual(seen.filter((v) => v !== v0), [v0 + 5], "the display jumped straight to the newest version, no older one was shown in between");
      assert.equal(await numberInput(page, "Bohrung").inputValue(), "20");
      // The picture is the one for diameter 20: the same as reaching 20 in one calm step.
      const burstShot = await canvasShot(page);
      await setParam(page, "Bohrung", 30);
      await waitRebuilt(page, await version(page));
      await setParam(page, "Bohrung", 20);
      await waitRebuilt(page, await version(page));
      assert.equal(await imageDiff(page, burstShot, await canvasShot(page)), 0, "same picture as a calm change to the same value");
    });
  });

  it(`G5 (${target}): a burst of changes ends on the newest value and never shows an older version afterwards`, async (t: TestContext) => {
    await withApp(target, {}, async (l) => {
      const page = l.page;
      // Record every version the UI displays, in order.
      await page.evaluate(() => {
        const w = window as unknown as { __versions: number[] };
        w.__versions = [];
        const read = () => {
          const dt = [...document.querySelectorAll("dt")].find((d) => d.textContent === "Angezeigte Version");
          const v = Number(dt?.nextElementSibling?.textContent);
          if (Number.isFinite(v) && w.__versions[w.__versions.length - 1] !== v) w.__versions.push(v);
        };
        read();
        new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true });
      });
      const v0 = await version(page);
      const values = [21, 22, 23, 24, 25, 26, 27, 28, 29, 22];
      for (const v of values) await setParam(page, "Bohrung", v);
      await until("the burst has been fully processed", async () => /ready$/.test(await engineStatus(page)) && (await version(page)) > v0);
      // Wait for quiet: the version stays the same across two animation frames and the engine is ready.
      let last = -1;
      await until("quiet", async () => {
        const v = await version(page);
        const ready = /ready$/.test(await engineStatus(page));
        const stable = v === last && ready;
        last = v;
        return stable;
      });
      const seen = await page.evaluate(() => (window as unknown as { __versions: number[] }).__versions);
      t.diagnostic(`versions displayed: ${seen.join(",")}; stale discarded: ${(await dd(page, "Veraltet verworfen").innerText()).trim()}`);
      for (let i = 1; i < seen.length; ++i) assert.ok(seen[i]! > seen[i - 1]!, `version display went backwards: ${seen}`);
      assert.equal(await numberInput(page, "Bohrung").inputValue(), "22");
      const burstShot = await canvasShot(page);
      // Reference: the same final value reached in two calm steps.
      await setParam(page, "Bohrung", 30);
      await waitRebuilt(page, await version(page) - 1);
      await setParam(page, "Bohrung", 22);
      await waitRebuilt(page, last);
      const calmShot = await canvasShot(page);
      evidence(`${target}-g5-burst.png`, burstShot);
      assert.equal(await imageDiff(page, burstShot, calmShot), 0, "after the burst the picture is the one for the newest value");
    });
  });
}

// ======================================================================= run the shared suites

describe("G4: face picking, desktop", () => pickSuite("desktop"));
describe("G4: face picking, browser", () => {
  after(() => stopPreview());
  pickSuite("web");
});
describe("G5: parameter changes, desktop", () => paramSuite("desktop"));
describe("G5: parameter changes, browser", () => {
  after(() => stopPreview());
  paramSuite("web");
});

// ======================================================================= G6

/** Waits until a crash was reported and recovered; returns the crash notice. */
async function waitCrashRecovered(page: Page, crashesBefore: number) {
  await until("crash counted", async () => (await crashCount(page)) > crashesBefore, 20_000);
  await until("recovery notice and ready", async () => {
    const list = await notices(page);
    return list.some((n) => n.title === "Engine neu gestartet") && /ready$/.test(await engineStatus(page));
  }, 20_000);
  return (await notices(page)).filter((n) => n.level === "error");
}

/** A state that differs from the default, so a replay of the default recipe would be detected. */
async function makeNonDefault(page: Page) {
  const v0 = await version(page);
  await setParam(page, "Bohrung", 30);
  const v1 = await waitRebuilt(page, v0);
  await setParam(page, "Verrundung", 5);
  await waitRebuilt(page, v1);
  return { tri: await triangles(page), shot: await canvasShot(page), steps: await stepRows(page), box: await canvasBox(page) };
}

/**
 * After a crash a notice panel is open below the view and makes the view shorter. Records that, closes the notices and
 * compares the picture with the one before the crash: it must be pixel-identical (same camera, same body).
 */
async function expectSamePicture(page: Page, state: { shot: Buffer; box: { width: number; height: number } }, t: TestContext, label: string) {
  const withNotice = await canvasBox(page);
  await dismissNotices(page);
  await until("view back to its normal size", async () => {
    const b = await canvasBox(page);
    return b.width === state.box.width && b.height === state.box.height;
  });
  await page.evaluate(() => new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res()))));
  t.diagnostic(`${label}: view ${state.box.width}x${state.box.height} px, with notices open ${withNotice.width}x${withNotice.height} px`);
  assert.equal(await imageDiff(page, state.shot, await canvasShot(page)), 0, `${label}: picture after the replay is pixel-identical to the one before the crash`);
  return withNotice;
}

describe("G6: desktop engine crash and recovery", () => {
  it("kills the engine process from outside (taskkill): the UI survives, shows the full copyable error, the engine restarts, the recipe is replayed", async (t: TestContext) => {
    await withApp("desktop", {}, async (l) => {
      const page = l.page;
      const state = await makeNonDefault(page);
      await page.evaluate(() => ((window as unknown as { __qaMarker: number }).__qaMarker = 12345));
      const engines = enginesOf(l.mainPid!);
      assert.equal(engines.length, 1);
      const victim = engines[0]!;
      const k = killPid(victim.pid);
      t.diagnostic(`taskkill: ${k.output}`);
      assert.ok(k.ok, k.output);

      const errors = await waitCrashRecovered(page, 0);
      const n = errors.find((e) => e.title.startsWith("Die Engine ist abgestürzt"));
      assert.ok(n, `crash notice shown: ${JSON.stringify(errors.map((e) => e.title))}`);
      t.diagnostic(`notice: ${n.text}`);
      evidence("desktop-g6-taskkill-notice.txt", `${n.title}\n${n.text}`);
      assert.match(n.text, /exit code \d+/i, "the exit code is part of the message");
      assert.ok(n.fullyVisible, "the notice text is not clipped");
      assert.ok(n.hasCopy, "the notice has a Copy button");

      // Copy puts exactly title + text on the clipboard.
      await page.locator("[data-testid=notices] article", { hasText: n.title }).getByRole("button", { name: "Kopieren" }).click();
      const clip = await until("clipboard written", async () => {
        const c = await l.app!.evaluate(({ clipboard }) => clipboard.readText());
        return c || false;
      });
      assert.equal(lf(clip), `${n.title}\n${n.text}`);

      // The page itself never reloaded and the recipe was replayed on a new engine process.
      assert.equal(await page.evaluate(() => (window as unknown as { __qaMarker?: number }).__qaMarker), 12345, "page state survived");
      assert.equal(await page.evaluate(() => performance.getEntriesByType("navigation").length), 1);
      const now = enginesOf(l.mainPid!);
      assert.equal(now.length, 1, "one new engine process");
      assert.notEqual(now[0]!.pid, victim.pid);
      assert.ok(!pidAlive(victim.pid));
      assert.equal(await triangles(page), state.tri, "same triangle count as before the crash");
      assert.deepEqual((await stepRows(page)).map((r) => r.status), state.steps.map((r) => r.status));
      assert.equal(await numberInput(page, "Bohrung").inputValue(), "30");
      assert.equal(await numberInput(page, "Verrundung").inputValue(), "5");
      await shot(l, "g6-after-taskkill-with-notices");
      await expectSamePicture(page, state, t, "taskkill");

      // A second kill works the same way.
      const second = enginesOf(l.mainPid!)[0]!;
      assert.ok(killPid(second.pid).ok);
      await waitCrashRecovered(page, 1);
      assert.equal(await crashCount(page), 2);
      assert.equal(await triangles(page), state.tri);
      assert.deepEqual(l.pageErrors, []);
    });
  });

  it("kills the engine while it is rebuilding the spring: the spring is replayed", async () => {
    await withApp("desktop", {}, async (l) => {
      const page = l.page;
      const v0 = await version(page);
      await page.getByRole("button", { name: "Feder" }).click();
      const victim = enginesOf(l.mainPid!)[0]!;
      killPid(victim.pid); // immediately: the 400 ms rebuild is running or queued
      await until("a crash is reported", async () => (await crashCount(page)) >= 1, 20_000);
      await until("spring shown after recovery", async () => (await triangles(page)) === SPRING_TRIANGLES_NATIVE && /ready$/.test(await engineStatus(page)), 30_000);
      assert.ok((await version(page)) > v0);
      assert.ok(await page.getByRole("button", { name: "Block P1a" }).isEnabled(), "UI state (spring is the current recipe) survived");
    });
  });

  for (const mode of ["abort", "nullcall", "intdiv"] as const) {
    it(`crash button ${mode}: full message, restart, same picture`, async (t: TestContext) => {
      await withApp("desktop", {}, async (l) => {
        const page = l.page;
        const state = await makeNonDefault(page);
        await page.locator(`[data-crash=${mode}]`).click();
        const errors = await waitCrashRecovered(page, 0);
        const n = errors.find((e) => e.title.startsWith("Die Engine ist abgestürzt"))!;
        assert.ok(n);
        t.diagnostic(n.text.replace(/\n/g, " | "));
        evidence(`desktop-g6-${mode}-notice.txt`, `${n.title}\n${n.text}`);
        assert.match(n.text, /exit code (3|\d{10})/);
        assert.ok(n.fullyVisible && n.hasCopy);
        assert.equal(await triangles(page), state.tri);
        await expectSamePicture(page, state, t, mode);
      });
    });
  }

  it("a real hang (process suspended, not simulated) is found by the watchdog; the engine is stopped and replaced", async (t: TestContext) => {
    await withApp("desktop", {}, async (l) => {
      const page = l.page;
      const state = await makeNonDefault(page);
      const victim = enginesOf(l.mainPid!)[0]!;
      const t0 = Date.now();
      suspendPid(victim.pid);
      const errors = await waitCrashRecovered(page, 0);
      const ms = Date.now() - t0;
      const n = errors.find((e) => e.title.startsWith("Die Engine ist abgestürzt"))!;
      t.diagnostic(`recovered ${ms} ms after the freeze: ${n.text.replace(/\n/g, " | ")}`);
      evidence("desktop-g6-real-hang-notice.txt", `${n.title}\n${n.text}\nrecovered after ${ms} ms`);
      assert.match(n.text, /did not answer a liveness check/);
      assert.ok(n.fullyVisible && n.hasCopy);
      assert.ok(!pidAlive(victim.pid), "the frozen engine process was ended");
      assert.equal(await triangles(page), state.tri);
      await expectSamePicture(page, state, t, "real hang");
    });
  });
});

// ======================================================================= G7

describe("G7: browser, a WebAssembly trap kills the worker, it is recreated, the recipe replayed", () => {
  after(() => stopPreview());
  for (const mode of ["abort", "nullcall", "intdiv"] as const) {
    it(`trap ${mode}: new worker, same picture, page not reloaded`, async (t: TestContext) => {
      await withApp("web", {}, async (l) => {
        const page = l.page;
        const state = await makeNonDefault(page);
        await page.evaluate(() => ((window as unknown as { __qaMarker: number }).__qaMarker = 777));
        const oldWorkers = page.workers();
        assert.equal(oldWorkers.length, 1);
        await page.locator(`[data-crash=${mode}]`).click();
        const errors = await waitCrashRecovered(page, 0);
        const n = errors.find((e) => e.title.startsWith("Die Engine ist abgestürzt"))!;
        assert.ok(n, "crash notice");
        t.diagnostic(n.text.replace(/\n/g, " | ").slice(0, 400));
        evidence(`web-g7-${mode}-notice.txt`, `${n.title}\n${n.text}`);
        assert.match(n.text, /RuntimeError/);
        assert.ok(n.fullyVisible && n.hasCopy);
        await page.locator("[data-testid=notices] article", { hasText: n.title }).getByRole("button", { name: "Kopieren" }).click();
        const clip = await until("clipboard written", async () => (await page.evaluate(() => navigator.clipboard.readText())) || false);
        assert.equal(lf(clip), `${n.title}\n${n.text}`);
        const workers = page.workers();
        assert.equal(workers.length, 1, "exactly one worker alive");
        assert.ok(!oldWorkers.includes(workers[0]!), "it is a new worker, not the one that trapped");
        assert.equal(await page.evaluate(() => (window as unknown as { __qaMarker?: number }).__qaMarker), 777);
        assert.equal(await page.evaluate(() => performance.getEntriesByType("navigation").length), 1);
        assert.equal(await triangles(page), state.tri);
        assert.equal(await numberInput(page, "Bohrung").inputValue(), "30");
        await shot(l, `g7-after-${mode}-with-notices`);
        await expectSamePicture(page, state, t, `trap ${mode}`);
        assert.deepEqual(l.pageErrors, []);
      });
    });
  }

  // Known gap reported by the developer (no per-command timeout on the WebAssembly path): a worker that stops
  // answering (here: stuck in an endless loop) is never noticed. The test states the wanted behaviour and is marked todo.
  it("a hung worker (endless loop, not a trap) is detected within 15 s and replaced", { todo: "WebAssembly path has no watchdog" }, async () => {
    await withApp("web", {}, async (l) => {
      const page = l.page;
      const state = await makeNonDefault(page);
      void page.workers()[0]!.evaluate(() => {
        for (;;) {
          // hang
        }
      }).catch(() => {});
      const v0 = await version(page);
      await setParam(page, "Länge", 100);
      await until("the UI reports the hung engine and recovers", async () => (await crashCount(page)) >= 1 && /ready$/.test(await engineStatus(page)), 15_000);
      assert.ok((await version(page)) > v0);
      assert.equal(await numberInput(page, "Bohrung").inputValue(), "30");
      assert.ok(state.tri > 0);
    });
  });

  it("three traps in a row on one page all recover", async (t: TestContext) => {
    await withApp("web", {}, async (l) => {
      const page = l.page;
      const state = await makeNonDefault(page);
      for (const [i, mode] of (["abort", "nullcall", "intdiv"] as const).entries()) {
        await page.locator(`[data-crash=${mode}]`).click();
        await until(`crash ${i + 1} recovered`, async () => (await crashCount(page)) === i + 1 && /ready$/.test(await engineStatus(page)), 20_000);
        assert.equal(await triangles(page), state.tri);
      }
      await expectSamePicture(page, state, t, "three traps");
    });
  });
});

// ======================================================================= G8

interface Fallback {
  name: string;
  target: Target;
  opts: LaunchOptions;
  /** Backend the badge must name; null: any, the scenario only proves the app works without a GPU. */
  backend: "WebGL2" | null;
  /** Expected suffix in the badge. */
  badge?: RegExp;
}

const hideGpu = "Object.defineProperty(Navigator.prototype, 'gpu', { get() { return undefined; }, configurable: true });";
const fallbacks: Fallback[] = [
  { name: "forced WebGL2 (?renderer=webgl)", target: "desktop", opts: { query: "renderer=webgl" }, backend: "WebGL2", badge: /WebGL2 erzwungen/ },
  { name: "WebGPU hidden by the page (?renderer=nogpu)", target: "desktop", opts: { query: "renderer=nogpu" }, backend: "WebGL2", badge: /WebGPU ausgeblendet/ },
  { name: "GPU process disabled (--disable-gpu)", target: "desktop", opts: { query: "renderer=auto", args: ["--disable-gpu"] }, backend: null },
  { name: "forced WebGL2 (?renderer=webgl)", target: "web", opts: { query: "renderer=webgl" }, backend: "WebGL2", badge: /WebGL2 erzwungen/ },
  { name: "WebGPU hidden by the page (?renderer=nogpu)", target: "web", opts: { query: "renderer=nogpu" }, backend: "WebGL2", badge: /WebGPU ausgeblendet/ },
  { name: "browser without navigator.gpu (init script, renderer=auto)", target: "web", opts: { query: "renderer=auto", initScript: hideGpu }, backend: "WebGL2" },
  { name: "GPU process disabled (--disable-gpu)", target: "web", opts: { query: "renderer=auto", args: ["--disable-gpu"] }, backend: null },
];

describe("G8: WebGL2 fallback when WebGPU is off", () => {
  after(() => stopPreview());
  for (const f of fallbacks) {
    it(`${f.target}: ${f.name}`, async (t: TestContext) => {
      const expected = await expectedFaces();
      const slug = `${f.target}-g8-${f.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
      const l = await launchers[f.target](f.opts);
      try {
        await waitForBody(l.page);
        const badge = (await l.page.getByTestId("backend").innerText()).trim();
        const detail = (await l.page.getByTestId("backend-detail").innerText()).trim();
        const adapter = (await dd(l.page, "Adapter").innerText()).trim();
        const gpuApi = await l.page.evaluate(() => typeof (navigator as Navigator & { gpu?: unknown }).gpu);
        t.diagnostic(`badge "${badge}" | detail "${detail}" | adapter "${adapter}" | typeof navigator.gpu ${gpuApi}`);
        evidence(`${slug}.txt`, `badge: ${badge}\ndetail: ${detail}\nadapter: ${adapter}\ntypeof navigator.gpu: ${gpuApi}\n`);
        if (f.backend) {
          assert.match(detail, new RegExp(`^${f.backend}`), `backend in use: ${detail}`);
          assert.match(badge, new RegExp(f.backend));
        } else {
          assert.match(detail, /^(WebGPU|WebGL2)/);
        }
        if (f.badge) assert.match(badge, f.badge);
        // Asked from outside: which context does the canvas really hold?
        const ctx = await canvasContextKind(l.page);
        t.diagnostic(`canvas context: ${ctx}`);
        if (f.backend) assert.equal(ctx, "webgl2", "the canvas holds a WebGL2 context");
        assert.equal(ctx === "webgl2", /^WebGL2/.test(detail), "the badge matches the canvas context");
        // The engine part is unaffected.
        assert.equal(await triangles(l.page), P1A_TRIANGLES);
        const png = await canvasShot(l.page);
        const st = await imageStats(l.page, png);
        assert.ok(st.foreground > 0.08 * st.width * st.height, "the body is drawn");
        assert.ok(st.edgePixels > 300, `edge lines are drawn on ${detail}`);
        await shot(l, slug);
        // Picking and a parameter change on this backend.
        const rep = await checkPicking(l, expected, 14, 10, slug);
        assert.ok(rep.faces.length >= 3, `faces picked: ${rep.faces}`);
        const v0 = await version(l.page);
        await setParam(l.page, "Verrundung", 6);
        await waitRebuilt(l.page, v0);
        assert.ok((await imageDiff(l.page, png, await canvasShot(l.page))) > 100, "the new fillet radius shows");
        assert.deepEqual(l.pageErrors, []);
        assert.deepEqual(l.consoleErrors, []);
      } finally {
        await l.close();
      }
    });
  }
});
