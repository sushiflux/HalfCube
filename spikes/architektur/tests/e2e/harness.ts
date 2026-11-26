// Shared setup of the end-to-end suite (Playwright, driven from node:test): launches the Electron window (native
// engine) or the built browser page (WebAssembly engine in a Web Worker), plus helpers that read only what a user
// sees (page text, canvas pixels, real mouse events) and what the operating system shows (engine processes).
//
// Environment:
//   HC_BROWSER_EXE      Chromium-based browser for the web page (default: first of Chrome, Edge, Brave found)
//   HC_E2E_EVIDENCE     folder for screenshots and logs (default: _build/e2e-evidence)
//   HC_E2E_HEADED=1     show the browser window (default: headless)
//   HC_E2E_WINDOW       Electron window in test runs: "inactive" (default: shown without taking the focus) or "hidden"
//                      (never shown; Playwright screenshots of a hidden Electron window time out, so most tests need "inactive")
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, chromium, type Browser, type BrowserContext, type ElectronApplication, type Page } from "playwright-core";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const evidenceDir = process.env.HC_E2E_EVIDENCE ?? join(root, "_build/e2e-evidence");
export const PREVIEW_PORT = 5311;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function evidence(name: string, data: string | Buffer): string {
  const file = join(evidenceDir, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  return file;
}

// ---------------------------------------------------------------- processes

export interface ProcInfo {
  pid: number;
  parentPid: number;
  commandLine: string;
}

/** Parent process id of every process (Windows). */
export function parentTable(): Map<number, number> {
  const ps = "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)|$($_.ParentProcessId)\" }";
  const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  const m = new Map<number, number>();
  for (const l of r.stdout.split(/\r?\n/)) {
    const [a, b] = l.split("|");
    if (a && b) m.set(Number(a), Number(b));
  }
  return m;
}

/** Native engine processes that descend from process `ancestor` (the Electron window launched by a test). */
export function enginesOf(ancestor: number): ProcInfo[] {
  const table = parentTable();
  const descends = (pid: number) => {
    for (let p = table.get(pid), i = 0; p !== undefined && i < 20; p = table.get(p), ++i) if (p === ancestor) return true;
    return false;
  };
  return engineProcesses().filter((e) => descends(e.pid));
}

/** Native engine processes, with their parents (Windows). */
export function engineProcesses(): ProcInfo[] {
  const ps =
    "Get-CimInstance Win32_Process -Filter \"Name='halfcube-engine.exe'\" | " +
    "ForEach-Object { \"$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)\" }";
  const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  return r.stdout
    .split(/\r?\n/)
    .filter((l) => l.includes("|"))
    .map((l) => {
      const [pid, parent, ...rest] = l.split("|");
      return { pid: Number(pid), parentPid: Number(parent), commandLine: rest.join("|") };
    });
}

export function killPid(pid: number): { ok: boolean; output: string } {
  const r = spawnSync("taskkill", ["/F", "/PID", String(pid)], { encoding: "utf8" });
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}`.trim() };
}

/** Freezes a process (NtSuspendProcess): a real hang, not a simulated one. */
export function suspendPid(pid: number): void {
  const ps = `
Add-Type -Namespace Pc -Name Nt -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(System.IntPtr h);'
$p = [System.Diagnostics.Process]::GetProcessById(${pid})
$rc = [Pc.Nt]::NtSuspendProcess($p.Handle)
if ($rc -ne 0) { exit 1 }`;
  const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`NtSuspendProcess failed: ${r.stdout}${r.stderr}`);
}

export function pidAlive(pid: number): boolean {
  const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
  return r.stdout.includes(`"${pid}"`);
}

// ---------------------------------------------------------------- launching

export interface Launched {
  page: Page;
  kind: "desktop" | "web";
  /** Errors thrown in the page (uncaught) and console errors, collected from the start. */
  pageErrors: string[];
  consoleErrors: string[];
  app?: ElectronApplication;
  context?: BrowserContext;
  /** Process id of the Electron main process. */
  mainPid?: number;
  close(): Promise<void>;
}

function attachCollectors(page: Page, pageErrors: string[], consoleErrors: string[]) {
  page.on("pageerror", (e) => pageErrors.push(`${e.name}: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) consoleErrors.push(`HTTP ${r.status()} ${r.url()}`);
  });
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
}

