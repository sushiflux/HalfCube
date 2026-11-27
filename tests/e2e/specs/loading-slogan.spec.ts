// The slogan under the wordmark of the loading screen: English in both UI languages, readable, with its own room, and nothing
// else on the screen moves between the loading states (progress running, error shown).
// HALFCUBE_SLOGAN_SHOTS names a folder for light/dark screenshots (Electron project only).
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures.ts";

const slogan = "Sketch first, then build.";
const parts = ["logo", "word", "slogan", "tag", "slot"] as const;
const selectors: Record<(typeof parts)[number], string> = {
  logo: ".hc-logo",
  word: ".hc-word",
  slogan: '[data-testid="loading-slogan"]',
  tag: ".hc-tag",
  slot: ".hc-slot",
};

async function layout(page: Page) {
  return page.evaluate((sel) => {
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
    for (const [name, css] of Object.entries(sel)) {
      const r = document.querySelector(css)!.getBoundingClientRect();
      out[name] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }
    return out;
  }, selectors);
}

for (const lang of ["de", "en"] as const) {
  test(`the loading screen shows the English slogan in the ${lang} UI and nothing moves when the error appears`, async ({ app }) => {
    const { page } = app;
    // Running state first: the demo "start" shows the progress, then hands over, so measure right away.
    await app.open(`?demo=start&lang=${lang}&theme=praezision&mode=light`);
    const mark = page.getByTestId("loading-slogan");
    await expect(mark).toBeVisible({ timeout: 60_000 });
    await expect(mark).toHaveText(slogan);
    const running = await layout(page);

    await app.open(`?demo=start-error&lang=${lang}&theme=praezision&mode=light`);
    await expect(page.getByTestId("loading-slogan")).toHaveText(slogan);
    await expect(page.locator(".hc-slot-error")).toBeVisible({ timeout: 60_000 });
    const failed = await layout(page);

    for (const part of parts) {
      expect(failed[part], `${part} stays where it was`).toEqual(running[part]);
    }
    // Own room: the lines follow each other without overlap.
    expect(failed.word!.y + failed.word!.h).toBeLessThanOrEqual(failed.slogan!.y + 2);
    expect(failed.slogan!.y + failed.slogan!.h).toBeLessThanOrEqual(failed.tag!.y);
    expect(failed.tag!.y + failed.tag!.h).toBeLessThanOrEqual(failed.slot!.y);
    // One line, centred.
    expect(failed.slogan!.h).toBeLessThanOrEqual(26);
    const size = await mark.evaluate((el) => getComputedStyle(el).fontSize);
    expect(size).toBe("16px");
  });
}

for (const mode of ["light", "dark"] as const) {
  test(`screenshot of the loading screen with the slogan (${mode})`, async ({ app }) => {
    test.skip(process.env.HALFCUBE_SLOGAN_SHOTS === undefined, "only when HALFCUBE_SLOGAN_SHOTS names a folder");
    const { page } = app;
    await app.open(`?demo=start-error&lang=de&theme=praezision&mode=${mode}`);
    await expect(page.locator(".hc-slot-error")).toBeVisible({ timeout: 60_000 });
    await page.mouse.move(2, 2);
    await page.screenshot({ path: `${process.env.HALFCUBE_SLOGAN_SHOTS}/ladebildschirm-slogan-${mode}.png` });
  });
}
