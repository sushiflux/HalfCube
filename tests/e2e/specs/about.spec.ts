// "About HalfCube" dialog: how it opens (status bar, title bar, the welcome screen's licence hint), Esc and
// the close button, the Info and Lizenzen tabs at exactly the same height, the credit line level with the last row of the right
// column, "Copied" and the search moving nothing, the licence texts loading, a reload keeping tab and component in the address, the
// browser hiding the desktop-only entries, the outside links going through the main process on the desktop, and the contrast of the
// whole view in every theme, light and dark. Runs in the browser and in the Electron program.
import type { Page } from "@playwright/test";
import { expect, test, type AppUnderTest } from "../support/fixtures.ts";
import { expectNothingMoved, snapshot, type Targets } from "../support/layout.ts";
import type { Lang } from "../support/paths.ts";

const words: Record<Lang, { title: string; close: string; tabInfo: string; tabLicences: string; early: string; licenceHint: string; licenceLink: string; copyVersion: string; copied: string; news: RegExp }> = {
  en: {
    title: "About HalfCube",
    close: "Close window “About HalfCube”",
    tabInfo: "Info",
    tabLicences: "Licences",
    early: "Early access",
    licenceHint: "Licensed under the PolyForm Shield License 1.0.0",
    licenceLink: "View licence",
    copyVersion: "Copy version",
    copied: "Copied",
    news: /what.s new/i,
  },
  de: {
    title: "Über HalfCube",
    close: "Fenster „Über HalfCube“ schließen",
    tabInfo: "Info",
    tabLicences: "Lizenzen",
    early: "Frühphase",
    licenceHint: "Es gilt die PolyForm Shield License 1.0.0",
    licenceLink: "Lizenz anzeigen",
    copyVersion: "Version kopieren",
    copied: "Kopiert",
    news: /was ist neu/i,
  },
};

/** Opens the main window past the welcome screen with "About HalfCube" already open (through the address, as a reload would). */
async function openAbout(app: AppUnderTest, lang: Lang, about = "about=info"): Promise<void> {
  const { page } = app;
  await app.open(`?screen=main&lang=${lang}&${about}`);
  await expect(page.getByRole("dialog", { name: words[lang].title })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("loading-screen")).toHaveCount(0);
}

/** Opens the main window with nothing open and waits until it is there. */
async function openMain(app: AppUnderTest, lang: Lang): Promise<void> {
  await app.open(`?screen=main&lang=${lang}`);
  await expect(app.page.getByTestId("loading-screen")).toHaveCount(0, { timeout: 60_000 });
  await expect(app.page.getByTestId("status-early")).toBeVisible({ timeout: 30_000 });
}

const dialogOf = (page: Page, lang: Lang) => page.getByRole("dialog", { name: words[lang].title });

/** The box of an element once the opening animation and the fonts have settled (the dialog springs in, so an early read is not final). */
async function box(page: Page, testId: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = (await snapshot(page, { it: page.getByTestId(testId) })).boxes.it;
  if (!b) throw new Error(`no box for ${testId}`);
  return b;
}

/** Counts what the system would open: stubs the two calls of the Electron main process so no test ever starts a real browser or viewer. */
async function stubOpeners(app: AppUnderTest): Promise<void> {
  if (!app.electron) return;
  await app.electron.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened?: string[] };
    g.__opened = [];
    shell.openExternal = (url: string) => {
      g.__opened?.push(`external:${url}`);
      return Promise.resolve();
    };
    shell.openPath = (path: string) => {
      g.__opened?.push(`path:${path}`);
      return Promise.resolve("");
    };
  });
}

async function opened(app: AppUnderTest): Promise<string[]> {
  if (!app.electron) return [];
  return app.electron.evaluate(() => (globalThis as unknown as { __opened?: string[] }).__opened ?? []);
}

