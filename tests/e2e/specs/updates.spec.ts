// The update function: the mark on the info icon, the update slot in "Über HalfCube", the update window, the restart warning, "Was ist
// neu", the settings tab "Updates", and a reload keeping every view. The states come from the dev-only demo updater
// (?updates-demo=found|dl|ready|exit|failed|faildl|uptodate|none|news, see app/src/updates/demo-bridge.ts); in the browser without that
// parameter there is no updater at all. Runs in the browser and in the Electron program (both are dev builds in the suite).
import type { Page } from "@playwright/test";
import { expect, test, type AppUnderTest } from "../support/fixtures.ts";
import { snapshot } from "../support/layout.ts";
import type { Lang } from "../support/paths.ts";

/** `manual` sets "Nur von Hand" before the page loads, so the automatic check at the start does not change the state under test. */
async function openMain(app: AppUnderTest, search: string, lang: Lang = "de", manual = false): Promise<void> {
  // The Electron program and its page are shared by all tests of a worker and an init script cannot be removed again, so it only
  // acts on an address that asks for it (e2e-manual=1); otherwise every later test would start in "Nur von Hand" too.
  if (manual) await app.page.addInitScript(() => (location.search.includes("e2e-manual=1") ? localStorage.setItem("halfcube.settings.updateCheck", "manual") : undefined));
  await app.open(`?screen=main&lang=${lang}&${search}${manual ? "&e2e-manual=1" : ""}`);
  await expect(app.page.getByTestId("loading-screen")).toHaveCount(0, { timeout: 60_000 });
  await expect(app.page.getByTestId("status-early")).toBeVisible({ timeout: 30_000 });
}

const icon = (page: Page) => page.getByTestId("about-button");
const query = (page: Page, key: string) => new URL(page.url()).searchParams.get(key);

async function makeSketch(page: Page): Promise<void> {
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("tree-row-plane:xy").click();
  await expect(page.getByTestId("finish-sketch")).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => (window as unknown as { __halfcube: { editor: { addRectangle(a: unknown, b: unknown): Promise<unknown> } } }).__halfcube.editor.addRectangle({ x: 0, y: 0 }, { x: 40, y: 25 }));
  await page.getByTestId("finish-sketch").click();
  await expect(page.getByTestId("tab-sketch")).toHaveCount(0);
}

test.describe("the mark on the info icon", () => {
  const cases: { scenario: string; mark: string; de: string; en: string }[] = [
    { scenario: "found&updates-auto=off", mark: "found", de: "Info · Update verfügbar", en: "Info · Update available" },
    { scenario: "dl", mark: "dl", de: "Info · Update wird geladen 42 %", en: "Info · Downloading update 42%" },
    { scenario: "ready", mark: "ready", de: "Info · Update bereit", en: "Info · Update ready" },
    { scenario: "exit", mark: "exit", de: "Info · Update wird beim Beenden installiert", en: "Info · Update installs when you quit" },
    { scenario: "faildl", mark: "failed", de: "Info · Update fehlgeschlagen", en: "Info · Update failed" },
  ];
  for (const c of cases) {
    test(`${c.scenario}: shape, tooltip and aria-label name the state in words`, async ({ app }) => {
      await openMain(app, `updates-demo=${c.scenario}`, "de");
      await expect(icon(app.page)).toHaveAttribute("data-update-icon", c.mark);
      // "Scheduled for exit" is a hollow ring, the others a dot or a ring around the icon.
      if (c.scenario === "exit") await expect(icon(app.page).locator('[data-mark="ring"]')).toBeVisible();
      await expect(icon(app.page)).toHaveAttribute("aria-label", c.de);
      await app.page.getByTestId("about-button").hover();
      await expect(app.page.locator(".hc-tip[data-tip]", { has: icon(app.page) })).toHaveAttribute("data-tip", c.de);
    });
  }

  test("English texts, and a failed check with an update known keeps the dot", async ({ app }) => {
    await openMain(app, "updates-demo=found&updates-auto=off&updates-check=error", "en");
    await expect(icon(app.page)).toHaveAttribute("aria-label", "Info · Update available");
    await expect(icon(app.page)).toHaveAttribute("data-update-icon", "found");
    await icon(app.page).click();
    await app.page.getByTestId("update-check").click();
    // With an update known the failed check does not replace it: the dot stays.
    await expect(app.page.getByTestId("update-slot")).toHaveAttribute("data-slot", "found");
  });

  test("a failed manual check shows the triangle, a plain icon has no mark, nothing moves", async ({ app }) => {
    await openMain(app, "updates-demo=none&updates-check=error");
    await expect(icon(app.page)).toHaveAttribute("aria-label", "Über HalfCube");
    await expect(icon(app.page)).toHaveAttribute("data-update-icon", "none");
    const before = await snapshot(app.page, { icon: icon(app.page), settings: app.page.getByTestId("settings-button"), undo: app.page.getByTestId("undo") });
    await icon(app.page).click();
    await app.page.getByTestId("update-check").click();
    await expect(app.page.getByTestId("update-slot")).toHaveAttribute("data-slot", "failed", { timeout: 10_000 });
    await app.page.keyboard.press("Escape");
    await expect(icon(app.page)).toHaveAttribute("data-update-icon", "failed");
    await expect(icon(app.page)).toHaveAttribute("aria-label", "Info · Update-Suche fehlgeschlagen");
    const after = await snapshot(app.page, { icon: icon(app.page), settings: app.page.getByTestId("settings-button"), undo: app.page.getByTestId("undo") });
    expect(after.boxes).toEqual(before.boxes);
  });

  test("the browser version has no updater: no mark, no slot, only the link to what is new", async ({ app }) => {
    test.skip(app.target === "electron", "The Electron program has an updater bridge of its own.");
    await openMain(app, "");
    await expect(icon(app.page)).toHaveAttribute("data-update-icon", "none");
    await icon(app.page).click();
    await expect(app.page.getByTestId("about-info")).toBeVisible();
    await expect(app.page.getByTestId("update-slot")).toHaveCount(0);
    await expect(app.page.getByTestId("update-news-link")).toBeVisible();
  });
});