export interface LaunchOptions {
  /** Page parameters, e.g. "renderer=webgl". */
  query?: string;
  /** Extra browser or Electron command line switches. */
  args?: string[];
  /** Script that runs in every page before its own scripts (web only). */
  initScript?: string;
  env?: Record<string, string>;
}

export async function launchDesktop(opts: LaunchOptions = {}): Promise<Launched> {
  const electronExe = createRequire(import.meta.url)("electron") as unknown as string;
  const app = await _electron.launch({
    executablePath: electronExe,
    args: [".", ...(opts.args ?? [])],
    cwd: root,
    env: {
      ...(process.env as Record<string, string>),
      // The window must never take the focus away from whoever is working on this machine.
      HC_SPIKE_TEST_WINDOW: process.env.HC_E2E_WINDOW ?? "inactive",
      ...(opts.query ? { HC_SPIKE_QUERY: opts.query } : {}),
      ...opts.env,
    },
  });
  const page = await app.firstWindow();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  attachCollectors(page, pageErrors, consoleErrors);
  return {
    page, kind: "desktop", app, pageErrors, consoleErrors, mainPid: app.process().pid,
    close: async () => {
      await app.close().catch(() => {});
    },
  };
}

const browserCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
];

export function browserExe(): string {
  const exe = process.env.HC_BROWSER_EXE ?? browserCandidates.find((p) => existsSync(p));
  if (!exe) throw new Error("Set HC_BROWSER_EXE to a Chromium-based browser for the web tests.");
  return exe;
}

let previewServer: ChildProcess | null = null;
const previewLog: string[] = [];

/** Starts `vite preview` (127.0.0.1 only) once; fails with a clear message if the port is taken by something else. */
export async function startPreview(): Promise<void> {
  if (previewServer) return;
  const probe = await fetch(`http://127.0.0.1:${PREVIEW_PORT}/`).then((r) => r.ok, () => false);
  if (probe) throw new Error(`Port ${PREVIEW_PORT} is already served by another process; stop it before running the web tests.`);
  previewServer = spawn(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "preview", "--config", "vite.config.ts"], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  previewServer.stdout!.on("data", (d: Buffer) => previewLog.push(String(d)));
  previewServer.stderr!.on("data", (d: Buffer) => previewLog.push(String(d)));
  for (let i = 0; i < 200; ++i) {
    if (await fetch(`http://127.0.0.1:${PREVIEW_PORT}/`).then((r) => r.ok, () => false)) return;
    await sleep(100);
  }
  throw new Error(`vite preview did not start: ${previewLog.join("")}`);
}

export function stopPreview(): void {
  previewServer?.kill();
  previewServer = null;
}

let sharedBrowser: Browser | null = null;

export async function launchWeb(opts: LaunchOptions = {}): Promise<Launched> {
  await startPreview();
  const browser = await chromium.launch({
    executablePath: browserExe(),
    headless: process.env.HC_E2E_HEADED !== "1",
    args: opts.args ?? [],
  });
  sharedBrowser = browser;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  if (opts.initScript) await context.addInitScript(opts.initScript);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  attachCollectors(page, pageErrors, consoleErrors);
  await page.goto(`http://127.0.0.1:${PREVIEW_PORT}/${opts.query ? `?${opts.query}` : ""}`);
  return {
    page, kind: "web", context, pageErrors, consoleErrors,
    close: async () => {
      await browser.close().catch(() => {});
      if (sharedBrowser === browser) sharedBrowser = null;
    },
  };
}

// ---------------------------------------------------------------- what the user sees

export const text = (page: Page, testId: string) => page.getByTestId(testId).innerText();

