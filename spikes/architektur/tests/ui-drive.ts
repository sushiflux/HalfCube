// Drives the spike UI over the Chrome DevTools Protocol: the Electron window (native engine) or a Chromium
// browser with the built page (WebAssembly engine). Runs the in-page autotest (app/src/autotest.ts), clicks a face
// with real input events, takes screenshots and writes one JSON report.
//
// Usage:
//   node tests/ui-drive.ts --target desktop [--renderer auto|webgl|nogpu] [--out report.json] [--shot dir]
//   node tests/ui-drive.ts --target web     [--renderer ...] [--headed] [--out ...] [--shot ...]
//   --query engine=wasm adds page parameters (here: the WebAssembly engine inside the Electron window)
// The web target needs HC_BROWSER_EXE (path of a Chromium-based browser) and a built page (npm run build:web);
// the desktop target needs npm run build:ui and the native engine.
// The DevTools port is the spike's test port on 127.0.0.1; the page server is `vite preview` (127.0.0.1 only).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CDP_PORT = 5312;
const PREVIEW_PORT = 5311;
const root = fileURLToPath(new URL("../", import.meta.url));

const args = process.argv.slice(2);
const arg = (name: string, def?: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const target = arg("--target", "desktop") as "desktop" | "web";
const renderer = arg("--renderer", "auto")!;
const outPath = arg("--out");
const shotDir = arg("--shot");
const headed = args.includes("--headed");
const runs = Number(arg("--runs", "15"));
/** Extra page parameters, e.g. engine=wasm. */
const extraQuery = arg("--query", "")!;
const pageQuery = `renderer=${renderer}${extraQuery ? "&" + extraQuery : ""}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const children: ChildProcess[] = [];
const logLines: string[] = [];

function startChild(cmd: string, argv: string[], env: Record<string, string> = {}): ChildProcess {
  const c = spawn(cmd, argv, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const tag = cmd.split(/[\\/]/).pop();
  c.stdout!.setEncoding("utf8").on("data", (t: string) => logLines.push(...t.trimEnd().split("\n").map((l) => `[${tag} out] ${l}`)));
  c.stderr!.setEncoding("utf8").on("data", (t: string) => logLines.push(...t.trimEnd().split("\n").map((l) => `[${tag} err] ${l}`)));
  children.push(c);
  return c;
}

async function waitHttp(url: string, timeoutMs: number): Promise<Response> {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
    } catch {
      // not up yet
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out waiting for ${url}`);
    await sleep(100);
  }
}

class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  events: { method: string; params: unknown }[] = [];
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.reject(new Error(m.error.message));
        else p?.resolve(m.result);
      } else if (m.method) this.events.push({ method: m.method, params: m.params });
    };
  }
  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Cdp(ws));
      ws.onerror = () => reject(new Error(`DevTools connection to ${url} failed`));
    });
  }
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval<T>(expression: string, timeoutMs = 300_000): Promise<T> {
    const r = await Promise.race([
      this.send<{ result: { value: T }; exceptionDetails?: { exception?: { description?: string }; text: string } }>("Runtime.evaluate", {
        expression, awaitPromise: true, returnByValue: true,
      }),
      sleep(timeoutMs).then(() => {
        throw new Error(`evaluate timed out: ${expression.slice(0, 80)}`);
      }),
    ]);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  close() {
    this.ws.close();
  }
}

async function screenshot(cdp: Cdp, name: string) {
  if (!shotDir) return;
  mkdirSync(shotDir, { recursive: true });
  const r = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(shotDir, `${target}-${pageQuery.replace(/[^a-z0-9]+/gi, "-")}-${name}.png`), Buffer.from(r.data, "base64"));
}

function engineProcesses(): number {
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq halfcube-engine.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
  return (r.stdout.match(/halfcube-engine\.exe/g) ?? []).length;
}