test.describe("the update slot in Über HalfCube", () => {
  test("always shows 'Nach Updates suchen' at the same place and keeps its height in every state", async ({ app }) => {
    const { page } = app;
    const filledButtons: Record<string, number> = {};
    const seen: Record<string, { slot: { height: number; width: number }; check: { x: number; y: number; width: number; height: number } }> = {};
    for (const scenario of ["none", "found", "dl", "ready", "exit", "failed", "faildl", "uptodate", "newerfail"]) {
      await openMain(app, `updates-demo=${scenario}&updates-auto=off&about=info`, "de", true);
      await expect(page.getByTestId("update-slot")).toBeVisible();
      await expect(page.getByTestId("update-check")).toBeVisible();
      const s = await snapshot(page, { slot: page.getByTestId("update-slot"), card: page.getByRole("group", { name: "Update-Status" }), check: page.getByTestId("update-check") });
      filledButtons[scenario] = await page.getByTestId("update-slot").locator('[data-variant="primary"]').count();
      seen[scenario] = { slot: { height: s.boxes.card!.height, width: s.boxes.card!.width }, check: s.boxes.check! };
    }
    const first = seen.none!;
    for (const [scenario, s] of Object.entries(seen)) {
      // The rare hint of a failed newer download makes the card one row taller (nothing inside it moves, see its own test).
      expect(scenario === "newerfail" ? s.slot.width : s.slot, `card size in ${scenario}`).toEqual(scenario === "newerfail" ? first.slot.width : first.slot);
      expect(s.check, `check button box in ${scenario}`).toEqual(first.check);
    }
    // One filled button per state (none in "up to date", which has no main action).
    expect(filledButtons).toEqual({ none: 1, found: 1, dl: 1, ready: 1, exit: 1, failed: 1, faildl: 1, uptodate: 0, newerfail: 1 });
  });

  test("the check button spins over its invisible label, is neutral next to a main action and filled otherwise, and is off while downloading", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=none&updates-check=found&updates-auto=off&about=info", "de", true);
    const check = page.getByTestId("update-check");
    await expect(check).toHaveAttribute("data-variant", /primary|neutral/);
    const idle = await snapshot(page, { check });
    await check.click();
    await expect(check).toHaveAttribute("aria-busy", "true");
    await expect(page.getByTestId("update-slot")).toHaveAttribute("data-slot", "checking");
    expect((await snapshot(page, { check })).boxes.check).toEqual(idle.boxes.check);
    await expect(page.getByTestId("update-slot")).toHaveAttribute("data-slot", "found", { timeout: 10_000 });
    await expect(page.getByTestId("update-slot-show")).toHaveAttribute("data-variant", "primary");
    await expect(check).toHaveAttribute("data-variant", "neutral");

    await openMain(app, "updates-demo=dl&about=info");
    const disabled = page.getByTestId("update-check");
    await expect(disabled).toHaveAttribute("aria-disabled", "true");
    await disabled.hover();
    await expect(page.locator(".hc-tip", { has: disabled })).toHaveAttribute("data-tip", "Während des Downloads nicht möglich");
  });

  test("an error shows a short line with its code, and 'Details' opens the complete, copyable error", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=failed&about=info");
    const line = page.getByTestId("update-slot-error");
    await expect(line).toContainText("Update-Suche fehlgeschlagen");
    await expect(line).toContainText("HC-UPDATE-001");
    await page.getByTestId("update-slot-details").click();
    const dialog = page.getByRole("dialog", { name: "Nach Updates suchen" });
    await expect(dialog).toBeVisible();
    expect(query(page, "update")).toBe("error");
    const notice = dialog.getByRole("alert");
    await expect(notice).toHaveAttribute("data-error-code", "HC-UPDATE-001");
    await expect(notice).toContainText("did not answer within 10000 ms");
    await expect(dialog.getByRole("button", { name: "Kopieren" })).toBeVisible();
  });

  test("scheduled for exit: 'Vormerkung aufheben' brings back 'ready'", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=exit&about=info");
    await expect(page.getByTestId("update-slot")).toHaveAttribute("data-slot", "exit");
    await page.getByTestId("update-cancel-exit").click();
    await expect(page.getByTestId("update-slot")).toHaveAttribute("data-slot", "ready");
    await expect(icon(page)).toHaveAttribute("data-update-icon", "ready");
  });

  test("the Info tab fits a 960 x 600 window: the dialog stays inside and the Lizenzen tab keeps its height", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=found&about=info");
    await page.setViewportSize({ width: 960, height: 600 });
    await page.evaluate(async () => document.fonts.ready);
    const dialog = await snapshot(page, { d: page.getByTestId("about-dialog"), p: page.getByTestId("about-panes") });
    expect(dialog.boxes.d!.y + dialog.boxes.d!.height).toBeLessThanOrEqual(600);
    await page.getByTestId("about-tab-licenses").click();
    const licences = await snapshot(page, { d: page.getByTestId("about-dialog"), p: page.getByTestId("about-panes") });
    expect(licences.boxes).toEqual(dialog.boxes);
    // What does not fit scrolls inside: the last row is reachable.
    await page.getByTestId("about-tab-info").click();
    await page.getByTestId("about-copy-version").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("about-copy-version")).toBeVisible();
  });
});