test.describe("About HalfCube: entry points", () => {
  for (const lang of ["en", "de"] as const) {
    test(`opens from the early-access label in the status bar (${lang})`, async ({ app }) => {
      const { page } = app;
      await openMain(app, lang);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const label = page.getByTestId("status-early");
      await expect(label).toHaveText(words[lang].early);
      await expect(label).toHaveRole("button");
      await label.click();
      const dialog = dialogOf(page, lang);
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId("about-tab-info")).toHaveAttribute("aria-selected", "true");
      expect(new URL(page.url()).searchParams.get("about")).toBe("info");
    });

    test(`opens from the title bar (${lang})`, async ({ app }) => {
      const { page } = app;
      await openMain(app, lang);
      await page.getByRole("button", { name: words[lang].title, exact: true }).click();
      await expect(dialogOf(page, lang)).toBeVisible();
      expect(new URL(page.url()).searchParams.get("about")).toBe("info");
    });
  }

  test("opens from the licence hint line of the welcome screen, on the Lizenzen tab with the HalfCube licence", async ({ app }) => {
    const { page } = app;
    await app.open("?lang=en");
    const welcome = page.getByRole("dialog", { name: "Sketch first, then build" });
    await expect(welcome).toBeVisible({ timeout: 60_000 });

    // The hint is on both pages, in this version and in the other one (it is the same line on both platforms).
    const hint = welcome.getByTestId("welcome-licence-hint");
    await expect(hint).toHaveText(`${words.en.licenceHint} · ${words.en.licenceLink}`);
    await welcome.getByRole("button", { name: "Next" }).click();
    const second = page.getByRole("dialog", { name: "How do you want to start?" });
    await expect(second.getByTestId("welcome-licence-hint")).toBeVisible();

    await second.getByRole("button", { name: words.en.licenceLink }).click();
    const about = dialogOf(page, "en");
    await expect(about).toBeVisible();
    await expect(page.getByTestId("about-tab-licenses")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("about-licence-detail")).toHaveAttribute("data-item", "halfcube");
    await expect(about.getByRole("heading", { name: "HalfCube", exact: true })).toBeVisible();
    const query = new URL(page.url()).searchParams;
    expect(query.get("about")).toBe("licenses");
    expect(query.get("item")).toBe("halfcube");

    // The welcome screen stays underneath: Esc closes only the view on top.
    await page.keyboard.press("Escape");
    await expect(about).toHaveCount(0);
    await expect(second).toBeVisible();
    expect(new URL(page.url()).searchParams.has("about")).toBe(false);
  });

  test("the welcome screen shows the hint in German too", async ({ app }) => {
    const { page } = app;
    await app.open("?lang=de");
    const welcome = page.getByRole("dialog", { name: "Erst skizzieren, dann bauen" });
    await expect(welcome).toBeVisible({ timeout: 60_000 });
    await expect(welcome.getByTestId("welcome-licence-hint")).toHaveText(`${words.de.licenceHint} · ${words.de.licenceLink}`);
  });
});

test.describe("About HalfCube: closing and keyboard", () => {
  test("Esc and the red close button close it; Tab stays inside; the close button has a 48 px target and a name", async ({ app }) => {
    const { page } = app;
    await openAbout(app, "en");
    const dialog = dialogOf(page, "en");
    await expect(dialog).toHaveAttribute("aria-modal", "true");

    // The keyboard starts on the active tab, and Tab never leaves the view.
    await expect(page.getByTestId("about-tab-info")).toBeFocused();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("[data-testid='about-dialog']"))).toBe(true);
    }
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("[data-testid='about-dialog']"))).toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has("about")).toBe(false);
    expect(new URL(page.url()).searchParams.has("item")).toBe(false);

    // The close button: named, 30 px drawn, 48 px to hit (the invisible area left of the drawn button counts).
    await page.getByTestId("status-early").click();
    await expect(dialog).toBeVisible();
    const close = page.getByRole("button", { name: words.en.close });
    await expect(close).toBeVisible();
    const b = await box(page, "about-close");
    expect(b.width).toBe(30);
    expect(b.height).toBe(30);
    await page.mouse.click(b.x + 15 - 21, b.y + 15 + 4);
    await expect(dialog).toHaveCount(0);

    await page.getByTestId("status-early").click();
    await page.getByRole("button", { name: words.en.close }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("the focus returns to the label that opened it", async ({ app }) => {
    const { page } = app;
    await openMain(app, "en");
    await page.getByTestId("status-early").click();
    await expect(dialogOf(page, "en")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialogOf(page, "en")).toHaveCount(0);
    await expect(page.getByTestId("status-early")).toBeFocused();
  });
});