/** Value of the definition-list entry whose label is `label` (right-hand panel). */
export const dd = (page: Page, label: string) => page.locator(`dt:text-is("${label}") + dd`);

/** Waits until the engine is ready and a body with triangles is shown. Returns the triangle count. */
export async function waitForBody(page: Page, timeout = 30_000): Promise<number> {
  await page.getByTestId("engine-status").filter({ hasText: /ready$/ }).waitFor({ timeout });
  await page.getByTestId("backend").filter({ hasNotText: "startet" }).waitFor({ timeout });
  const handle = await page.waitForFunction(
    () => {
      const dts = [...document.querySelectorAll("dt")];
      const label = dts.find((d) => d.textContent === "Dreiecke");
      const v = Number(label?.nextElementSibling?.textContent);
      return Number.isFinite(v) && v > 0 ? v : false;
    },
    undefined,
    { timeout },
  );
  return (await handle.jsonValue()) as number;
}

export async function triangles(page: Page): Promise<number> {
  return Number((await dd(page, "Dreiecke").innerText()).trim());
}

export interface StepRow {
  id: string;
  type: string;
  status: string;
  timing: string;
}

export async function stepRows(page: Page): Promise<StepRow[]> {
  return page.locator("ol.steps > li").evaluateAll((lis) =>
    lis.map((li) => ({
      id: li.querySelector("strong")?.textContent ?? "",
      type: li.querySelectorAll(".step-head .muted")[0]?.textContent ?? "",
      status: [...li.classList].find((c) => c !== "step") ?? "",
      timing: li.querySelectorAll(".step-head .muted")[1]?.textContent ?? "",
    })),
  );
}

export function numberInput(page: Page, labelText: string) {
  return page.locator("label.param", { hasText: labelText }).locator("input[type=number]");
}

export async function setParam(page: Page, labelText: string, value: number) {
  await numberInput(page, labelText).fill(String(value));
}

// ---------------------------------------------------------------- pixels

export interface ImageStats {
  width: number;
  height: number;
  /** Pixels that differ from the background colour (taken from the top-left pixel) by more than 12 per channel. */
  foreground: number;
  /** Bounding box of those pixels. */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Dark, blue-ish outline pixels (the edge lines, colour #16476e). */
  edgePixels: number;
}

/** Decodes a PNG inside the page (no image library needed) and measures it. */
export async function imageStats(page: Page, png: Buffer): Promise<ImageStats> {
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const bg = [d[0]!, d[1]!, d[2]!];
    let fg = 0, edge = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = 0; y < bmp.height; ++y) {
      for (let x = 0; x < bmp.width; ++x) {
        const i = 4 * (y * bmp.width + x);
        const r = d[i]!, g = d[i + 1]!, bl = d[i + 2]!;
        if (Math.abs(r - bg[0]!) > 12 || Math.abs(g - bg[1]!) > 12 || Math.abs(bl - bg[2]!) > 12) {
          fg++;
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
        if (r < 60 && g < 100 && bl > 80 && bl < 160 && bl - r > 40) edge++;
      }
    }
    return { width: bmp.width, height: bmp.height, foreground: fg, edgePixels: edge, box: fg ? { x0, y0, x1, y1 } : null };
  }, png.toString("base64"));
}

/** Number of pixels (of the first image's size) whose colour differs by more than `tol` per channel. */
export async function imageDiff(page: Page, a: Buffer, b: Buffer, tol = 8): Promise<number> {
  return page.evaluate(
    async ([a64, b64, t]) => {
      const load = async (s: string) => {
        const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(s), (c) => c.charCodeAt(0))], { type: "image/png" }));
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = c.getContext("2d")!;
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, bmp.width, bmp.height);
      };
      const ia = await load(a64 as string), ib = await load(b64 as string);
      if (ia.width !== ib.width || ia.height !== ib.height) return ia.width * ia.height;
      let n = 0;
      for (let i = 0; i < ia.data.length; i += 4) {
        if (Math.abs(ia.data[i]! - ib.data[i]!) > (t as number) || Math.abs(ia.data[i + 1]! - ib.data[i + 1]!) > (t as number) ||
            Math.abs(ia.data[i + 2]! - ib.data[i + 2]!) > (t as number)) n++;
      }
      return n;
    },
    [a.toString("base64"), b.toString("base64"), tol] as const,
  );
}