test.describe("a newer update that failed to download while an older one is ready", () => {
  test("the slot names the version with its error code and keeps 'Jetzt neu starten'; the card grows by the hint's row, nothing inside it moves", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=ready&about=info", "de", true);
    // A rare failure: no room is reserved for it, the hint does not exist while there is none.
    await expect(page.getByTestId("newer-hint")).toHaveCount(0);
    const card = page.getByRole("group", { name: "Update-Status" });
    const plain = await snapshot(page, { card, check: page.getByTestId("update-check"), main: page.getByTestId("update-slot-restart"), bar: page.getByTestId("update-slot-bar") });
    await openMain(app, "updates-demo=newerfail&about=info", "de", true);
    await expect(page.getByTestId("newer-hint")).toBeVisible();
    await expect(page.getByTestId("update-slot")).toHaveAttribute("data-slot", "ready");
    await expect(page.getByTestId("newer-hint-text")).toContainText("Neueres Update");
    await expect(page.getByTestId("newer-hint-text")).toContainText("HC-UPDATE-003");
    await expect(page.getByTestId("newer-hint-text")).toHaveAttribute("data-error-code", "HC-UPDATE-003");
    await expect(page.getByTestId("update-slot-restart")).toHaveText("Jetzt neu starten");
    const shown = await snapshot(page, { card, check: page.getByTestId("update-check"), main: page.getByTestId("update-slot-restart"), bar: page.getByTestId("update-slot-bar") });
    // The card is one row taller; its content (the main action, the check button, the bar) stays exactly where it was.
    expect(shown.boxes.card!.height).toBeGreaterThan(plain.boxes.card!.height);
    expect(shown.boxes.card!.width).toBe(plain.boxes.card!.width);
    expect(shown.boxes.main).toEqual(plain.boxes.main);
    expect(shown.boxes.check).toEqual(plain.boxes.check);
    expect(shown.boxes.bar).toEqual(plain.boxes.bar);
    // Only one filled button: the hint's buttons are neutral.
    await expect(page.getByTestId("update-slot").locator('[data-variant="primary"]')).toHaveCount(1);
  });

  test("'Details' opens the complete, copyable error and 'Erneut versuchen' downloads the newer update, then the hint is gone", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=newerfail&about=info", "de", true);
    await page.getByTestId("newer-hint-details").click();
    const dialog = page.getByRole("dialog", { name: "Update fehlgeschlagen" });
    await expect(dialog).toBeVisible();
    expect(query(page, "update")).toBe("error");
    const notice = dialog.getByRole("alert");
    await expect(notice).toHaveAttribute("data-error-code", "HC-UPDATE-003");
    await expect(dialog.getByRole("button", { name: "Kopieren" })).toBeVisible();
    await page.getByTestId("check-error-close").click();
    await expect(dialog).toHaveCount(0);
    await icon(page).click();
    await page.getByTestId("newer-hint-retry").click();
    await expect(icon(page)).toHaveAttribute("data-update-icon", /dl|ready/);
    await expect(page.getByTestId("update-slot")).toHaveAttribute("data-slot", "ready", { timeout: 20_000 });
    await expect(page.getByTestId("newer-hint")).toHaveCount(0, { timeout: 20_000 });
  });

  test("the update window shows the hint too, as an extra row above the buttons, and without it has no empty row", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=ready&update=window", "de", true);
    await expect(page.getByTestId("update-window")).toHaveAttribute("data-phase", "ready");
    await expect(page.getByTestId("newer-hint")).toHaveCount(0);
    const plain = await snapshot(page, { win: page.getByTestId("update-window"), progress: page.getByTestId("update-progress") });
    await openMain(app, "updates-demo=newerfail&update=window", "de", true);
    await expect(page.getByTestId("newer-hint")).toBeVisible();
    await expect(page.getByTestId("newer-hint-text")).toContainText("HC-UPDATE-003");
    const shown = await snapshot(page, { win: page.getByTestId("update-window"), progress: page.getByTestId("update-progress") });
    expect(shown.boxes.win!.height).toBeGreaterThan(plain.boxes.win!.height);
    expect(shown.boxes.progress).toEqual(plain.boxes.progress);
    await page.getByTestId("newer-hint-retry").click();
    await expect(page.getByTestId("update-window")).toHaveAttribute("data-phase", "downloading");
  });

  test("the update window fits a 960 x 600 window, with and without the hint", async ({ app }) => {
    const { page } = app;
    for (const scenario of ["ready", "newerfail"]) {
      await openMain(app, `updates-demo=${scenario}&update=window`, "de", true);
      await page.setViewportSize({ width: 960, height: 600 });
      await page.evaluate(async () => document.fonts.ready);
      const win = (await snapshot(page, { win: page.getByTestId("update-window") })).boxes.win!;
      expect(win.y + win.height, scenario).toBeLessThanOrEqual(600);
    }
  });
});

