// Smoke: the program starts, shows its version and platform, and the engine reaches "ready" (the loading screen leaves
// and the welcome screen follows, no error card). Runs in the browser (WebAssembly engine in a Web Worker) and in the
// Electron program (native engine process).
import { expect, test } from "../support/fixtures.ts";
import { expectedVersionDisplay } from "../support/version.ts";

test("the app starts and shows its version and platform in the status bar", async ({ app }) => {
  const { page } = app;
  await app.open("?lang=en");
  await expect(page.getByTestId("version")).toHaveText(`HalfCube ${expectedVersionDisplay()}`);
  await expect(page.getByTestId("status-bar")).toHaveAttribute("data-platform", app.target === "electron" ? "desktop" : "browser");
  await expect(page).toHaveTitle("HalfCube");
});

test("the engine starts, passes its self-tests and the app moves on to the welcome screen", async ({ app }) => {
  const { page } = app;
  await app.open("?lang=en");

  // Ready means: the loading screen is gone and the welcome screen (the first thing after loading) is open.
  const welcome = page.getByRole("dialog", { name: "Sketch first, then build" });
  await expect(welcome).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("loading-screen")).toHaveCount(0);
  await expect(page.locator("[data-error-code]")).toHaveCount(0);
  expect(app.errors, "no console errors while starting").toEqual([]);
});
