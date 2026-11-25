// Crash page (?demo=crash throws on purpose while rendering): the diagnostic console of the dev build and the calm page of
// the other channels (?calm=1). Both are always English, have a copy button with the complete report and a reload button.
import { expect, test } from "../support/fixtures.ts";
import { expectNotTruncated, expectNothingMoved, snapshot, type Targets } from "../support/layout.ts";
import { NARROWEST_WIDTH } from "../support/paths.ts";
import { expectedVersionDisplay } from "../support/version.ts";

const MESSAGE = "Demo crash: this error was thrown on purpose while rendering to show the crash page.";

for (const lang of ["en", "de"] as const) {
  test(`dev build: the diagnostic console shows the error, stays English (lang=${lang}), copies the full report`, { tag: "@clipboard" }, async ({ app }) => {
    const { page } = app;
    await app.open(`?demo=crash&lang=${lang}`);

    const consoleView = page.getByTestId("crash-console");
    await expect(consoleView).toBeVisible();
    await expect(consoleView.getByRole("heading", { level: 1 })).toHaveText(`Error: ${MESSAGE}`);
    await expect(consoleView).toContainText(`dev build ${expectedVersionDisplay()}`);
    await expect(consoleView).toContainText("Thrown in");
    // The page behind is gone: a crash replaces the app, it does not float over it.
    await expect(page.getByTestId("version")).toHaveCount(0);

    // The four tabs, each shows content.
    const tabs = consoleView.getByRole("tab");
    await expect(tabs).toHaveCount(4);
    await expect(tabs.nth(0)).toHaveAccessibleName(/^Stack frames \(\d+\)$/);
    await expect(tabs.nth(1)).toHaveAccessibleName(/^Component stack \(\d+\)$/);
    await tabs.nth(2).click();
    await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
    await expect(consoleView.getByRole("tabpanel")).toContainText(app.target === "electron" ? "Electron" : "Mozilla");
    await tabs.nth(3).click();
    await expect(consoleView.getByRole("tabpanel")).toContainText(MESSAGE);

    // Copy: the complete report reaches the clipboard.
    const copy = consoleView.locator(".pcc-btn").filter({ hasText: "Copy details" });
    await copy.click();
    await expect(copy).toHaveAccessibleName("Copied");
    const report = await app.readClipboard();
    expect(report).toContain(MESSAGE);
    expect(report).toContain(expectedVersionDisplay());
    expect(report.split("\n").length, "the report has the stack too").toBeGreaterThan(5);
  });
}

test("dev build: Reload reloads the page", async ({ app }) => {
  const { page } = app;
  await app.open("?demo=crash&lang=en");
  await expect(page.getByTestId("crash-console")).toBeVisible();
  await page.evaluate(() => Reflect.set(window, "__beforeReload", true));
  await page.getByRole("button", { name: "Reload" }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__beforeReload"))).toBeUndefined();
  await expect(page.getByTestId("crash-console")).toBeVisible();
});

test("calm page of the other channels: concrete message, technical details unfold, nothing moves, copy works", { tag: "@clipboard" }, async ({ app }) => {
  const { page } = app;
  await app.open("?demo=crash&calm=1&lang=de");
  const innerWidth = await app.setWidth(NARROWEST_WIDTH);
  test.info().annotations.push({ type: "width", description: `window ${NARROWEST_WIDTH} px, page ${innerWidth} px` });

  const calm = page.getByTestId("crash-page");
  await expect(calm).toBeVisible();
  await expect(calm.getByRole("heading", { level: 1 })).toHaveText("Something went wrong");
  const message = calm.locator(".pcc-message");
  await expect(message).toHaveText(`Error: ${MESSAGE}`);
  await expectNotTruncated(message, "crash message");
  await expect(page.getByTestId("crash-console")).toHaveCount(0);

  const toggle = calm.getByRole("button", { name: /technical details/ });
  const copy = calm.locator(".pcc-btn").filter({ hasText: "Copy details" });
  const targets: Targets = {
    kicker: calm.locator(".pcc-kicker"),
    heading: calm.getByRole("heading", { level: 1 }),
    lead: calm.locator(".pcc-lead"),
    message,
    toggle,
    copy,
    reload: calm.getByRole("button", { name: "Reload" }),
  };
  const folded = await snapshot(page, targets);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAccessibleName("Show technical details");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveAccessibleName("Hide technical details");
  await expect(calm.locator(".pcc-details pre")).toContainText(MESSAGE);
  expectNothingMoved(folded, await snapshot(page, targets), "technical details unfold");

  await copy.click();
  await expect(copy).toHaveAccessibleName("Copied");
  expectNothingMoved(folded, await snapshot(page, targets), "'Copied' shows");
  const report = await app.readClipboard();
  expect(report).toContain(MESSAGE);
  expect(report).toContain(expectedVersionDisplay());
});