test.describe("the update window", () => {
  test("opens from 'Update anzeigen' with both versions, the download size and only what is new in the new version", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=found&updates-auto=off&about=info");
    await page.getByTestId("update-slot-show").click();
    const win = page.getByRole("dialog", { name: "Update verfügbar" });
    await expect(win).toBeVisible();
    expect(query(page, "update")).toBe("window");
    expect(query(page, "about")).toBeNull();
    await expect(page.getByTestId("update-installed")).toContainText("Installiert");
    await expect(page.getByTestId("update-new")).toContainText("Nightly α");
    await expect(page.getByTestId("update-download")).toContainText("18,4 MB");
    // No count of skipped versions (owner, 2026-11-26: "Das ist Blödsinn"): only the entry of the new version, under its version.
    await expect(page.getByTestId("update-skipped")).toHaveCount(0);
    await expect(page.getByTestId("update-facts")).not.toContainText("Übersprungen");
    await expect(page.getByTestId("update-notes-heading")).toHaveText(/^Das ist neu in v\d+\.\d+\.\d+\.\d+\.\d+ \(α\)$/);
    await expect(page.getByTestId("update-notes").getByTestId("news-entry-body")).toHaveCount(1);
    const lines = await page.getByTestId("update-notes").getByTestId("news-line").allTextContents();
    expect(lines.join(" ")).toContain("Kreise zeichnest du über drei Punkte.");
    // Nothing of the skipped versions (their lines are behind "Alle Änderungen anzeigen").
    expect(lines.join(" ")).not.toContain("Doppelklick auf eine Linie");
    await expect(page.getByTestId("update-notes").getByTestId("category-badge").first()).toBeVisible();
    await page.getByTestId("update-later").click();
    await expect(win).toHaveCount(0);
    expect(query(page, "update")).toBeNull();
  });

  test("'Alle Änderungen anzeigen' in the update window opens the dialog with the release notes' entries and returns to the window", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=found&updates-auto=off&update=window");
    await page.getByTestId("all-changes-link").click();
    const dialog = page.getByRole("dialog", { name: "Alle Änderungen" });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("changes-window")).toHaveAttribute("data-source", "update");
    expect(query(page, "changes")).toBe("update");
    // Every entry (also the skipped versions), newest first, all open, each with its month.
    const entries = page.getByTestId("changes-entry");
    await expect(entries).toHaveCount(3);
    const versions = await entries.evaluateAll((els) => els.map((e) => e.getAttribute("data-version") ?? ""));
    const numbers = versions.map((v) => Number(v.split(".")[2]));
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
    await expect(entries.first().getByTestId("changes-date")).toHaveText("26.11.2026");
    expect(await page.getByTestId("changes-date").allTextContents()).toEqual(["26.11.2026", "24.11.2026", "19.11.2026"]);
    await expect(page.getByTestId("changes-entry").nth(2).getByTestId("news-line").first()).toBeVisible();
    await expect(page.getByTestId("changes-entry").nth(1).getByTestId("category-badge").first()).toBeVisible();
    // Esc closes only this dialog: the update window is back underneath.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("update-window")).toBeVisible();
    expect(query(page, "changes")).toBeNull();
  });

  test("a reload keeps the dialog 'Alle Änderungen'", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=found&updates-auto=off&update=window&changes=update");
    await expect(page.getByRole("dialog", { name: "Alle Änderungen" })).toBeVisible({ timeout: 20_000 });
    await page.reload();
    await expect(page.getByRole("dialog", { name: "Alle Änderungen" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("changes-entry")).toHaveCount(3);
  });

  test("the update downloads by itself: the window shows the progress, then 'Jetzt neu starten'; the warning never comes by itself", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=found&update=window");
    const main = page.getByTestId("update-main");
    // No download button: the main action is the busy "Jetzt neu starten" from the first moment.
    await expect(main).toHaveText("Jetzt neu starten");
    await expect(main).toHaveAttribute("aria-busy", "true");
    await expect(page.getByTestId("update-window")).toHaveAttribute("data-phase", "downloading", { timeout: 10_000 });
    await expect(icon(page)).toHaveAttribute("data-update-icon", "dl");
    const targets = { main, win: page.getByTestId("update-window"), progress: page.getByTestId("update-progress") };
    const running = await snapshot(page, targets);
    await expect(page.getByTestId("update-window")).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await expect(main).not.toHaveAttribute("aria-busy", "true");
    await expect(main).toHaveText("Jetzt neu starten");
    // Nothing moved between downloading and ready: the button, the window and the progress block keep their boxes.
    const ready = await snapshot(page, targets);
    expect(ready.boxes).toEqual(running.boxes);
    // The download is done: no warning, no restart. The user has to click.
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByTestId("restarting")).toHaveCount(0);
    await expect(page.getByTestId("update-later")).toHaveText("Später");
  });

  test("the slot follows the automatic download without a click: found, downloading, ready", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=found&about=info");
    await expect(page.getByTestId("update-slot")).toHaveAttribute("data-slot", "dl", { timeout: 10_000 });
    await expect(page.getByTestId("update-slot-progress")).toHaveText("Fortschritt anzeigen");
    await expect(page.getByTestId("update-slot")).toHaveAttribute("data-slot", "ready", { timeout: 20_000 });
    await expect(page.getByTestId("update-slot-restart")).toHaveText("Jetzt neu starten");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });

  test("the progress runs on when the window is closed and the slot shows it", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=found&update=window");
    await expect(page.getByTestId("update-window")).toHaveAttribute("data-phase", "downloading", { timeout: 10_000 });
    await page.getByTestId("update-later").click();
    await expect(icon(page)).toHaveAttribute("data-update-icon", /dl|ready/);
    await icon(page).click();
    await expect(page.getByTestId("update-slot")).toHaveAttribute("data-slot", /dl|ready/);
  });

  test("a failed download shows the complete error and 'Erneut versuchen' starts again", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=faildl&about=info");
    await expect(page.getByTestId("update-slot-retry")).toHaveText("Erneut versuchen");
    await page.getByTestId("update-slot-details").click();
    const notice = page.getByTestId("update-window").getByRole("alert");
    await expect(notice).toHaveAttribute("data-error-code", "HC-UPDATE-002");
    await expect(notice).toContainText("Prüfsumme");
    await page.getByTestId("update-retry").click();
    await expect(page.getByTestId("update-window")).toHaveAttribute("data-phase", "downloading");
  });

  test("a reload keeps the open update window", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=found&update=window");
    await expect(page.getByTestId("update-window")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("update-window")).toBeVisible({ timeout: 60_000 });
    expect(query(page, "update")).toBe("window");
  });

  test("an address with an update window but no update (after the update was installed) opens nothing", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=uptodate&update=window");
    await expect(page.getByTestId("update-window")).toHaveCount(0);
    await expect.poll(() => query(page, "update")).toBeNull();
  });
});