test.describe("About HalfCube: layout", () => {
  for (const lang of ["de", "en"] as const) {
    test(`Info and Lizenzen have exactly the same height, and the credit line meets the last row (${lang})`, async ({ app }) => {
      const { page } = app;
      await openAbout(app, lang);
      await page.evaluate(async () => document.fonts.ready);

      const infoDialog = await box(page, "about-dialog");
      const info = await box(page, "about-info");
      await page.getByTestId("about-tab-licenses").click();
      await expect(page.getByTestId("about-licences-list")).toBeVisible();
      const licencesDialog = await box(page, "about-dialog");
      const licences = await box(page, "about-licences-pane");
      expect(licences.height).toBe(info.height);
      expect(licences.width).toBe(info.width);
      expect(licences.y).toBe(info.y);
      expect(licencesDialog).toEqual(infoDialog);

      // The detail page of a component and the way back change nothing either.
      await page.getByTestId("licence-row-occt").click();
      await expect(page.getByTestId("about-licence-detail")).toBeVisible();
      expect(await box(page, "about-dialog")).toEqual(infoDialog);
      expect((await box(page, "about-licences-pane")).height).toBe(info.height);
      await page.getByTestId("about-back").click();
      await expect(page.getByTestId("about-licences-list")).toBeVisible();
      expect(await box(page, "about-dialog")).toEqual(infoDialog);

      // The dialog sits fully inside the window.
      const view = page.viewportSize() ?? (await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })));
      expect(infoDialog.x).toBeGreaterThanOrEqual(0);
      expect(infoDialog.y + infoDialog.height).toBeLessThanOrEqual(view.height);
      expect(infoDialog.x + infoDialog.width).toBeLessThanOrEqual(view.width);

      // "Mit ♥ gemacht" ends on the line of the last row of the right column ("Copy version"): 1 px at most.
      await page.getByTestId("about-tab-info").click();
      const lines = await page.evaluate(() => {
        const firstText = (root: Element): Text | null => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const parent = (n as Text).parentElement;
            if ((n.textContent ?? "").trim() !== "" && parent && getComputedStyle(parent).visibility !== "hidden") return n as Text;
          }
          return null;
        };
        const rectOf = (node: Text) => {
          const r = document.createRange();
          r.selectNodeContents(node);
          const b = r.getBoundingClientRect();
          return { top: b.top, bottom: b.bottom, height: b.height };
        };
        const credit = firstText(document.querySelector("[data-testid='about-credit']") as Element);
        const last = firstText(document.querySelector("[data-testid='about-copy-version']") as Element);
        if (!credit || !last) throw new Error("no text found for the credit line or the last row");
        return { credit: rectOf(credit), last: rectOf(last) };
      });
      expect(Math.abs(lines.credit.bottom - lines.last.bottom), `credit line bottom ${lines.credit.bottom} vs last row ${lines.last.bottom}`).toBeLessThanOrEqual(1);
      expect(Math.abs(lines.credit.top - lines.last.top)).toBeLessThanOrEqual(1);
    });
  }

  test("'Copied' moves nothing", { tag: "@clipboard" }, async ({ app }) => {
    const { page } = app;
    await openAbout(app, "en");
    const targets: Targets = {
      dialog: page.getByTestId("about-dialog"),
      strip: page.getByTestId("about-strip"),
      summary: page.getByTestId("about-licence-summary"),
      tech: page.getByTestId("about-tech"),
      copy: page.getByTestId("about-copy-version"),
      credit: page.getByTestId("about-credit"),
      tabInfo: page.getByTestId("about-tab-info"),
    };
    const before = await snapshot(page, targets);
    const button = page.getByTestId("about-copy-version").getByRole("button");
    await button.click();
    await expect(button).toHaveAttribute("data-copy-state", "copied");
    await expect(page.getByTestId("about-copy-version").getByRole("status")).toHaveText(words.en.copied);
    const during = await snapshot(page, targets);
    expectNothingMoved(before, during, "after copying the version");
    expect(await app.readClipboard()).toMatch(/^HalfCube v\d{4}\.\d+\.\d+\.\d+\.\d+ \(.*\)( · Electron [\d.]+)?( · OCCT [\d.]+)?$/);
    await expect(button).toHaveAttribute("data-copy-state", "idle", { timeout: 5000 });
    expectNothingMoved(before, await snapshot(page, targets), "after the confirmation went away");
  });
});

