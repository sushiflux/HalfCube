// Welcome flow: appears on the first start, the "don't show again" checkbox survives a reload, the "not available"
// info dialog is our own dialog, Esc closes the top-most dialog only.
import { expect, test } from "../support/fixtures.ts";

const WELCOME_STORAGE_KEY = "halfcube.welcome.hidden";

test.describe("welcome screen", () => {
  test("appears on the first start, after the loading screen; no native dialogs are used", async ({ app }) => {
    const { page } = app;
    let nativeDialogs = 0;
    page.on("dialog", (dialog) => {
      nativeDialogs += 1;
      void dialog.dismiss();
    });
    await app.open("?lang=en");

    const welcome = page.getByRole("dialog", { name: "Sketch first, then build." });
    await expect(welcome).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("loading-screen")).toHaveCount(0);
    // Page 1: the keyboard focus is on the main control, the early-access note is there.
    await expect(welcome.getByRole("button", { name: "Next" })).toBeFocused();
    await expect(welcome.getByText("Early access.")).toBeVisible();
    expect(nativeDialogs).toBe(0);
  });

  test("the checkbox 'Don't show this at the next start' persists over a reload", async ({ app }) => {
    const { page } = app;
    await app.open("?lang=en");
    const welcome = page.getByRole("dialog", { name: "Sketch first, then build." });
    await expect(welcome).toBeVisible({ timeout: 60_000 });

    const checkbox = welcome.getByRole("checkbox", { name: "Don’t show this at the next start" });
    await expect(checkbox).not.toBeChecked();
    // The real input is visually hidden (the drawn box is the control): click what a user sees, the label.
    await welcome.getByText("Don’t show this at the next start").click();
    await expect(checkbox).toBeChecked();
    expect(await page.evaluate((key) => localStorage.getItem(key), WELCOME_STORAGE_KEY)).toBe("1");

    // Reload: the loading screen runs again, afterwards the welcome screen must stay away.
    await page.reload();
    await expect(page.getByTestId("loading-screen")).toBeVisible();
    await expect(page.getByTestId("loading-screen")).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId("version")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Un-ticking is remembered too: the welcome screen is back at the next start, with the box unticked.
    await page.evaluate((key) => localStorage.removeItem(key), WELCOME_STORAGE_KEY);
    await page.reload();
    const again = page.getByRole("dialog", { name: "Sketch first, then build." });
    await expect(again).toBeVisible({ timeout: 60_000 });
    await expect(again.getByRole("checkbox", { name: "Don’t show this at the next start" })).not.toBeChecked();
  });

  test("the checkbox is stored and removed again when it is ticked and unticked", async ({ app }) => {
    const { page } = app;
    await app.open("?demo=welcome&lang=en");
    const welcome = page.getByRole("dialog");
    const checkbox = welcome.getByRole("checkbox");
    await welcome.getByText("Don’t show this at the next start").click();
    await expect(checkbox).toBeChecked();
    expect(await page.evaluate((key) => localStorage.getItem(key), WELCOME_STORAGE_KEY)).toBe("1");
    await welcome.getByText("Don’t show this at the next start").click();
    await expect(checkbox).not.toBeChecked();
    expect(await page.evaluate((key) => localStorage.getItem(key), WELCOME_STORAGE_KEY)).toBeNull();
  });

  test("'Open a project' shows our own 'not available' dialog; Esc closes it first, then the welcome screen", async ({ app }) => {
    const { page } = app;
    let nativeDialogs = 0;
    page.on("dialog", (dialog) => {
      nativeDialogs += 1;
      void dialog.dismiss();
    });
    await app.open("?demo=welcome&lang=en");

    const welcome = page.getByRole("dialog", { name: "Sketch first, then build." });
    await expect(welcome).toBeVisible();
    await welcome.getByRole("button", { name: "Next" }).click();
    const second = page.getByRole("dialog", { name: "How do you want to start?" });
    await expect(second).toBeVisible();
    // Page 2: the focus moved to the first action.
    await expect(second.getByRole("button", { name: /New project/ })).toBeFocused();

    await second.getByRole("button", { name: /Open or import/ }).click();
    const info = page.getByRole("dialog", { name: "Not available yet" });
    await expect(info).toBeVisible();
    await expect(info).toContainText("Opening projects and importing files is not possible in this version yet.");
    await expect(info.getByRole("button")).toHaveText(["OK"]);

    // Esc closes the info dialog only; the welcome screen stays.
    await page.keyboard.press("Escape");
    await expect(info).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "How do you want to start?" })).toBeVisible();

    await page.getByRole("dialog", { name: "How do you want to start?" }).getByRole("button", { name: /Short tour/ }).click();
    await expect(page.getByRole("dialog", { name: "Not available yet" })).toContainText("The tour does not exist in this version yet.");
    await page.getByRole("dialog", { name: "Not available yet" }).getByRole("button", { name: "OK" }).click();
    await expect(page.getByRole("dialog", { name: "Not available yet" })).toHaveCount(0);

    // Esc on the welcome screen closes it.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(nativeDialogs, "window.alert/confirm/prompt must never be used").toBe(0);
    expect(app.errors).toEqual([]);
  });

  test("the close button and 'Skip' close the welcome screen", async ({ app }) => {
    const { page } = app;
    await app.open("?demo=welcome&lang=en");
    const welcome = page.getByRole("dialog", { name: "Sketch first, then build." });
    await welcome.getByRole("button", { name: "Skip" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await app.open("?demo=welcome&lang=en");
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("German: the welcome screen speaks German and the 'not available' dialog too", async ({ app }) => {
    const { page } = app;
    await app.open("?demo=welcome&lang=de");
    const welcome = page.getByRole("dialog", { name: "Sketch first, then build." });
    await expect(welcome).toBeVisible();
    await expect(welcome.getByText("Frühphase.")).toBeVisible();
    await welcome.getByRole("button", { name: "Weiter" }).click();
    await page.getByRole("dialog", { name: "Womit möchtest du anfangen?" }).getByRole("button", { name: /Öffnen oder importieren/ }).click();
    const info = page.getByRole("dialog", { name: "Noch nicht verfügbar" });
    await expect(info).toContainText("Projekte öffnen und Dateien importieren geht in dieser Version noch nicht");
    await info.getByRole("button", { name: "OK" }).click();
    await expect(info).toHaveCount(0);
  });
});