/** Colour of one pixel of a PNG. */
export async function pixelAt(page: Page, png: Buffer, x: number, y: number): Promise<[number, number, number]> {
  return page.evaluate(
    async ([b64, px, py]) => {
      const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64 as string), (c) => c.charCodeAt(0))], { type: "image/png" }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(px as number, py as number, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!] as [number, number, number];
    },
    [png.toString("base64"), Math.round(x), Math.round(y)] as const,
  );
}

/** Screenshot of the 3D canvas only. */
export const canvasShot = (page: Page) => page.getByTestId("viewport").screenshot();

// ---------------------------------------------------------------- picking

export interface PickText {
  faceId: number;
  surface: string;
  originStep: string;
  triangleCount: number;
  raw: string;
}

/** Parses the overlay text, e.g. "Fläche 1 · torus · aus Schritt „fillet“ · 1200 Dreiecke · ...". */
export function parsePick(raw: string): PickText | null {
  const m = /Fläche (\d+) · (\w+) · aus Schritt „([^“]+)“ · (\d+) Dreiecke/.exec(raw);
  return m ? { faceId: Number(m[1]), surface: m[2]!, originStep: m[3]!, triangleCount: Number(m[4]), raw } : null;
}

export async function currentPick(page: Page): Promise<PickText | null> {
  const el = page.getByTestId("pick");
  if ((await el.count()) === 0) return null;
  return parsePick(await el.innerText());
}

/** Real mouse click at a canvas-relative position. */
export async function clickCanvas(page: Page, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const box = (await page.getByTestId("viewport").boundingBox())!;
  const x = box.x + box.width * fx, y = box.y + box.height * fy;
  await page.mouse.click(x, y);
  return { x, y };
}

/**
 * Clicks a grid of points over the canvas and returns what the overlay said for each (null: nothing picked).
 * Waits for the overlay to settle after every click by polling until it changed or 400 ms passed.
 */
export async function pickGrid(page: Page, cols: number, rows: number) {
  const out: { fx: number; fy: number; pick: PickText | null }[] = [];
  let lastRaw = (await page.getByTestId("pick").count()) ? await page.getByTestId("pick").innerText() : "";
  for (let r = 0; r < rows; ++r) {
    for (let c = 0; c < cols; ++c) {
      const fx = 0.15 + (0.7 * c) / (cols - 1), fy = 0.15 + (0.7 * r) / (rows - 1);
      await clickCanvas(page, fx, fy);
      // The overlay is a function of the last click; a click on the same face leaves the text equal, so just yield briefly
      // through a rendered frame instead of waiting for a change.
      await page.evaluate(() => new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res()))));
      const pick = await currentPick(page);
      lastRaw = pick?.raw ?? "";
      out.push({ fx, fy, pick });
    }
  }
  void lastRaw;
  return out;
}

// ---------------------------------------------------------------- notices

export interface NoticeView {
  level: string;
  title: string;
  text: string;
  /** True when the text is fully rendered: no clipping, no ellipsis, nothing hidden by overflow. */
  fullyVisible: boolean;
  hasCopy: boolean;
}

export async function notices(page: Page): Promise<NoticeView[]> {
  return page.locator("[data-testid=notices] article").evaluateAll((els) =>
    els.map((el) => {
      const pre = el.querySelector("pre")!;
      const cs = getComputedStyle(pre);
      return {
        level: el.getAttribute("data-level") ?? "",
        title: el.querySelector("strong")?.textContent ?? "",
        text: pre.textContent ?? "",
        fullyVisible:
          pre.scrollHeight <= pre.clientHeight + 1 && pre.scrollWidth <= pre.clientWidth + 1 &&
          cs.textOverflow !== "ellipsis" && cs.overflow !== "hidden" && cs.display !== "none" && pre.getBoundingClientRect().height > 0,
        hasCopy: [...el.querySelectorAll("button")].some((b) => b.textContent === "Kopieren" || b.textContent === "Kopiert"),
      };
    }),
  );
}

