// Captures the figures of the update chapters of the user manual (docs/handbuch/de and docs/handbuch/en, folder "bilder").
// Runs only when HALFCUBE_MANUAL_SHOTS is set (the value 1 writes into the manual folders, any other value is the target folder),
// and only in the browser project, which is the official Playwright Docker image:
//   HALFCUBE_MANUAL_SHOTS=1 npm run test:e2e -- manual-screenshots --project=browser
// The page looks as the installed Windows program on the Nightly channel (?updates-look=windows, dev builds only: version "(α)", desktop
// environment in the error text) and the demo shows a fixed check time (14:32).
// The states come from the dev-only demo updater (?updates-demo=..., app/src/updates/demo-bridge.ts), which shows made-up versions and
// texts only. Theme "Präzision", light, device scale 2, one image set per language with the UI in that language. Every figure shows
// only the part that is explained, with some surroundings; the first one carries a frame around the explained control.
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures.ts";
import { repoRoot, serverPort } from "../support/paths.ts";

const languages = ["de", "en"] as const;
type Lang = (typeof languages)[number];

const out = process.env.HALFCUBE_MANUAL_SHOTS;
const targetDir = (lang: Lang): string => (out === "1" ? join(repoRoot, "docs", "handbuch", lang, "bilder") : join(out ?? "", lang));

/** The frame colour of the marker; not a theme colour, so it stays visible on every surface. */
const MARK = "#F97316";

async function openMain(page: Page, origin: string, lang: Lang, search: string): Promise<void> {
  await page.goto(`${origin}/index.html?screen=main&lang=${lang}&theme=praezision&mode=light&updates-look=windows&${search}`);
  await expect(page.getByTestId("loading-screen")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("status-early")).toBeVisible({ timeout: 30_000 });
  await page.mouse.move(2, 2);
}

/** A screenshot of `target` plus `pad` CSS pixels on every side (the surroundings that show where the thing sits). */
async function around(page: Page, target: Locator, pad: number): Promise<Buffer> {
  const box = await target.boundingBox();
  if (!box) throw new Error("The element to capture has no box.");
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  return page.screenshot({ clip: { x, y, width: Math.min(vp.width - x, box.width + 2 * pad), height: Math.min(vp.height - y, box.height + 2 * pad) } });
}

/** Draws a rounded frame around `target` (above everything, no pointer events) and returns the function that removes it. */
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

/** Puts PNG images next to each other (row) or below each other (column) on a plain page of the same theme and shoots it. */
async function compose(context: BrowserContext, images: Buffer[], direction: "row" | "column", gap: number): Promise<Buffer> {
  const page = await context.newPage();
  const imgs = images.map((b) => `<img src="data:image/png;base64,${b.toString("base64")}">`).join("");
  await page.setContent(
    `<body style="margin:0"><div id="c" style="display:inline-flex;flex-direction:${direction};gap:${gap}px;padding:${gap}px;background:#fff;align-items:flex-start">${imgs}</div></body>`,
  );
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  // The images are device-scale 2 bitmaps; shown at half their pixel size they match the page again.
  await page.evaluate(() => {
    for (const i of document.images) i.style.width = `${i.naturalWidth / 2}px`;
  });
  const shot = await page.locator("#c").screenshot();
  await page.close();
  return shot;
}