test.describe("the restart", () => {
  test("without work in the design it restarts at once, no warning", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=ready&about=info");
    await page.getByTestId("update-slot-restart").click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByTestId("restarting")).toBeVisible();
  });

  test("with work the warning names the design and the steps and has three buttons, focus on 'Abbrechen'", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=ready");
    await makeSketch(page);
    await makeSketch(page);
    await icon(page).click();
    await page.getByTestId("update-slot-restart").click();
    const warn = page.getByRole("alertdialog", { name: "Neu starten und Entwurf verwerfen?" });
    await expect(warn).toBeVisible();
    expect(query(page, "update")).toBe("restart");
    await expect(page.getByTestId("restart-warning")).toContainText("Unbenanntes Teil");
    await expect(page.getByTestId("restart-warning")).toContainText("allen 2 Schritten");
    await expect(page.getByTestId("restart-cancel")).toBeFocused();
    await expect(page.getByTestId("restart-on-exit")).toHaveText("Beim Beenden installieren");
    await expect(page.getByTestId("restart-discard")).toHaveText("Verwerfen und neu starten");
    // Cancel: nothing restarts, the update stays ready.
    await page.getByTestId("restart-cancel").click();
    await expect(warn).toHaveCount(0);
    await expect(page.getByTestId("restarting")).toHaveCount(0);
    await expect(icon(page)).toHaveAttribute("data-update-icon", "ready");
  });

  test("'Beim Beenden installieren' schedules the update and leaves the design alone", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=ready");
    await makeSketch(page);
    await icon(page).click();
    await page.getByTestId("update-slot-restart").click();
    await expect(page.getByTestId("restart-warning")).toContainText("dem einen Schritt");
    await page.getByTestId("restart-on-exit").click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(icon(page)).toHaveAttribute("data-update-icon", "exit");
    await expect(page.getByTestId("unsaved-dot")).toBeVisible();
  });

  test("'Verwerfen und neu starten' shows the restarting notice; a failed restart shows its error", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=ready&updates-restart=fail");
    await makeSketch(page);
    await icon(page).click();
    await page.getByTestId("update-slot-restart").click();
    await page.getByTestId("restart-discard").click();
    await expect(page.getByTestId("restarting")).toBeVisible();
    const failed = page.getByRole("dialog", { name: "Neustart fehlgeschlagen" });
    await expect(failed).toBeVisible({ timeout: 10_000 });
    await expect(failed.getByRole("alert")).toHaveAttribute("data-error-code", "HC-UPDATE-004");
    await page.getByTestId("restart-error-close").click();
    await expect(failed).toHaveCount(0);
  });

  test("a reload keeps the restart warning while the design has work", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=ready");
    await makeSketch(page);
    await icon(page).click();
    await page.getByTestId("update-slot-restart").click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("alertdialog", { name: "Neu starten und Entwurf verwerfen?" })).toBeVisible({ timeout: 60_000 });
  });
});