/** Size of the 3D canvas in CSS pixels. */
export async function canvasBox(page: Page) {
  const b = (await page.getByTestId("viewport").boundingBox())!;
  return { width: Math.round(b.width), height: Math.round(b.height) };
}

/** Closes every notice (the panel below the view changes the view's height while notices are shown). */
export async function dismissNotices(page: Page) {
  const buttons = page.locator("[data-testid=notices] article").getByRole("button", { name: "Schließen" });
  while ((await buttons.count()) > 0) await buttons.first().click();
  await page.getByTestId("notices").waitFor({ state: "detached" });
}

/** Windows puts line breaks as CRLF on the clipboard. */
export const lf = (t: string) => t.replace(/\r\n/g, "\n");

/**
 * Which kind of context the 3D canvas really holds, asked from outside the app: getContext() with another type than the
 * one the canvas was created with returns null, so exactly one of the two answers is non-null.
 */
export async function canvasContextKind(page: Page): Promise<"webgpu" | "webgl2" | "unknown"> {
  return page.evaluate(() => {
    const c = document.querySelector("[data-testid=viewport]") as HTMLCanvasElement;
    if (c.getContext("webgl2")) return "webgl2";
    if (c.getContext("webgpu")) return "webgpu";
    return "unknown";
  });
}

// ---------------------------------------------------------------- icons

/**
 * The big icon the operating system holds for a window (WM_GETICON, ICON_BIG), as a PNG; null when the window has none.
 * Windows only. `hwnd` is the native window handle as a decimal string.
 */
export function windowIconPng(hwnd: string): Buffer | null {
  const ps = `
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Pc -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr SendMessage(System.IntPtr h, int m, System.IntPtr w, System.IntPtr l);'
$h = [Pc.Win]::SendMessage([System.IntPtr]${hwnd}, 0x7F, [System.IntPtr]1, [System.IntPtr]0)
if ($h -eq [System.IntPtr]::Zero) { exit 3 }
$icon = [System.Drawing.Icon]::FromHandle($h)
$bmp = $icon.ToBitmap()
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[Convert]::ToBase64String($ms.ToArray())`;
  const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  if (r.status === 3) return null;
  if (r.status !== 0) throw new Error(`reading the window icon failed: ${r.stdout}${r.stderr}`);
  return Buffer.from(r.stdout.trim(), "base64");
}

/** Mean absolute colour difference (0..255) of two PNGs after drawing both, scaled to `size`, on a white background. */
export async function iconDistance(page: Page, a: Buffer, b: Buffer, size = 32): Promise<number> {
  return page.evaluate(
    async ([a64, b64, n]) => {
      const draw = async (s: string) => {
        const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(s), (c) => c.charCodeAt(0))], { type: "image/png" }));
        const c = new OffscreenCanvas(n as number, n as number);
        const g = c.getContext("2d")!;
        g.fillStyle = "#fff";
        g.fillRect(0, 0, n as number, n as number);
        g.imageSmoothingQuality = "high";
        g.drawImage(bmp, 0, 0, n as number, n as number);
        return g.getImageData(0, 0, n as number, n as number).data;
      };
      const da = await draw(a64 as string), db = await draw(b64 as string);
      let sum = 0;
      for (let i = 0; i < da.length; i += 4) sum += Math.abs(da[i]! - db[i]!) + Math.abs(da[i + 1]! - db[i + 1]!) + Math.abs(da[i + 2]! - db[i + 2]!);
      return sum / ((da.length / 4) * 3);
    },
    [a.toString("base64"), b.toString("base64"), size] as const,
  );
}