async function main() {
  const report: Record<string, unknown> = { target, renderer, query: pageQuery, headed, date: new Date().toISOString() };
  let profileDir: string | null = null;
  const enginesBefore = engineProcesses();
  const tStart = performance.now();
  let pageMatch: (u: string) => boolean;

  if (target === "desktop") {
    const electronExe = createRequire(import.meta.url)("electron") as unknown as string;
    startChild(electronExe, [".", `--remote-debugging-port=${CDP_PORT}`], { HC_SPIKE_QUERY: pageQuery });
    pageMatch = (u) => u.startsWith("app://halfcube/");
  } else {
    const browser = process.env.HC_BROWSER_EXE;
    if (!browser) throw new Error("Set HC_BROWSER_EXE to a Chromium-based browser for the web target.");
    startChild(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "preview", "--config", "vite.config.ts"]);
    await waitHttp(`http://127.0.0.1:${PREVIEW_PORT}/`, 20_000);
    profileDir = mkdtempSync(join(os.tmpdir(), "halfcube-spike-browser-"));
    const url = `http://127.0.0.1:${PREVIEW_PORT}/?${pageQuery}`;
    startChild(browser, [
      `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check",
      "--window-size=1440,900", ...(headed ? [] : ["--headless=new"]), url,
    ]);
    pageMatch = (u) => u.startsWith(`http://127.0.0.1:${PREVIEW_PORT}/`);
  }

  let cdp: Cdp | null = null;
  try {
    await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 30_000);
    const version = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()) as Record<string, string>;
    report.browserVersion = version.Browser;
    let wsUrl = "";
    for (let i = 0; i < 300 && !wsUrl; ++i) {
      const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
      wsUrl = list.find((t) => t.type === "page" && pageMatch(t.url))?.webSocketDebuggerUrl ?? "";
      if (!wsUrl) await sleep(100);
    }
    if (!wsUrl) throw new Error("The spike page did not appear in the DevTools target list.");
    cdp = await Cdp.connect(wsUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    const t0 = performance.now();
    for (;;) {
      const ready = await cdp.eval<boolean>("!!window.__halfcubeSpike && window.__halfcubeSpike.ready()");
      if (ready) break;
      if (performance.now() - t0 > 60_000) {
        await screenshot(cdp, "not-ready");
        const text = await cdp.eval<string>("document.body.innerText");
        throw new Error(`The page did not show a body within 60 s. Page text:\n${text}`);
      }
      await sleep(50);
    }
    report.driverToReadyMs = Math.round(performance.now() - tStart);

    // What the page itself can reach: no Node, only the one-function bridge, no foreign network (desktop only:
    // the request is stopped inside Electron before it reaches the network).
    report.pageCapabilities = await cdp.eval(`(async () => {
      let externalFetch = "not tried";
      if (${target === "desktop"}) try { await fetch("https://example.com/", { mode: "no-cors" }); externalFetch = "allowed"; }
      catch (e) { externalFetch = "blocked: " + e.message; }
      return {
        require: typeof require, process: typeof process, module: typeof module,
        bridgeKeys: window.halfCubeDesktop ? Object.keys(window.halfCubeDesktop) : null,
        crossOriginIsolated: window.crossOriginIsolated, isSecureContext: window.isSecureContext,
        origin: location.origin, externalFetch,
      };
    })()`);

    // Real input: click the fillet face (torus) and check the selection and the overlay text.
    const faces = await cdp.eval<{ faceId: number; surface: string }[]>("window.__halfcubeSpike.faces()");
    const torus = faces.find((f) => f.surface === "torus");
    if (torus) {
      const pt = await cdp.eval<{ x: number; y: number }>(`window.__halfcubeSpike.faceClientPoint(${torus.faceId})`);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await cdp.send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
      }
      await sleep(200);
      const sel = await cdp.eval<{ faceId: number } | null>("window.__halfcubeSpike.selection()");
      const overlay = await cdp.eval<string>("document.querySelector('[data-testid=pick]')?.innerText ?? ''");
      report.realClick = { expectedFaceId: torus.faceId, point: pt, selection: sel, overlay, ok: sel?.faceId === torus.faceId };
      await screenshot(cdp, "picked");
    }

    await cdp.eval(`window.__halfcubeSpike.start(${runs})`);
    const tRun = performance.now();
    let lastPhase = "";
    for (;;) {
      const st = await cdp.eval<{ phase: string; done: boolean; report?: unknown; error?: string }>("window.__halfcubeSpike.status()");
      if (st.phase !== lastPhase) {
        process.stderr.write(`[ui-drive] ${Math.round(performance.now() - tRun)} ms: ${st.phase}
`);
        lastPhase = st.phase;
      }
      if (st.done) {
        if (st.error) {
          await screenshot(cdp, "failed");
          throw new Error(`Autotest failed in phase "${st.phase}": ${st.error}
Status: ${JSON.stringify(st)}
Page text:
${await cdp.eval<string>("document.body.innerText")}`);
        }
        report.autotest = st.report;
        break;
      }
      if (performance.now() - tRun > 240_000) {
        await screenshot(cdp, "timeout");
        throw new Error(`Autotest timed out in phase "${st.phase}". Status: ${JSON.stringify(st)}
Page text:
${await cdp.eval<string>("document.body.innerText")}`);
      }
      await sleep(250);
    }
    await screenshot(cdp, "end");
    report.backendBadge = await cdp.eval<string>("document.querySelector('[data-testid=backend]')?.innerText ?? ''");
    report.enginesDuringRun = engineProcesses() - enginesBefore;
    report.pageErrors = cdp.events
      .filter((e) => e.method === "Runtime.exceptionThrown")
      .map((e) => JSON.stringify(e.params).slice(0, 2000));
    report.consoleWarnings = cdp.events
      .filter((e) => e.method === "Runtime.consoleAPICalled" && ["warning", "error"].includes((e.params as { type: string }).type))
      .map((e) => (e.params as { args: { value?: unknown; description?: string }[] }).args.map((a) => String(a.value ?? a.description ?? "")).join(" "));
    // The reply to Browser.close may never come because the connection drops while the browser closes.
    await Promise.race([cdp.send("Browser.close").catch(() => {}), sleep(3000)]);
  } finally {
    cdp?.close();
    await sleep(2500);
    report.enginesAfterClose = engineProcesses() - enginesBefore;
    for (const c of children) if (c.exitCode === null) c.kill();
    await sleep(500);
    if (profileDir) rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    report.processLog = logLines.filter((l) => l.includes("halfcube-main") || l.includes("err]")).slice(-200);
    const text = JSON.stringify(report, null, 2);
    if (outPath) writeFileSync(outPath, text);
    else process.stdout.write(text + "\n");
  }
}

// Exit explicitly: helper processes of the browser can inherit the output pipes and keep the event loop alive.
main().then(
  () => process.exit(0),
  (e) => {
    process.stderr.write(`${(e as Error).stack ?? e}\n`);
    for (const c of children) if (c.exitCode === null) c.kill();
    process.exit(1);
  },
);
