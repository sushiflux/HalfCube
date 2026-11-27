// The wordmark is drawn from the generated letter outlines (not typeset text) on every screen that shows it, in a line box
// of 1 em with the width of the outlines, so it sits where the typeset text sat and no font has to load first.
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures.ts";

const scenes: { name: string; search: string; wait?: (page: Page) => Promise<void>; small: boolean }[] = [
  { name: "loading screen", search: "?demo=start-error&lang=en&theme=praezision&mode=dark", small: false },
  { name: "welcome screen", search: "?lang=en&theme=praezision&mode=light", small: true },
  {
    name: "title bar",
    search: "?screen=main&lang=de&theme=praezision&mode=light",
    wait: async (page) => {
      await expect(page.getByTestId("loading-screen")).toHaveCount(0, { timeout: 60_000 });
      await expect(page.getByTestId("status-early")).toBeVisible({ timeout: 30_000 });
    },
    small: true,
  },
  {
    name: "About view",
    search: "?screen=main&lang=de&theme=praezision&mode=dark&about=info",
    wait: async (page) => {
      await expect(page.getByRole("dialog", { name: "Über HalfCube" })).toBeVisible({ timeout: 60_000 });
    },
    small: false,
  },
];

for (const scene of scenes) {
  test(`the wordmark on the ${scene.name} is the drawn outline in a 1 em box`, async ({ app }) => {
    const { page } = app;
    await app.open(scene.search);
    await scene.wait?.(page);
    const marks = page.locator('[data-wordmark][role="img"]');
    await expect(marks.last()).toBeVisible({ timeout: 60_000 });
    const mark = marks.last();
    await expect(mark).toHaveAttribute("aria-label", "HalfCube");
    await expect(mark).toHaveAttribute("data-wordmark", scene.small ? "small" : "large");
    const facts = await mark.evaluate((el) => {
      // The layout box, not the drawn box: dialogs scale in while they open and a transform would change the rectangle.
      const box = el as HTMLElement;
      return {
        paths: el.querySelectorAll("svg path").length,
        text: el.textContent,
        fontSize: parseFloat(getComputedStyle(el).fontSize),
        width: box.offsetWidth,
        height: box.offsetHeight,
      };
    });
    expect(facts.paths).toBe(2);
    expect(facts.text).toBe("");
    // offsetWidth and offsetHeight are whole pixels, so the checks allow one pixel.
    expect(Math.abs(facts.height - facts.fontSize)).toBeLessThanOrEqual(1);
    // Text width of "HalfCube" in Geist at this setting: 4.26 em large, 4.56 em small.
    expect(Math.abs(facts.width - facts.fontSize * (scene.small ? 4.563 : 4.268))).toBeLessThanOrEqual(1);
  });
}
