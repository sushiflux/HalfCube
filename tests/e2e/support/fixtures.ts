// Fixtures of the suite. Every spec runs against the real Electron program (the native engine process behind the preload
// bridge): window inactive, own user data folder, one program per worker.
// `app` is the page under test plus a few helpers around the program.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test as base, type CDPSession, type ElectronApplication, type Page } from "@playwright/test";
import { engineChildren, launchElectron, type LaunchedElectron } from "./electron-app.ts";
import { e2eBuild } from "./paths.ts";

export interface AppUnderTest {
  page: Page;
  /** The Electron program itself (main process), for tests that stub what it opens outside the window. */
  electron: ElectronApplication;
  /** What the program is, for the report: "electron 45.x (chrome 140.x)". */
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
   * Ends the native engine process on purpose, from outside, the way a crash does (the session then restarts it). Resolves
   * with whether an engine process was found and ended.
   */
  crashEngine(): Promise<boolean>;
}

/**
 * The Electron programs of the parallel workers share the one operating-system clipboard. A test tagged @clipboard holds this
 * cross-process lock for its whole run, so no other worker overwrites the clipboard between its copy and its read.
 */
const clipboardLock = join(e2eBuild, "clipboard.lock");
async function withClipboardLock(testInfo: { tags: string[] }, run: () => Promise<void>): Promise<void> {
  if (!testInfo.tags.includes("@clipboard")) return run();
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

export const test = base.extend<{ app: AppUnderTest }, { electronHandle: LaunchedElectron }>({
  electronHandle: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, provide) => {
      const launched = await launchElectron({ language: "en", colorMode: "light" });
      await provide(launched);
      await launched.close();
    },
    { scope: "worker" },
  ],

  app: async ({ electronHandle }, provide, testInfo) => {
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

    const { app: electron, page } = electronHandle;
    const description = await electron.evaluate(() => `electron ${process.versions.electron} (chrome ${process.versions.chrome})`);
    testInfo.annotations.push({ type: "target", description });
    watch(page);
    // The page and its window are shared by all tests of a worker. Playwright's own page.setViewportSize would leave a viewport
    // override behind (its size and device scale 1 instead of the window's real scale, 1.5 here), which makes the layout of every
    // later test fractional in a different way. So the call becomes an override held by a session of this test only;
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
    await withClipboardLock(testInfo, async () => {
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
