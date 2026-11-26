// Headless screenshots of the wordmark in the title bar, on the welcome screen and in the "About HalfCube" view, light and dark.
// Runs only when HALFCUBE_WORDMARK_SHOTS names a target folder, and only in the Electron program.
import { expect, test } from "../support/fixtures.ts";

const modes = ["light", "dark"] as const;

for (const mode of modes) {
  test(`screenshots of the wordmark: title bar, welcome screen, About view (${mode})`, async ({ app }) => {
    test.skip(process.env.HALFCUBE_WORDMARK_SHOTS === undefined || app.target !== "electron", "only when HALFCUBE_WORDMARK_SHOTS names a folder, in the Electron project");
    const dir = process.env.HALFCUBE_WORDMARK_SHOTS!;
    const { page } = app;

    await app.open(`?lang=en&theme=praezision&mode=${mode}`);
    const welcome = page.getByRole("dialog", { name: "Sketch first, then build" });
    await expect(welcome).toBeVisible({ timeout: 60_000 });
    await page.mouse.move(2, 2);
    await page.screenshot({ path: `${dir}/willkommen-${mode}.png` });

    await app.open(`?screen=main&lang=de&theme=praezision&mode=${mode}`);
    await expect(page.getByTestId("loading-screen")).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId("status-early")).toBeVisible({ timeout: 30_000 });
    await page.mouse.move(2, 2);
    await page.screenshot({ path: `${dir}/titelleiste-${mode}.png`, clip: { x: 0, y: 0, width: 1000, height: 60 } });

    await app.open(`?screen=main&lang=de&theme=praezision&mode=${mode}&about=info`);
    const about = page.getByRole("dialog", { name: "Über HalfCube" });
    await expect(about).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("loading-screen")).toHaveCount(0);
    await page.mouse.move(2, 2);
    await expect(about).toBeVisible();
    await page.screenshot({ path: `${dir}/ueber-halfcube-${mode}.png` });
  });
}
