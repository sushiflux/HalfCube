// Captures the figures of the update chapters of the user manual (docs/handbuch/de and docs/handbuch/en, folder "bilder").
// Runs only when HALFCUBE_MANUAL_SHOTS is set (the value 1 writes into the manual folders, any other value is the target folder):
//   HALFCUBE_MANUAL_SHOTS=1 npm run test:e2e -- manual-screenshots
// The program is the suite's Electron program (inactive window on the secondary monitor, no window of its own is opened): the figures
// are captured through the DevTools protocol with a device-metrics override of 1280 x 800 CSS pixels at scale 2, which is also why
// the composed figures are laid out inside the page itself instead of in a page of their own.
// The page looks as the installed Windows program on the Nightly channel (?updates-look=windows, dev builds only: version "(α)", desktop
// environment in the error text) and the demo shows a fixed check time (14:32).
// The states come from the dev-only demo updater (?updates-demo=..., app/src/updates/demo-bridge.ts), which shows made-up versions and
// texts only. Theme "Präzision", light, device scale 2, one image set per language with the UI in that language. Every figure shows
// only the part that is explained, with some surroundings; the first one carries a frame around the explained control.
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { CDPSession, Locator, Page } from "@playwright/test";
import { expect, test, type AppUnderTest } from "../support/fixtures.ts";
import { repoRoot } from "../support/paths.ts";

const languages = ["de", "en"] as const;
type Lang = (typeof languages)[number];

const out = process.env.HALFCUBE_MANUAL_SHOTS;
const targetDir = (lang: Lang): string => (out === "1" ? join(repoRoot, "docs", "handbuch", lang, "bilder") : join(out ?? "", lang));

/** The frame colour of the marker; not a theme colour, so it stays visible on every surface. */
const MARK = "#F97316";
const VIEWPORT = { width: 1280, height: 800 } as const;

/** What the program does before each page: the update-check setting named by `e2e-check` in the address ("manual" = automatic checks off). */
async function installCheckSetting(page: Page): Promise<void> {
  // The page is shared by the tests of a worker and an init script cannot be removed again, so it only acts on an address that asks for it.
  await page.addInitScript(() => {
    const wanted = /[?&]e2e-check=(\w+)/.exec(location.search)?.[1];
    if (wanted) localStorage.setItem("halfcube.settings.updateCheck", wanted);
  });
}

/** Opens the main window in `lang`, in the look of the manual, with the 1280 x 800 viewport at scale 2. */
async function openMain(app: AppUnderTest, cdp: CDPSession, lang: Lang, search: string, check: "manual" | "start" = "manual"): Promise<void> {
  const { page } = app;
  await app.open(`?screen=main&lang=${lang}&theme=praezision&mode=light&updates-look=windows&e2e-check=${check}&${search}`);
  await cdp.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 2, mobile: false });
  await expect(page.getByTestId("loading-screen")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("status-early")).toBeVisible({ timeout: 30_000 });
  await page.mouse.move(2, 2);
}

/** Waits until fonts are loaded and two frames were drawn, so dialogs and marks are in their final state. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))));
}

/** The picture of a rectangle of the page in device pixels (scale 2), through the DevTools protocol. */
async function capture(cdp: CDPSession, rect: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", clip: { ...rect, scale: 1 } });
  return Buffer.from(data, "base64");
}

/** A screenshot of `target` plus `pad` CSS pixels on every side (the surroundings that show where the thing sits). */
async function around(cdp: CDPSession, target: Locator, pad: number): Promise<Buffer> {
  const box = await target.boundingBox();
  if (!box) throw new Error("The element to capture has no box.");
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  return capture(cdp, { x, y, width: Math.min(VIEWPORT.width - x, box.width + 2 * pad), height: Math.min(VIEWPORT.height - y, box.height + 2 * pad) });
}

