// Fixtures of the suite. One spec runs unchanged against both targets:
//   browser   the web build in a Chromium browser. Default: the official Playwright Docker image, reached with
//             Playwright's remote connection (HALFCUBE_E2E_BROWSER=docker, HALFCUBE_E2E_WS). Marked fallback:
//             an installed Chrome, Brave or Edge, headless (HALFCUBE_E2E_BROWSER=local).
//   electron  the real Electron program, window inactive, own user data folder.
// `app` is the page under test plus the few things that differ between the targets.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium, expect, test as base, type Browser, type CDPSession, type ElectronApplication, type Page } from "@playwright/test";
import { engineChildren, launchElectron, type LaunchedElectron } from "./electron-app.ts";
import { browserMode, e2eBuild, serverPort, type BrowserMode, type Target } from "./paths.ts";

export type { Target };

export interface AppUnderTest {
  target: Target;
  page: Page;
  /** The Electron program itself (main process), for tests that stub what it opens outside the window; only on the electron target. */
  electron?: ElectronApplication;
  /** What the target is, for the report: "chromium 142.0.x (official Playwright Docker image)", "electron 45.x (chrome 140.x)". */
  description: string;
  /** Console errors and uncaught page errors since the test began. */
  errors: string[];
  /** Opens the app. `search` is the query string with its "?", e.g. "?demo=gallery&lang=de". Starts with nothing stored. */
  open(search?: string): Promise<void>;
  /** The URL of a file of the build (the harness page), for page.goto. */
  url(path: string): string;
  /** Sets the width of the page (window) in CSS pixels; returns the width the page really has. */
  setWidth(width: number): Promise<number>;
  readClipboard(): Promise<string>;
  /**
   * Ends the engine on purpose, the way a crash does (the session then restarts it): the browser's test engine gets
   * diagnostics.crash (open the page with `engine=testing`), the native engine process is ended from outside. Resolves with
   * whether an engine was found and ended.
   */
  crashEngine(): Promise<boolean>;
}

interface BrowserHandle {
  browser: Browser;
  mode: BrowserMode;
  description: string;
}

function localBrowserPath(): string {
  const candidates = [
    process.env.HALFCUBE_E2E_CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].filter((c): c is string => typeof c === "string" && c !== "");
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(`HALFCUBE_E2E_BROWSER=local needs an installed Chrome, Brave or Edge (or HALFCUBE_E2E_CHROME). Looked for: ${candidates.join("; ")}`);
  }
  return found;
}

/**
 * The Electron programs of the parallel workers share the one operating-system clipboard. A test tagged @clipboard holds this
 * cross-process lock for its whole run, so no other worker overwrites the clipboard between its copy and its read.
 */
const clipboardLock = join(e2eBuild, "clipboard.lock");
async function withClipboardLock(testInfo: { tags: string[] }, target: Target, run: () => Promise<void>): Promise<void> {
  if (target !== "electron" || !testInfo.tags.includes("@clipboard")) return run();
  mkdirSync(e2eBuild, { recursive: true });
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      mkdirSync(clipboardLock);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("The clipboard lock of the Electron tests was not released within 120 s: " + clipboardLock);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    await run();
  } finally {
    rmSync(clipboardLock, { recursive: true, force: true });
  }
}