test.describe("Was ist neu", () => {
  test("opens by itself on the first start after an update, grouped by area with badges, and never again once closed", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=news");
    const win = page.getByRole("dialog", { name: "Was ist neu" });
    await expect(win).toBeVisible({ timeout: 20_000 });
    expect(query(page, "news")).toBe("1");
    // Only the entry of the version now running (no older ones are collected), under its version and month.
    await expect(page.getByTestId("news-date")).toHaveText("26.11.2026");
    await expect(page.getByTestId("news-sub")).toContainText("Nightly");
    // The version stands there without the date and platforms of its heading.
    await expect(page.getByTestId("news-sub")).not.toContainText(" · ");
    const areas = await page.getByTestId("news-area").allTextContents();
    expect(areas).toEqual(["Skizze", "Körper", "Installation & Updates", "Allgemein"]);
    await expect(page.getByTestId("news-entry-body")).toHaveCount(1);
    await expect(page.getByTestId("news-scroll").getByTestId("category-badge").first()).toContainText(/Neu|Behoben|Geändert|Sicherheit/);
    const lines = (await page.getByTestId("news-line").allTextContents()).join(" ");
    expect(lines).toContain("Kreise zeichnest du über drei Punkte.");
    expect(lines).not.toContain("Doppelklick auf eine Linie");
    await page.getByTestId("news-close").click();
    await expect(win).toHaveCount(0);
    expect(query(page, "news")).toBeNull();
  });

  test("the window is as high as its entry needs (up to a limit), the footer stays at its bottom, and the list scrolls inside beyond that", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=news");
    await expect(page.getByTestId("news-window")).toBeVisible({ timeout: 20_000 });
    const short = await snapshot(page, { win: page.getByTestId("news-window"), scroll: page.getByTestId("news-scroll"), link: page.getByTestId("all-changes-link") });
    // The short demo entry does not fill the old fixed height (640 px) and nothing scrolls.
    expect(short.boxes.win!.height).toBeLessThan(600);
    const scrolls = await page.getByTestId("news-scroll").evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(scrolls).toBe(false);
    // The footer (link and hint) sits at the bottom edge of the window.
    expect(Math.abs(short.boxes.win!.y + short.boxes.win!.height - (short.boxes.link!.y + short.boxes.link!.height) - 52)).toBeLessThan(30);
    // In a window too low for the entry it is limited by the window and scrolls inside, the dialog stays inside the window.
    await page.setViewportSize({ width: 960, height: 420 });
    const low = await snapshot(page, { win: page.getByTestId("news-window"), link: page.getByTestId("all-changes-link") });
    expect(low.boxes.win!.y + low.boxes.win!.height).toBeLessThanOrEqual(420);
    expect(low.boxes.win!.height).toBeLessThan(short.boxes.win!.height);
    const lowScrolls = await page.getByTestId("news-scroll").evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(lowScrolls).toBe(true);
    await expect(page.getByTestId("all-changes-link")).toBeVisible();
  });

  test("the browser version (no updater) gets it too: opens by itself on a later visit of a newer build, there is no update mark", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=news&updates-browser=1");
    await expect(page.getByRole("dialog", { name: "Was ist neu" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("news-date")).toHaveText("26.11.2026");
    await page.getByTestId("news-close").click();
    await expect(icon(page)).toHaveAttribute("data-update-icon", "none");
    await icon(page).click();
    await expect(page.getByTestId("update-slot")).toHaveCount(0);
  });

  test("a first visit shows nothing, in the browser version as well", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=news&updates-browser=1&updates-first=1");
    await page.waitForTimeout(2500);
    await expect(page.getByRole("dialog", { name: "Was ist neu" })).toHaveCount(0);
  });

  test("the browser version waits while the welcome screen owns the screen", async ({ app }) => {
    const { page } = app;
    await app.open("?lang=de&updates-demo=news&updates-browser=1");
    await expect(page.getByRole("dialog", { name: "Erst skizzieren, dann bauen" })).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(2500);
    await expect(page.getByRole("dialog", { name: "Was ist neu" })).toHaveCount(0);
  });

  test("'Alle Änderungen anzeigen' in 'Was ist neu' opens the complete changelog of the channel: every entry, newest first, all open", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=news");
    await expect(page.getByRole("dialog", { name: "Was ist neu" })).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("all-changes-link").click();
    const dialog = page.getByRole("dialog", { name: "Alle Änderungen" });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("changes-window")).toHaveAttribute("data-source", "app");
    expect(query(page, "changes")).toBe("app");
    await expect(page.getByTestId("changes-sub")).toContainText("3 Versionen");
    const entries = page.getByTestId("changes-entry");
    await expect(entries).toHaveCount(3);
    // All entries are open: every one shows its lines without a click; the areas come in the fixed order inside each entry.
    for (let i = 0; i < 3; i++) await expect(entries.nth(i).getByTestId("news-line").first()).toBeVisible();
    expect(await entries.first().getByTestId("news-area").allTextContents()).toEqual(["Skizze", "Körper", "Installation & Updates", "Allgemein"]);
    // Closing the dialog leaves "Was ist neu" open underneath (it was not closed by the link).
    await page.getByTestId("changes-close").click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Was ist neu" })).toBeVisible();
  });

  test("the dialog works in English and is reachable from the browser version", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=news&updates-browser=1", "en");
    await expect(page.getByRole("dialog", { name: "What’s new" })).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("all-changes-link").click();
    await expect(page.getByRole("dialog", { name: "All changes" })).toBeVisible();
    await expect(page.getByTestId("changes-date").first()).toHaveText("2026-11-26");
    expect(await page.getByTestId("changes-date").allTextContents()).toEqual(["2026-11-26", "2026-11-24", "2026-11-19"]);
    expect(await page.getByTestId("changes-entry").first().getByTestId("news-area").allTextContents()).toEqual(["Sketch", "Bodies", "Installation & updates", "General"]);
  });

  test("closes with Esc and with a click on the backdrop", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=news");
    const win = page.getByRole("dialog", { name: "Was ist neu" });
    await expect(win).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press("Escape");
    await expect(win).toHaveCount(0);
    await icon(page).click();
    await page.getByTestId("update-news-link").click();
    await expect(win).toBeVisible();
    await page.locator("[data-modal-backdrop]").last().click({ position: { x: 5, y: 5 } });
    await expect(win).toHaveCount(0);
  });

  test("waits while the welcome screen owns the screen", async ({ app }) => {
    const { page } = app;
    await app.open("?lang=de&updates-demo=news");
    const welcome = page.getByRole("dialog", { name: "Erst skizzieren, dann bauen" });
    await expect(welcome).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(2500);
    await expect(page.getByRole("dialog", { name: "Was ist neu" })).toHaveCount(0);
  });

  test("a scenario that is not 'news' (and a dev build in general) never opens it by itself", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=found");
    await page.waitForTimeout(2500);
    await expect(page.getByRole("dialog", { name: "Was ist neu" })).toHaveCount(0);
  });

  test("a reload keeps it open", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=found&news=1");
    await expect(page.getByRole("dialog", { name: "Was ist neu" })).toBeVisible({ timeout: 20_000 });
    await page.reload();
    await expect(page.getByRole("dialog", { name: "Was ist neu" })).toBeVisible({ timeout: 60_000 });
  });
});