test.describe("About HalfCube: smallest window", () => {
  for (const lang of ["de", "en"] as const) {
    test(`fits completely into the smallest window the program allows, 960 x 600 (${lang})`, async ({ app }) => {
      const { page } = app;
      await openAbout(app, lang);
      if (app.electron) {
        await app.electron.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          if (!win) throw new Error("The program has no window.");
          win.setContentSize(960, 600);
        });
      } else {
        await page.setViewportSize({ width: 960, height: 600 });
      }
      await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeLessThanOrEqual(600);
      const view = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      const dialog = await box(page, "about-dialog");
      expect(dialog.x).toBeGreaterThanOrEqual(0);
      expect(dialog.x + dialog.width).toBeLessThanOrEqual(view.width);
      expect(dialog.y).toBeGreaterThanOrEqual(0);
      expect(dialog.y + dialog.height, `dialog ${dialog.height} px high in a window ${view.height} px high`).toBeLessThanOrEqual(view.height);
      // Nothing of the Info tab is cut off either: the last row (copy button) is inside the window.
      const last = await box(page, "about-copy-version");
      expect(last.y + last.height).toBeLessThanOrEqual(view.height);
    });
  }
});

test.describe("About HalfCube: contents", () => {
  test("the brand strip shows the real logo, the wordmark, version with channel, labels, copyright and credit", async ({ app }) => {
    const { page } = app;
    await openAbout(app, "de");
    const strip = page.getByTestId("about-strip");
    await expect(strip.locator("img")).toHaveCount(1);
    await expect(strip.locator("img")).toHaveJSProperty("complete", true);
    expect(await strip.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100);
    await expect(strip.getByRole("img", { name: "HalfCube" })).toBeVisible();
    await expect(page.getByTestId("about-version")).toHaveText(/^v\d{4}\.\d+\.\d+\.\d+\.\d+ \(<\/>\)$/);
    await expect(page.getByTestId("about-channel")).toHaveText("Dev");
    await expect(page.getByTestId("about-early")).toHaveText("Frühphase");
    await expect(page.getByTestId("about-copyright")).toHaveText("© 2026 SushiFlux");
    await expect(page.getByTestId("about-credit")).toHaveText("Mit ♥ gemacht");
    // The Info tab holds the version only once (in the strip).
    await app.open("?screen=main&lang=en&about=info");
    await expect(page.getByTestId("about-credit")).toHaveText("Made with ♥", { timeout: 60_000 });
  });

  for (const lang of ["de", "en"] as const) {
    test(`the Info tab: early-access note, the exact licence text, the links, the LGPL line, no "What's new" (${lang})`, async ({ app }) => {
      const { page } = app;
      await openAbout(app, lang);
      const dialog = dialogOf(page, lang);
      const summary =
        lang === "de"
          ? "HalfCube wird unter der PolyForm Shield License 1.0.0 bereitgestellt. Sie erlaubt die kostenlose Nutzung, privat und geschäftlich, sowie Änderungen für den eigenen Gebrauch. Ausgenommen ist das Anbieten von Produkten, die mit HalfCube im Wettbewerb stehen. Ohne Gewährleistung."
          : "HalfCube is provided under the PolyForm Shield License 1.0.0. It permits free use, private and commercial, and changes for your own use. Offering products that compete with HalfCube is excluded. No warranty.";
      await expect(page.getByTestId("about-licence-summary")).toHaveText(summary);
      await expect(dialog.getByText(words[lang].news)).toHaveCount(0);

      // LGPL-2.1 section 6: one calm line names the LGPL components with their copyright and points to the licences.
      const lgpl = page.getByTestId("about-lgpl");
      await expect(lgpl).toBeVisible();
      await expect(lgpl).toContainText("Open CASCADE Technology");
      await expect(lgpl).toContainText("planegcs");
      await expect(lgpl).toContainText("©");
      await expect(lgpl).toContainText("LGPL-2.1");
      await page.getByTestId("about-lgpl-link").click();
      await expect(page.getByTestId("about-tab-licenses")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("about-licences-list")).toBeVisible();
    });
  }

  test("'Show licence text' and 'View NOTICE file' open the detail inside the Lizenzen tab", async ({ app }) => {
    const { page } = app;
    await openAbout(app, "en");
    await page.getByTestId("about-show-licence").click();
    await expect(page.getByTestId("about-licence-detail")).toHaveAttribute("data-item", "halfcube");
    await expect(page.getByTestId("licence-text")).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("licence-text")).toContainText("PolyForm Shield License 1.0.0");
    expect(new URL(page.url()).searchParams.get("item")).toBe("halfcube");

    await page.getByTestId("about-tab-info").click();
    expect(new URL(page.url()).searchParams.get("about")).toBe("info");
    expect(new URL(page.url()).searchParams.has("item")).toBe(false);
    await page.getByTestId("about-show-notice").click();
    await expect(page.getByTestId("about-licence-detail")).toHaveAttribute("data-item", "notice");
    await expect(page.getByTestId("licence-text")).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("licence-text")).toContainText("Required Notice");
  });

  test("the source link opens outside the window: a new tab in the browser, the system browser through the main process on the desktop", async ({ app }) => {
    const { page } = app;
    await stubOpeners(app);
    await openAbout(app, "en");
    const link = page.getByTestId("about-source");
    await expect(link).toHaveAttribute("href", "https://github.com/sushiflux/HalfCube");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
    if (app.target !== "electron") return;

    const before = page.url();
    const windows = app.electron ? app.electron.windows().length : 0;
    await link.click();
    await expect.poll(() => opened(app)).toEqual(["external:https://github.com/sushiflux/HalfCube"]);
    expect(page.url()).toBe(before);
    expect(app.electron?.windows().length).toBe(windows);
    await expect(dialogOf(page, "en")).toBeVisible();

    // The main process never opens anything but plain https addresses, whatever the page asks.
    const refused = await page.evaluate(async () => {
      const bridge = (window as unknown as { desktopBridge: { openExternal(url: string): Promise<{ ok: boolean; message?: string }> } }).desktopBridge;
      return [await bridge.openExternal("http://example.com/"), await bridge.openExternal("file:///C:/Windows/notepad.exe"), await bridge.openExternal("javascript:alert(1)")];
    });
    expect(refused.map((r) => r.ok)).toEqual([false, false, false]);
    expect(await opened(app)).toEqual(["external:https://github.com/sushiflux/HalfCube"]);
  });

  test("technical details: the geometry kernel always, Electron only in the desktop program", async ({ app }) => {
    const { page } = app;
    await openAbout(app, "en");
    await expect(page.getByTestId("about-kernel")).toHaveText(/^OCCT \d+\.\d+\.\d+$/);
    if (app.target === "electron") {
      const expected = await page.evaluate(() => (window as unknown as { desktopBridge: { versions: { electron: string } } }).desktopBridge.versions.electron);
      await expect(page.getByTestId("about-electron")).toHaveText(expected);
    } else {
      await expect(page.getByTestId("about-electron")).toHaveCount(0);
    }
  });
});