/** Draws a rounded frame around `target` (above everything, no pointer events); the next navigation removes it. */
async function frame(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("The element to mark has no box.");
  await page.evaluate(
    ({ b, color }) => {
      const el = document.createElement("div");
      el.id = "manual-shot-frame";
      el.style.cssText = `position:fixed;left:${b.x - 4}px;top:${b.y - 4}px;width:${b.width + 8}px;height:${b.height + 8}px;border:3px solid ${color};border-radius:10px;pointer-events:none;z-index:2147483647`;
      document.body.appendChild(el);
    },
    { b: box, color: MARK },
  );
}

/**
 * Puts PNG images next to each other (row) or below each other (column) on a white sheet laid over the page, and shoots the sheet.
 * Built with DOM calls (the page's content security policy allows no inline style attribute in markup); the next navigation removes it.
 */
async function compose(page: Page, cdp: CDPSession, images: Buffer[], direction: "row" | "column", gap: number): Promise<Buffer> {
  await page.evaluate(
    async ({ sources, direction: flow, gap: space }) => {
      const sheet = document.createElement("div");
      sheet.id = "manual-shot-sheet";
      Object.assign(sheet.style, { position: "fixed", left: "0", top: "0", zIndex: "2147483647", display: "inline-flex", flexDirection: flow, gap: `${space}px`, padding: `${space}px`, background: "#fff", alignItems: "flex-start" });
      const imgs = sources.map((src) => {
        const img = document.createElement("img");
        img.src = src;
        sheet.appendChild(img);
        return img;
      });
      document.body.appendChild(sheet);
      await Promise.all(imgs.map((i) => i.decode()));
      // The images are device-scale 2 bitmaps; shown at half their pixel size they match the page again.
      for (const i of imgs) i.style.width = `${i.naturalWidth / 2}px`;
    },
    { sources: images.map((b) => `data:image/png;base64,${b.toString("base64")}`), direction, gap },
  );
  const box = await page.locator("#manual-shot-sheet").boundingBox();
  if (!box) throw new Error("The composed sheet has no box.");
  if (box.width > VIEWPORT.width || box.height > VIEWPORT.height) throw new Error(`The composed sheet (${box.width} x ${box.height}) does not fit the ${VIEWPORT.width} x ${VIEWPORT.height} viewport.`);
  return capture(cdp, box);
}