test.describe("Einstellungen › Updates", () => {
  test("shows the channel, the version, the frequency as a vertical choice with its help text, and what is new", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=found&settings=updates");
    await expect(page.getByTestId("settings-tab-updates")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("setting-update-channel")).toContainText("Nightly α");
    await expect(page.getByTestId("setting-update-channel")).toContainText("Festgelegt bei der Installation.");
    await expect(page.getByTestId("settings-version")).toBeVisible();
    await expect(page.getByTestId("update-check-help")).toContainText("bei jedem Start");
    await page.getByTestId("update-check-week").click();
    await expect(page.getByTestId("update-check-week")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("update-check-help")).toContainText("höchstens einmal pro Woche");
    await page.getByTestId("update-check-manual").click();
    await expect(page.getByTestId("update-check-help")).toContainText("prüft nie von selbst");
    expect(await page.evaluate(() => localStorage.getItem("halfcube.settings.updateCheck"))).toBe("manual");
    await page.reload();
    await expect(page.getByTestId("update-check-manual")).toHaveAttribute("aria-checked", "true", { timeout: 60_000 });
  });

  test("the help text keeps its room: choosing another frequency moves nothing", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=found&settings=updates");
    const targets = { frequency: page.getByTestId("setting-update-frequency"), news: page.getByTestId("setting-update-news"), dialog: page.getByTestId("settings-dialog") };
    const before = await snapshot(page, targets);
    for (const mode of ["day", "week", "manual", "start"]) {
      await page.getByTestId(`update-check-${mode}`).click();
      expect((await snapshot(page, targets)).boxes, mode).toEqual(before.boxes);
    }
  });

  test("a check by hand shows its result in the row and a failure as the complete error", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=none&updates-check=found&settings=updates");
    await page.getByTestId("settings-check").click();
    await expect(page.getByTestId("settings-result")).toContainText("Update gefunden", { timeout: 10_000 });
    // "Anzeigen" leads to the update slot in Über HalfCube, never to the update window itself (that opens only from the slot).
    await page.getByTestId("settings-show-update").click();
    await expect(page.getByRole("dialog", { name: "Über HalfCube" })).toBeVisible();
    await expect(page.getByTestId("update-slot")).toHaveAttribute("data-slot", /found|dl/);
    await expect(page.getByTestId("update-window")).toHaveCount(0);
    expect(query(page, "settings")).toBeNull();
    expect(query(page, "update")).toBeNull();

    await openMain(app, "updates-demo=failed&settings=updates");
    await page.getByTestId("settings-check").click();
    const error = page.getByTestId("settings-error").getByRole("alert");
    await expect(error).toHaveAttribute("data-error-code", "HC-UPDATE-001", { timeout: 10_000 });
  });

  test("'Einstellungen für Updates' in Über HalfCube opens this tab", async ({ app }) => {
    const { page } = app;
    await openMain(app, "updates-demo=found&about=info");
    await page.getByTestId("update-settings-link").click();
    await expect(page.getByTestId("settings-tab-updates")).toHaveAttribute("aria-selected", "true");
    expect(query(page, "about")).toBeNull();
    expect(query(page, "settings")).toBe("updates");
  });

  test("the browser version shows its version, a note and 'Was ist neu' only", async ({ app }) => {
    test.skip(app.target === "electron", "The Electron program has an updater bridge of its own.");
    await openMain(app, "settings=updates");
    await expect(app.page.getByTestId("settings-no-updater")).toContainText("Browser-Version");
    await expect(app.page.getByTestId("settings-news")).toBeVisible();
    await expect(app.page.getByTestId("settings-check")).toHaveCount(0);
  });
});

test.describe("automatic checks", () => {
  test("a check runs at the start in the default mode, not in manual mode", async ({ app }) => {
    const { page: p } = app;
    // Default mode: the demo's check finds the update and the slot is already filled in when the info view opens.
    await openMain(app, "updates-demo=none&updates-check=found");
    await expect(icon(p)).toHaveAttribute("data-update-icon", "found", { timeout: 15_000 });
    // Manual mode (set before the page loads): nothing is checked by itself.
    await p.evaluate(() => localStorage.setItem("halfcube.settings.updateCheck", "manual"));
    await p.goto(`${p.url().split("?")[0]}?screen=main&lang=de&updates-demo=none&updates-check=found`);
    await expect(p.getByTestId("loading-screen")).toHaveCount(0, { timeout: 60_000 });
    await p.waitForTimeout(3000);
    await expect(icon(p)).toHaveAttribute("data-update-icon", "none");
  });
});