test.describe("manual figures: updates", () => {
  test.skip(out === undefined || out === "", "only when HALFCUBE_MANUAL_SHOTS is set");
  test.setTimeout(240_000);

  for (const lang of languages) {
    test(`figures of the update chapters (${lang})`, async ({ browserHandle }) => {
      if (!browserHandle) throw new Error("No browser.");
      const dir = targetDir(lang);
      mkdirSync(dir, { recursive: true });
      const origin = `http://${browserHandle.mode === "docker" ? "localhost" : "127.0.0.1"}:${serverPort}`;
      const context = await browserHandle.browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        locale: lang === "de" ? "de-DE" : "en-US",
        colorScheme: "light",
        reducedMotion: "reduce",
        permissions: ["clipboard-read", "clipboard-write"],
      });
      // Automatic checks off, so the demo state under test is not replaced by a check at the start.
      await context.addInitScript(() => localStorage.setItem("halfcube.settings.updateCheck", "manual"));
      const page = await context.newPage();
      const save = (name: string, body: Buffer) => writeFileSync(join(dir, `${name}.png`), body);
      const settle = () => page.waitForTimeout(500);
      const icon = page.getByTestId("about-button");

      try {
        // Figure 1: the dot on the "i", framed, with the neighbouring buttons of the title bar.
        await openMain(page, origin, lang, "updates-demo=found&updates-auto=off");
        await expect(icon).toHaveAttribute("data-update-icon", "found");
        await settle();
        await frame(page, icon);
        const ib = (await icon.boundingBox())!;
        save(
          "update-info-punkt",
          await page.screenshot({ clip: { x: ib.x - 150, y: Math.max(0, ib.y - 14), width: 150 + ib.width + 90, height: ib.height + 28 } }),
        );

        // Figure 2: the marks of all states in a row (found, downloading, ready, on exit, failed).
        const marks: Buffer[] = [];
        for (const [search, state] of [
          ["updates-demo=found&updates-auto=off", "found"],
          ["updates-demo=dl", "dl"],
          ["updates-demo=ready", "ready"],
          ["updates-demo=exit", "exit"],
          ["updates-demo=faildl", "failed"],
        ] as const) {
          await openMain(page, origin, lang, search);
          await expect(icon).toHaveAttribute("data-update-icon", state);
          await settle();
          marks.push(await around(page, icon, 8));
        }
        save("update-info-zustaende", await compose(context, marks, "row", 14));

        // Figure 3: the update slot in "About HalfCube" in four states, one below the other.
        const slots: Buffer[] = [];
        for (const [search, state] of [
          ["updates-demo=found&updates-auto=off", "found"],
          ["updates-demo=dl", "dl"],
          ["updates-demo=ready", "ready"],
          ["updates-demo=faildl", "faildl"],
        ] as const) {
          await openMain(page, origin, lang, `${search}&about=info`);
          const slot = page.getByTestId("update-slot");
          await expect(slot).toHaveAttribute("data-slot", state, { timeout: 20_000 });
          await settle();
          slots.push(await around(page, slot, 6));
        }
        save("update-karte-zustaende", await compose(context, slots, "column", 14));

        // Figure 4: settings, tab "Updates", with the default "at every start" (its own page: the other figures run with checks off).
        const settingsPage = await context.newPage();
        await settingsPage.addInitScript(() => localStorage.setItem("halfcube.settings.updateCheck", "start"));
        await openMain(settingsPage, origin, lang, "updates-demo=uptodate&settings=updates");
        await expect(settingsPage.getByTestId("settings-tab-updates")).toHaveAttribute("aria-selected", "true");
        await expect(settingsPage.getByTestId("settings-version")).toBeVisible();
        await expect(settingsPage.getByTestId("settings-result")).toBeVisible({ timeout: 20_000 }).catch(() => undefined);
        await settingsPage.waitForTimeout(800);
        await settingsPage.mouse.move(2, 2);
        save("update-einstellungen", await around(settingsPage, settingsPage.getByRole("dialog"), 14));
        await settingsPage.close();

        // Figure 5: the update window (installed and new version, size, skipped versions, new features).
        await openMain(page, origin, lang, "updates-demo=ready&update=window");
        await expect(page.getByTestId("update-window")).toBeVisible();
        await settle();
        save("update-fenster", await around(page, page.getByTestId("update-window"), 14));

        // Figure 6: the restart warning (needs a design with steps).
        await openMain(page, origin, lang, "updates-demo=ready");
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
        await settle();
        await page.mouse.move(2, 2);
        save("update-neustart-warnung", await around(page, page.getByRole("alertdialog"), 14));

        // Figure 7: the complete error message of a failed download ("Details").
        await openMain(page, origin, lang, "updates-demo=faildl&about=info");
        await page.getByTestId("update-slot-details").click();
        await expect(page.getByTestId("update-window").getByRole("alert")).toBeVisible();
        await settle();
        await page.mouse.move(2, 2);
        save("update-fehler-details", await around(page, page.getByTestId("update-window"), 14));

        // Figure 8: "What's new", opened by itself on the first start after an update.
        await openMain(page, origin, lang, "updates-demo=news");
        await expect(page.getByTestId("news-window")).toBeVisible({ timeout: 20_000 });
        await settle();
        await page.mouse.move(2, 2);
        save("update-was-ist-neu", await around(page, page.getByTestId("news-window"), 14));

        // Figure 9: "Alle Änderungen", the complete changelog of the channel in the app (opened from "Was ist neu").
        await page.getByTestId("all-changes-link").click();
        await expect(page.getByTestId("changes-window")).toBeVisible();
        await settle();
        await page.mouse.move(2, 2);
        save("update-alle-aenderungen", await around(page, page.getByTestId("changes-window"), 14));
      } finally {
        await context.close();
      }
    });
  }
});