test.describe("manual figures: updates", () => {
  test.skip(out === undefined || out === "", "only when HALFCUBE_MANUAL_SHOTS is set");
  test.setTimeout(240_000);

  for (const lang of languages) {
    test(`figures of the update chapters (${lang})`, async ({ app }) => {
      const { page } = app;
      const dir = targetDir(lang);
      mkdirSync(dir, { recursive: true });
      await installCheckSetting(page);
      const cdp = await page.context().newCDPSession(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      const save = (name: string, body: Buffer) => writeFileSync(join(dir, `${name}.png`), body);
      const icon = page.getByTestId("about-button");
      const open = (search: string, check: "manual" | "start" = "manual") => openMain(app, cdp, lang, search, check);

      try {
        // Figure 1: the dot on the "i", framed, with the neighbouring buttons of the title bar.
        await open("updates-demo=found&updates-auto=off");
        await expect(icon).toHaveAttribute("data-update-icon", "found");
        await settle(page);
        await frame(page, icon);
        const ib = (await icon.boundingBox())!;
        save("update-info-punkt", await capture(cdp, { x: ib.x - 150, y: Math.max(0, ib.y - 14), width: 150 + ib.width + 90, height: ib.height + 28 }));

        // Figure 2: the marks of all states in a row (found, downloading, ready, on exit, failed).
        const marks: Buffer[] = [];
        for (const [search, state] of [
          ["updates-demo=found&updates-auto=off", "found"],
          ["updates-demo=dl", "dl"],
          ["updates-demo=ready", "ready"],
          ["updates-demo=exit", "exit"],
          ["updates-demo=faildl", "failed"],
        ] as const) {
          await open(search);
          await expect(icon).toHaveAttribute("data-update-icon", state);
          await settle(page);
          marks.push(await around(cdp, icon, 8));
        }
        save("update-info-zustaende", await compose(page, cdp, marks, "row", 14));

        // Figure 3: the update slot in "About HalfCube" in four states, one below the other.
        const slots: Buffer[] = [];
        for (const [search, state] of [
          ["updates-demo=found&updates-auto=off", "found"],
          ["updates-demo=dl", "dl"],
          ["updates-demo=ready", "ready"],
          ["updates-demo=faildl", "faildl"],
        ] as const) {
          await open(`${search}&about=info`);
          const slot = page.getByTestId("update-slot");
          await expect(slot).toHaveAttribute("data-slot", state, { timeout: 20_000 });
          await settle(page);
          slots.push(await around(cdp, slot, 6));
        }
        save("update-karte-zustaende", await compose(page, cdp, slots, "column", 14));

        // Figure 4: settings, tab "Updates", with the default "at every start" (the other figures run with checks off).
        await open("updates-demo=uptodate&settings=updates", "start");
        await expect(page.getByTestId("settings-tab-updates")).toHaveAttribute("aria-selected", "true");
        await expect(page.getByTestId("settings-version")).toBeVisible();
        await expect(page.getByTestId("settings-result")).toBeVisible({ timeout: 20_000 });
        await settle(page);
        await page.mouse.move(2, 2);
        save("update-einstellungen", await around(cdp, page.getByRole("dialog"), 14));

        // Figure 5: the update window (installed and new version, size, skipped versions, new features).
        await open("updates-demo=ready&update=window");
        await expect(page.getByTestId("update-window")).toBeVisible();
        await settle(page);
        save("update-fenster", await around(cdp, page.getByTestId("update-window"), 14));

        // Figure 6: the restart warning (needs a design with steps).
        await open("updates-demo=ready");
        for (let i = 0; i < 2; i++) {
          await page.getByTestId("tool-sketch").click();
          await page.getByTestId("tree-row-plane:xy").click();
          await expect(page.getByTestId("finish-sketch")).toBeVisible({ timeout: 30_000 });
          await page.evaluate(() =>
            (window as unknown as { __halfcube: { editor: { addRectangle(a: unknown, b: unknown): Promise<unknown> } } }).__halfcube.editor.addRectangle({ x: 0, y: 0 }, { x: 40, y: 25 }),
          );
          await page.getByTestId("finish-sketch").click();
          await expect(page.getByTestId("tab-sketch")).toHaveCount(0);
        }
        await icon.click();
        await page.getByTestId("update-slot-restart").click();
        await expect(page.getByTestId("restart-warning")).toBeVisible();
        await settle(page);
        await page.mouse.move(2, 2);
        save("update-neustart-warnung", await around(cdp, page.getByRole("alertdialog"), 14));

        // Figure 7: the complete error message of a failed download ("Details").
        await open("updates-demo=faildl&about=info");
        await page.getByTestId("update-slot-details").click();
        await expect(page.getByTestId("update-window").getByRole("alert")).toBeVisible();
        await settle(page);
        await page.mouse.move(2, 2);
        save("update-fehler-details", await around(cdp, page.getByTestId("update-window"), 14));

        // Figure 8: "What's new", opened by itself on the first start after an update.
        await open("updates-demo=news");
        await expect(page.getByTestId("news-window")).toBeVisible({ timeout: 20_000 });
        await settle(page);
        await page.mouse.move(2, 2);
        save("update-was-ist-neu", await around(cdp, page.getByTestId("news-window"), 14));

        // Figure 9: "Alle Änderungen", the complete changelog of the channel in the app (opened from "Was ist neu").
        await page.getByTestId("all-changes-link").click();
        await expect(page.getByTestId("changes-window")).toBeVisible();
        await settle(page);
        await page.mouse.move(2, 2);
        save("update-alle-aenderungen", await around(cdp, page.getByTestId("changes-window"), 14));
      } finally {
        await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
        await cdp.detach().catch(() => undefined);
        await page.emulateMedia({ reducedMotion: null }).catch(() => undefined);
      }
    });
  }
});