export const test = base.extend<{ app: AppUnderTest }, { target: Target; browserHandle: BrowserHandle | undefined; electronHandle: LaunchedElectron | undefined }>({
  target: ["browser", { scope: "worker", option: true }],

  browserHandle: [
    async ({ target }, provide) => {
      if (target !== "browser") {
        await provide(undefined);
        return;
      }
      const mode = browserMode();
      let browser: Browser;
      let where: string;
      if (mode === "docker") {
        const ws = process.env.HALFCUBE_E2E_WS ?? "ws://127.0.0.1:3100/";
        browser = await chromium.connect(ws, { timeout: 30_000 });
        where = "official Playwright Docker image";
      } else {
        const executablePath = localBrowserPath();
        browser = await chromium.launch({ executablePath, headless: true });
        where = `LOCAL FALLBACK, not the Docker image: ${executablePath}`;
      }
      await provide({ browser, mode, description: `chromium ${browser.version()} (${where})` });
      await browser.close();
    },
    { scope: "worker" },
  ],

  electronHandle: [
    async ({ target }, provide) => {
      if (target !== "electron") {
        await provide(undefined);
        return;
      }
      const launched = await launchElectron({ language: "en", colorMode: "light" });
      await provide(launched);
      await launched.close();
    },
    { scope: "worker" },
  ],

  app: async ({ target, browserHandle, electronHandle }, provide, testInfo) => {
    const errors: string[] = [];
    const watch = (page: Page) => {
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
      });
    };
    const attachScreenshot = async (page: Page) => {
      if (testInfo.status === testInfo.expectedStatus) return;
      const body = await page.screenshot().catch(() => undefined);
      if (body) await testInfo.attach("failure-screenshot", { body, contentType: "image/png" });
    };

    if (target === "browser") {
      if (!browserHandle) throw new Error("No browser for the browser target.");
      // In the container, tests/e2e/run.mjs forwards localhost:<port> to the host's loopback server. "localhost" is a
      // trustworthy origin (clipboard, COOP/COEP and SharedArrayBuffer work); host.docker.internal is not.
      const host = browserHandle.mode === "docker" ? "localhost" : "127.0.0.1";
      const origin = `http://${host}:${serverPort}`;
      const context = await browserHandle.browser.newContext({
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
        colorScheme: "light",
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await context.newPage();
      watch(page);
      testInfo.annotations.push({ type: "target", description: browserHandle.description });
      const handle: AppUnderTest = {
        target,
        page,
        description: browserHandle.description,
        errors,
        open: async (search = "") => {
          await page.goto(`${origin}/index.html${search}`);
        },
        url: (path) => `${origin}${path}`,
        setWidth: async (width) => {
          await page.setViewportSize({ width, height: 800 });
          return page.evaluate(() => window.innerWidth);
        },
        readClipboard: () => page.evaluate(() => navigator.clipboard.readText()),
        crashEngine: () =>
          page.evaluate(async () => {
            const session = (window as unknown as { __halfcubeSession?: { client: { request(c: unknown): { reply: Promise<unknown> } } } }).__halfcubeSession;
            if (!session) return false;
            await session.client.request({ type: "diagnostics.crash", mode: "intdiv" }).reply.catch(() => undefined);
            return true;
          }),
      };
      await provide(handle);
      await attachScreenshot(page);
      await context.close();
      return;
    }

    if (!electronHandle) throw new Error("No Electron program for the electron target.");
    const { app: electron, page } = electronHandle;
    const description = await electron.evaluate(() => `electron ${process.versions.electron} (chrome ${process.versions.chrome})`);
    testInfo.annotations.push({ type: "target", description });
    watch(page);
    // The page and its window are shared by all tests of a worker. Playwright's own page.setViewportSize would leave a viewport
    // override behind (its size and device scale 1 instead of the window's real scale, 1.5 here), which makes the layout of every
    // later test fractional in a different way. So on this target the call becomes an override held by a session of this test only;
    // detaching that session at the end of the test removes it, and the page keeps the window's real size and scale for the next one.
    let emulation: CDPSession | undefined;
    page.setViewportSize = async ({ width, height }) => {
      emulation ??= await page.context().newCDPSession(page);
      await emulation.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 0, mobile: false });
    };
    const origin = "app://halfcube";
    const resize = (width: number, height: number) =>
      electron.evaluate(
        ({ BrowserWindow }, size) => {
          const win = BrowserWindow.getAllWindows()[0];
          if (!win) throw new Error("The program has no window.");
          win.setSize(size.width, size.height);
        },
        { width, height },
      );
    const handle: AppUnderTest = {
      target,
      page,
      electron,
      description,
      errors,
      open: async (search = "") => {
        // The window is shared by the tests of this worker: every test starts with nothing stored and the default size.
        await page.evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        });
        await resize(1440, 900);
        await page.goto(`${origin}/index.html${search}`);
      },
      url: (path) => `${origin}${path}`,
      setWidth: async (width) => {
        await resize(width, 900);
        // The window is sized in device-independent pixels but lives on physical ones: on a display with a fractional scale
        // factor (175 % here) the operating system rounds the window outwards, so it is up to two CSS pixels wider than asked
        // (960 -> 962, 1440 -> 1441) and never narrower (the program's minimum width is honoured exactly).
        const excess = () => page.evaluate((asked) => window.outerWidth - asked, width);
        await expect.poll(excess).toBeGreaterThanOrEqual(0);
        await expect.poll(excess).toBeLessThanOrEqual(2);
        return page.evaluate(() => window.innerWidth);
      },
      readClipboard: () => electron.evaluate(({ clipboard }) => clipboard.readText()),
      crashEngine: async () => {
        const engines = engineChildren(electronHandle.pid);
        for (const pid of engines) process.kill(pid);
        return engines.length > 0;
      },
    };
    await withClipboardLock(testInfo, target, async () => {
      try {
        await provide(handle);
        await attachScreenshot(page);
      } finally {
        await emulation?.detach().catch(() => undefined);
      }
    });
  },
});

export { expect };