test.describe("About HalfCube: licences", () => {
  test("the list is grouped, the browser leaves out the desktop-only entries, the desktop shows them", async ({ app }) => {
    const { page } = app;
    await openAbout(app, "en", "about=licenses");
    await expect(page.getByTestId("about-licences-list")).toBeVisible();
    await expect(page.getByTestId("about-group-self")).toBeVisible();
    await expect(page.getByTestId("licence-row-halfcube")).toBeVisible();
    await expect(page.getByTestId("licence-row-notice")).toBeVisible();
    await expect(page.getByTestId("about-group-engine")).toBeVisible();
    await expect(page.getByTestId("licence-row-occt")).toBeVisible();
    await expect(page.getByTestId("about-group-ui")).toBeVisible();
    const order = await page.locator("[data-testid^='about-group-']").evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
    const expectedOrder = app.target === "electron" ? ["about-group-self", "about-group-engine", "about-group-ui", "about-group-shell"] : ["about-group-self", "about-group-engine", "about-group-ui"];
    expect(order).toEqual(expectedOrder);

    if (app.target === "electron") {
      await expect(page.getByTestId("licence-row-electron")).toBeVisible();
      await expect(page.getByTestId("licence-row-chromium")).toBeVisible();
    } else {
      await expect(page.getByTestId("about-group-shell")).toHaveCount(0);
      await expect(page.getByTestId("licence-row-electron")).toHaveCount(0);
      await expect(page.getByTestId("licence-row-chromium")).toHaveCount(0);
      // An address that names a desktop-only entry shows the list instead.
      await app.open("?screen=main&lang=en&about=licenses&item=electron");
      await expect(page.getByTestId("about-licences-list")).toBeVisible({ timeout: 60_000 });
    }
  });

  test("the search narrows the list and moves nothing", async ({ app }) => {
    const { page } = app;
    await openAbout(app, "en", "about=licenses");
    const targets: Targets = {
      dialog: page.getByTestId("about-dialog"),
      strip: page.getByTestId("about-strip"),
      panes: page.getByTestId("about-licences-pane"),
      search: page.getByTestId("about-search"),
      tabs: page.getByTestId("about-tab-licenses"),
    };
    const before = await snapshot(page, targets);
    const rows = page.locator("[data-testid^='licence-row-']");
    const all = await rows.count();
    expect(all).toBeGreaterThan(3);

    await page.getByTestId("about-search").fill("cascade");
    await expect(rows).toHaveCount(1);
    await expect(page.getByTestId("licence-row-occt")).toBeVisible();
    expectNothingMoved(before, await snapshot(page, targets), "a search with one hit");

    await page.getByTestId("about-search").fill("zzzzqqq");
    await expect(rows).toHaveCount(0);
    await expect(page.getByTestId("about-search-none")).toHaveText("No component matches “zzzzqqq”.");
    expectNothingMoved(before, await snapshot(page, targets), "a search without a hit");

    await page.getByTestId("about-search-clear").click();
    await expect(page.getByTestId("about-search")).toHaveValue("");
    await expect(page.getByTestId("about-search")).toBeFocused();
    await expect(rows).toHaveCount(all);
    expectNothingMoved(before, await snapshot(page, targets), "a cleared search");
  });

  test("a component's page shows licence, copyright, source and the full licence text; back returns to the list", async ({ app }) => {
    const { page } = app;
    await openAbout(app, "en", "about=licenses");
    await page.getByTestId("licence-row-occt").click();
    const detail = page.getByTestId("about-licence-detail");
    await expect(detail).toHaveAttribute("data-item", "occt");
    await expect(detail.getByRole("heading", { name: /Open CASCADE/ })).toBeVisible();
    await expect(detail.getByText("Licence", { exact: true })).toBeVisible();
    await expect(detail.getByText("Copyright notice", { exact: true })).toBeVisible();
    await expect(detail.getByText("Source", { exact: true })).toBeVisible();
    await expect(detail.getByText(/OPEN CASCADE/i).first()).toBeVisible();
    const text = page.getByTestId("licence-text");
    await expect(text).toHaveAttribute("data-state", "ready");
    expect((await text.innerText()).length).toBeGreaterThan(500);
    await expect(text).toContainText(/GNU|Lesser|LGPL/i);

    await page.getByTestId("about-back").click();
    await expect(page.getByTestId("about-licences-list")).toBeVisible();
    expect(new URL(page.url()).searchParams.has("item")).toBe(false);
    expect(new URL(page.url()).searchParams.get("about")).toBe("licenses");
  });

  test("a licence text that cannot be loaded says what failed and can be copied", async ({ app }) => {
    const { page } = app;
    // Only meaningful where the page can be intercepted (the browser); the desktop serves the same files through its own protocol.
    test.skip(app.target === "electron", "the browser target can intercept the request");
    await page.route("**/licenses/occt.txt", (route) => route.fulfill({ status: 404, body: "gone" }));
    await openAbout(app, "en", "about=licenses&item=occt");
    const text = page.getByTestId("licence-text");
    await expect(text).toHaveAttribute("data-state", "failed");
    await expect(text).toContainText("The licence text could not be loaded: licenses/occt.txt: HTTP 404");
    await expect(text.getByRole("button", { name: "Copy" })).toBeVisible();
  });

  test("Chromium on the desktop opens Electron's own licence file through the main process", async ({ app }) => {
    test.skip(app.target !== "electron", "Chromium is a desktop entry");
    const { page } = app;
    await stubOpeners(app);
    await openAbout(app, "en", "about=licenses&item=chromium");
    const text = page.getByTestId("licence-text");
    // With a text file in the data the text itself is shown; without one the licence file of Electron is offered.
    const state = await text.getAttribute("data-state");
    if (state === "chromium") {
      await page.getByTestId("open-chromium-licences").click();
      await expect.poll(async () => (await opened(app)).length).toBe(1);
      expect((await opened(app))[0]).toMatch(/^path:.*LICENSES\.chromium\.html$/);
    } else {
      expect(state).toBe("ready");
    }
  });

  test("the browser has no Chromium entry to open", async ({ app }) => {
    test.skip(app.target !== "browser", "browser only");
    await openAbout(app, "en", "about=licenses");
    await expect(app.page.getByTestId("licence-row-chromium")).toHaveCount(0);
  });
});

test.describe("About HalfCube: reload", () => {
  test("a reload keeps the Info tab, the Lizenzen list and a component's page, in the address", async ({ app }) => {
    const { page } = app;
    await openAbout(app, "en");
    await page.getByTestId("about-tab-licenses").click();
    await page.getByTestId("licence-row-occt").click();
    await expect(page.getByTestId("about-licence-detail")).toHaveAttribute("data-item", "occt");
    expect(new URL(page.url()).search).toContain("about=licenses");
    expect(new URL(page.url()).search).toContain("item=occt");

    await page.reload();
    await expect(page.getByRole("dialog", { name: "About HalfCube" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("about-licence-detail")).toHaveAttribute("data-item", "occt");
    await expect(page.getByTestId("licence-text")).toHaveAttribute("data-state", "ready");

    await page.getByTestId("about-back").click();
    await page.reload();
    await expect(page.getByRole("dialog", { name: "About HalfCube" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("about-licences-list")).toBeVisible();

    await page.getByTestId("about-tab-info").click();
    await page.reload();
    await expect(page.getByRole("dialog", { name: "About HalfCube" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("about-tab-info")).toHaveAttribute("aria-selected", "true");

    // Closed means closed: nothing of it comes back.
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(page.getByTestId("status-early")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("dialog", { name: "About HalfCube" })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Contrast of the whole view in every theme, light and dark: the real painted colours of every visible text, plus the UI parts.
// 4.5:1 for text and 3:1 for UI parts; High contrast text 7:1 and its UI parts 4.5:1 (the same targets as the main window).

const THEMES = ["praezision", "skizze", "graphit", "blaupause", "kontrast", "farbsicher", "daemmerung"] as const;
const MODES = ["light", "dark"] as const;

interface Pair {
  state: string;
  name: string;
  kind: "text" | "ui";
  ratio: number;
  foreground: string;
  background: string;
}

async function collectPairs(page: Page, state: string): Promise<Pair[]> {
  return page.evaluate((stateName): Pair[] => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d canvas");
    type Rgba = [number, number, number, number];
    const parse = (css: string): Rgba => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, (d[3] ?? 0) / 255];
    };
    const over = (top: Rgba, bottom: Rgba): Rgba => {
      const a = top[3] + bottom[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      const mix = (i: 0 | 1 | 2) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a;
      return [mix(0), mix(1), mix(2), a];
    };
    const dialog = document.querySelector("[data-testid='about-dialog']");
    const strip = document.querySelector("[data-testid='about-strip']");
    if (!dialog || !strip) throw new Error("the About view is not open");
    const root = getComputedStyle(document.documentElement);
    const token = (n: string) => root.getPropertyValue(n).trim();
    // The strip is a fixed dark surface painted by gradients (about.css): a glow (cyan at 24 % in the middle of an ellipse of 320 x 280 px,
    // gone at 70 % of its radius, centred at 40 % / 16 %), faint grid lines (counted twice where they cross, so the worst case) and a
    // vertical base from #0f2a3a to #09161f. The colour behind a point is worked out from that.
    const stripBackgroundAt = (el: Element): Rgba => {
      const box = strip.getBoundingClientRect();
      const at = el.getBoundingClientRect();
      const x = at.left + at.width / 2 - box.left;
      const y = at.top + at.height / 2 - box.top;
      const t = Math.min(1, Math.max(0, y / box.height));
      const top = parse("#0f2a3a");
      const bottom = parse("#09161f");
      const base: Rgba = [top[0] + (bottom[0] - top[0]) * t, top[1] + (bottom[1] - top[1]) * t, top[2] + (bottom[2] - top[2]) * t, 1];
      const d = Math.hypot((x - 0.4 * box.width) / 320, (y - 0.16 * box.height) / 280);
      const glow = over([76, 209, 224, 0.24 * Math.max(0, 1 - d / 0.7)], base);
      return over([143, 221, 232, 0.0975], glow);
    };
    const backgroundOf = (el: Element): Rgba => {
      let acc: Rgba = [0, 0, 0, 0];
      for (let node: Element | null = el; node; node = node.parentElement) {
        acc = over(acc, parse(getComputedStyle(node).backgroundColor));
        if (acc[3] >= 0.999) return acc;
        if (node === strip) return over(acc, stripBackgroundAt(el));
        // The dialog's own surface is the outline path of the notched frame (an SVG fill), not a CSS background.
        if (node === dialog) return over(acc, parse(token("--c-surface")));
      }
      return over(acc, [255, 255, 255, 1]);
    };
    const lum = (c: Rgba): number => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const ratio = (a: Rgba, b: Rgba): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const hex = (c: Rgba) => `#${[c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
    const out: Pair[] = [];
    const add = (name: string, kind: "text" | "ui", fgCss: string, bg: Rgba) => {
      const fg = over(parse(fgCss), bg);
      out.push({ state: stateName, name, kind, ratio: ratio(fg, bg), foreground: hex(fg), background: hex(bg) });
    };

    // Every visible text of the view.
    const seen = new Set<string>();
    for (const el of Array.from(dialog.querySelectorAll("*"))) {
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n.textContent ?? "").trim())
        .join(" ")
        .trim();
      if (own === "") continue;
      // The wordmark is a logotype, which the contrast rule leaves out (WCAG 1.4.3); its colours are fixed brand colours.
      if (el.closest("[role='img'][aria-label='HalfCube']")) continue;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (cs.visibility === "hidden" || cs.display === "none" || rect.width === 0 || rect.height === 0 || cs.clip === "rect(0px, 0px, 0px, 0px)") continue;
      const bg = backgroundOf(el);
      const name = `text "${own.slice(0, 34)}" (${el.tagName.toLowerCase()}${strip.contains(el) ? ", strip" : ""})`;
      const key = `${name}|${cs.color}|${hex(bg)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      add(name, "text", cs.color, bg);
    }

    const surface = parse(token("--c-surface"));
    const tablist = dialog.querySelector("[role='tablist']");
    if (tablist) add("tab bar frame", "ui", getComputedStyle(tablist).borderTopColor, surface);
    const searchBox = dialog.querySelector("[data-testid='about-search']")?.closest("label");
    if (searchBox) add("search field frame", "ui", getComputedStyle(searchBox).borderTopColor, surface);
    const placeholder = dialog.querySelector("[data-testid='about-search']");
    if (placeholder) add("search placeholder", "text", token("--c-muted"), backgroundOf(placeholder));
    const close = dialog.ownerDocument.querySelector("[data-testid='about-close']");
    if (close) {
      const fill = backgroundOf(close);
      add("close button fill against the dialog", "ui", hex(fill), surface);
      add("close icon on the red button", "ui", token("--c-on-destructive"), fill);
    }
    add("accent line (tab, note) against the surface", "ui", token("--c-primary"), surface);
    return out;
  }, state);
}

for (const theme of THEMES) {
  for (const mode of MODES) {
    test(`About HalfCube contrast: ${theme} ${mode}`, async ({ app }) => {
      const { page } = app;
      await app.open(`?screen=main&lang=en&theme=${theme}&mode=${mode}&about=info`);
      await expect(page.getByRole("dialog", { name: "About HalfCube" })).toBeVisible({ timeout: 60_000 });
      await page.evaluate(async () => document.fonts.ready);

      const pairs: Pair[] = [];
      pairs.push(...(await collectPairs(page, "info")));
      await page.getByTestId("about-tab-licenses").click();
      await expect(page.getByTestId("about-licences-list")).toBeVisible();
      pairs.push(...(await collectPairs(page, "list")));
      await page.getByTestId("licence-row-occt").click();
      await expect(page.getByTestId("licence-text")).toHaveAttribute("data-state", "ready");
      pairs.push(...(await collectPairs(page, "detail")));

      expect(pairs.filter((p) => p.kind === "text").length).toBeGreaterThan(30);
      const high = theme === "kontrast";
      const failures = pairs
        .filter((p) => p.ratio < (p.kind === "text" ? (high ? 7 : 4.5) : high ? 4.5 : 3))
        .map((p) => `[${p.state}] ${p.name}: ${p.ratio.toFixed(2)}:1 (${p.foreground} on ${p.background})`);
      expect(failures, `contrast in ${theme} ${mode}`).toEqual([]);
    });
  }
}
