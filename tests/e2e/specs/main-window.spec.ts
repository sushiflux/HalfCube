// The main window (step U1): it renders in German and English at the narrowest width without anything moving, the browser tree
// and the timeline show a sketch right after "Skizze erstellen", the quick options of the navigation bar work, the settings
// dialog opens, stores its choices and survives a reload, and a reload brings the user back to the same place. Runs in the
// Electron program (native engine).
import type { Page } from "@playwright/test";
import { expect, test, type AppUnderTest } from "../support/fixtures.ts";
import { expectNoHorizontalOverflow, expectNothingMoved, expectNotTruncated, snapshot, type Targets } from "../support/layout.ts";
import { NARROWEST_WIDTH, type Lang } from "../support/paths.ts";

const words: Record<Lang, { sketchTool: string; body: string; origin: string; planeTop: string; empty: string; ready: string; finish: string; editing: string; nothing: string }> = {
  en: {
    sketchTool: "Sketch",
    body: "Body",
    origin: "Origin",
    planeTop: "Top (XY)",
    empty: "No steps yet. The first step is made by the sketch.",
    ready: "Ready",
    finish: "Finish sketch",
    editing: "Sketch1 is being edited",
    nothing: "Nothing selected",
  },
  de: {
    sketchTool: "Skizze",
    body: "Körper",
    origin: "Ursprung",
    planeTop: "Oben (XY)",
    empty: "Noch keine Schritte. Der erste Schritt entsteht mit der Skizze.",
    ready: "Bereit",
    finish: "Skizze beenden",
    editing: "Skizze1 wird bearbeitet",
    nothing: "Nichts gewählt",
  },
};

interface Hooks {
  __halfcube?: { model: unknown; editor: { addRectangle(a: unknown, b: unknown): Promise<{ ok: boolean }> } | null };
}

/** Opens the main window past the welcome screen and waits until the engine answers (the sketch tool is enabled then). */
async function openMain(app: AppUnderTest, search: string): Promise<void> {
  const { page } = app;
  await app.open(`?screen=main&${search}`);
  await expect(page.getByTestId("loading-screen")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("tool-sketch")).toBeEnabled({ timeout: 60_000 });
}

/** The sketch in the browser tree: "Skizze erstellen", then the plane in the tree. */
async function startSketchOnTop(page: Page): Promise<void> {
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("tree-row-plane:xy").click();
  await expect(page.getByTestId("finish-sketch")).toBeVisible({ timeout: 30_000 });
}

function layoutTargets(page: Page): Targets {
  return {
    titlebar: page.getByTestId("titlebar"),
    toolbar: page.getByTestId("toolbar"),
    toolRow: page.getByTestId("tool-row"),
    tree: page.getByTestId("browser-tree"),
    contextBar: page.getByTestId("context-bar"),
    viewport: page.getByTestId("viewport"),
    navbar: page.getByTestId("navbar"),
    timeline: page.getByTestId("timeline"),
    statusBar: page.getByTestId("status-bar"),
  };
}

for (const lang of ["en", "de"] as const) {
  test(`main window: renders at the narrowest width and nothing moves (${lang === "de" ? "German" : "English"})`, async ({ app }) => {
    const { page } = app;
    const w = words[lang];
    await openMain(app, `lang=${lang}`);
    const innerWidth = await app.setWidth(NARROWEST_WIDTH);
    test.info().annotations.push({ type: "width", description: `window ${NARROWEST_WIDTH} px, page ${innerWidth} px` });

    await expect(page.getByTestId("tool-sketch")).toContainText(w.sketchTool);
    await expect(page.getByTestId("tab-body")).toHaveText(w.body);
    await expect(page.getByTestId("tree-row-origin")).toContainText(w.origin);
    await expect(page.getByTestId("timeline-track")).toContainText(w.empty);
    await expect(page.getByTestId("status-bar")).toContainText(w.ready);
    await expect(page.getByTestId("status-selection")).toHaveText(w.nothing);
    await expectNoHorizontalOverflow(page, "main window");
    await expectNotTruncated(page.getByTestId("timeline-track").locator("span").first(), "timeline hint");
    await expectNotTruncated(page.getByTestId("context-bar"), "context bar");

    const targets = layoutTargets(page);
    const start = await snapshot(page, targets);

    // The settings dialog opens over the window and closes again: the window behind stays exactly where it is.
    await page.getByTestId("settings-button").click();
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await page.getByTestId("settings-tab-sketch").click();
    await expect(page.getByTestId("setting-sketch-fill")).toBeVisible();
    expectNothingMoved(start, await snapshot(page, targets), "settings dialog open");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
    expectNothingMoved(start, await snapshot(page, targets), "settings dialog closed");

    // Choosing the plane: the hint appears over the view and the origin opens in the tree; the frame stays.
    await page.getByTestId("tool-sketch").click();
    await expect(page.getByTestId("pick-plane-hint")).toBeVisible();
    await expect(page.getByTestId("tree-row-plane:xy")).toContainText(w.planeTop);
    expectNothingMoved(start, await snapshot(page, targets), "choosing a plane");

    // The sketch opens: the toolbar swaps its tab and tools, but not one frame of the window changes its place or size.
    await page.getByTestId("tree-row-plane:xy").click();
    await expect(page.getByTestId("finish-sketch")).toContainText(w.finish);
    await expect(page.getByTestId("status-bar")).toContainText(w.editing);
    await expectNoHorizontalOverflow(page, "main window in a sketch");
    expectNothingMoved(start, await snapshot(page, targets), "sketch open");

    // Unfolding the sketch in the timeline moves nothing either (the timeline has a fixed height).
    const drawn = await page.evaluate(() => (window as unknown as Hooks).__halfcube?.editor?.addRectangle({ x: 0, y: 0 }, { x: 40, y: 25 }));
    expect(drawn?.ok).toBe(true);
    const unfolded = await snapshot(page, targets);
    expectNothingMoved(start, unfolded, "sketch drawn");
    await page.getByTestId("timeline-expand-f1").click();
    await expect(page.getByTestId("timeline-sub-steps-f1")).toBeVisible();
    expectNothingMoved(start, await snapshot(page, targets), "timeline unfolded");
    expect(app.errors).toEqual([]);
  });
}

test("a sketch shows in the browser tree and as ONE timeline step; a plus unfolds the steps inside it", async ({ app }) => {
  const { page } = app;
  await openMain(app, "lang=en");

  // Nothing chosen yet: the sketch tool is not pressed and the origin is closed.
  await expect(page.getByTestId("tool-sketch")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("tree-row-plane:xy")).toHaveCount(0);
  await expect(page.getByTestId("timeline-step-f1")).toHaveCount(0);

  // Escape leaves the plane choice without a sketch.
  await page.getByTestId("tool-sketch").click();
  await expect(page.getByTestId("tool-sketch")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("tree-row-plane:xz")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pick-plane-hint")).toHaveCount(0);
  await expect(page.getByTestId("tree-row-plane:xz")).toHaveCount(0);

  await startSketchOnTop(page);
  await expect(page.getByTestId("tab-sketch")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("tab-body")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("tool-line")).toBeVisible();
  await expect(page.getByTestId("tree-row-sketch:f1")).toContainText("Sketch1");
  await expect(page.getByTestId("tree-row-sketch:f1")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("timeline-step-f1")).toHaveAttribute("data-editing", "true");
  await expect(page.getByTestId("context-path")).toContainText("Sketch1");
  await expect(page.getByTestId("timeline-position")).toContainText("step 1 of 1");
  // Inside a sketch undo reaches back only to the start of the sketch: nothing to undo yet.
  await expect(page.getByTestId("undo")).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as Hooks).__halfcube?.editor !== null)).toBe(true);

  // Draw a rectangle through the same function the sketch tools call: it appears as ONE inner step of the sketch.
  const drawn = await page.evaluate(() => (window as unknown as Hooks).__halfcube?.editor?.addRectangle({ x: 0, y: 0 }, { x: 40, y: 25 }));
  expect(drawn?.ok).toBe(true);
  await expect(page.getByTestId("timeline-sub-steps-f1")).toHaveCount(0);
  await page.getByTestId("timeline-expand-f1").click();
  const inner = page.getByTestId("timeline-sub-steps-f1").getByRole("button");
  await expect(inner).toHaveCount(1);
  await expect(inner.first()).toHaveAccessibleName("Rectangle 1");
  // A click on an inner step only highlights it.
  await inner.first().click();
  await expect(inner.first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("finish-sketch")).toBeVisible();
  await page.getByTestId("timeline-expand-f1").click();
  await expect(page.getByTestId("timeline-sub-steps-f1")).toHaveCount(0);

  // Finish: the sketch stays in the tree and the timeline, the toolbar goes back to the body tab, undo is available.
  await page.getByTestId("finish-sketch").click();
  await expect(page.getByTestId("tab-sketch")).toHaveCount(0);
  await expect(page.getByTestId("tool-sketch")).toBeEnabled();
  await expect(page.getByTestId("tree-row-sketch:f1")).toBeVisible();
  await expect(page.getByTestId("timeline-step-f1")).not.toHaveAttribute("data-editing", "true");
  await expect(page.getByTestId("undo")).toBeEnabled();

  // Two undo steps so far: the rectangle, then creating the sketch. Undo takes them away one by one, redo brings them back.
  await page.getByTestId("undo").click();
  await expect(page.getByTestId("timeline-step-f1")).toBeVisible();
  await page.getByTestId("undo").click();
  await expect(page.getByTestId("timeline-step-f1")).toHaveCount(0);
  await expect(page.getByTestId("tree-row-sketch:f1")).toHaveCount(0);
  await page.getByTestId("redo").click();
  await expect(page.getByTestId("timeline-step-f1")).toBeVisible();
  await page.getByTestId("redo").click();

  // Opening it again: double-click on the step.
  await page.getByTestId("timeline-step-f1").dblclick();
  await expect(page.getByTestId("finish-sketch")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("finish-sketch").click();
  await expect(page.getByTestId("finish-sketch")).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

test("the navigation bar: drag modes, fit, display style and grid toggle", async ({ app }) => {
  const { page } = app;
  await openMain(app, "lang=en");

  const grid = page.getByTestId("nav-grid");
  await expect(grid).toHaveAttribute("aria-pressed", "true");
  await grid.click();
  await expect(grid).toHaveAttribute("aria-pressed", "false");
  await grid.click();
  await expect(grid).toHaveAttribute("aria-pressed", "true");

  // The display menu: shaded, or shaded with hidden edges; the choice shows in the button's name.
  const display = page.getByTestId("nav-display");
  await expect(display).toHaveAccessibleName("Display: Shaded");
  await display.click();
  await expect(page.getByTestId("nav-display-menu")).toBeVisible();
  await expect(page.getByTestId("nav-display-shaded")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("nav-display-shadedHidden").click();
  await expect(page.getByTestId("nav-display-menu")).toHaveCount(0);
  await expect(display).toHaveAccessibleName("Display: Shaded with hidden edges");
  await display.click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("nav-display-menu")).toHaveCount(0);

  // Orbit mode: a left-button drag turns the view (the navigator's end moves); Escape ends the mode.
  const end = page.getByTestId("nav-end-+z");
  const before = await end.boundingBox();
  await page.getByTestId("nav-orbit").click();
  await expect(page.getByTestId("nav-orbit")).toHaveAttribute("aria-pressed", "true");
  const host = await page.getByTestId("viewport-host").boundingBox();
  if (!host || !before) throw new Error("no view");
  const x = host.x + host.width * 0.4;
  const y = host.y + host.height * 0.45;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 20, { steps: 5 });
  await page.mouse.move(x + 120, y + 40, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => JSON.stringify(await end.boundingBox())).not.toBe(JSON.stringify(before));
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("nav-orbit")).toHaveAttribute("aria-pressed", "false");

  // Fit returns to a framed view without errors.
  await page.getByTestId("nav-fit").click();
  await page.getByTestId("nav-home").click();
  expect(app.errors).toEqual([]);
});

test("the settings dialog: choices apply at once, are stored and survive a reload; the open dialog and its tab are in the address", async ({ app }) => {
  const { page } = app;
  // No lang parameter: the dev parameter would force English at every load and hide what the language choice stored.
  await openMain(app, "");

  await page.getByTestId("settings-button").click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  await expect.poll(() => page.url()).toContain("settings=display");

  // Colour theme and light or dark change the whole window at once.
  await page.getByTestId("mode-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await page.getByTestId("theme-graphit").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "graphit");

  // The timeline with names, the axis letters X, Y, Z.
  await page.getByTestId("timeline-names").click();
  await page.getByTestId("axis-xyz").click();
  await expect(page.getByTestId("axis-xyz")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("axis-views")).toHaveAttribute("aria-checked", "false");

  // The sketch settings: inner band or full area, green or blue (stored for the sketch tools).
  await page.getByTestId("settings-tab-sketch").click();
  await expect.poll(() => page.url()).toContain("settings=sketch");
  await expect(page.getByTestId("sketch-fill-band")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("sketch-colour-green")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("sketch-fill-fill").click();
  await page.getByTestId("sketch-colour-blue").click();
  expect(await page.evaluate(() => [localStorage.getItem("halfcube.settings.sketchFill"), localStorage.getItem("halfcube.settings.sketchColour")])).toEqual(["fill", "blue"]);
  // The look of the input fields at the geometry: the dimension line is the default, the label is the other choice.
  await expect(page.getByTestId("field-look-dimension")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("field-look-tag")).toHaveAttribute("aria-checked", "false");
  await page.getByTestId("field-look-tag").click();
  expect(await page.evaluate(() => localStorage.getItem("halfcube.settings.fieldLook"))).toBe("tag");

  // Language: the whole window switches at once.
  await page.getByTestId("settings-tab-display").click();
  await page.getByTestId("language-de").click();
  await expect(page.getByTestId("tab-body")).toHaveText("Körper");

  // Reload: the dialog is still open on the same tab, and every choice is still there.
  await page.getByTestId("settings-tab-sketch").click();
  await page.reload();
  await expect(page.getByTestId("settings-dialog")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("settings-tab-sketch")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("sketch-fill-fill")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("sketch-colour-blue")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("field-look-tag")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "graphit");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await page.getByTestId("settings-tab-display").click();
  await expect(page.getByTestId("timeline-names")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("axis-xyz")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("language-de")).toHaveAttribute("aria-checked", "true");

  // Closing removes the dialog from the address.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
  await expect.poll(() => page.url()).not.toContain("settings=");
  expect(app.errors).toEqual([]);
});

test("the wheel zoom direction is a setting: the default zooms out when the wheel goes down, the other choice zooms in, it applies at once and survives a reload; a pinch is not affected", async ({ app }) => {
  const { page } = app;
  await openMain(app, "");
  const distance = async (): Promise<number> => {
    await page.waitForFunction(() => Boolean((window as unknown as { __halfcube?: { viewport: unknown } }).__halfcube?.viewport), undefined, { timeout: 60_000 });
    return page.evaluate(async () => {
      const vp = (window as unknown as { __halfcube: { viewport: { getView(): { distance: number }; whenIdle(): Promise<void> } } }).__halfcube.viewport;
      await vp.whenIdle();
      return vp.getView().distance;
    });
  };
  const host = page.getByTestId("viewport-host");
  /** One wheel notch over the middle of the 3D view; resolves with the distance once the view has settled. */
  const wheel = async (deltaY: number, pinch = false): Promise<number> => {
    const box = await host.boundingBox();
    if (!box) throw new Error("no 3D view");
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55);
    if (pinch) await page.keyboard.down("Control");
    await page.mouse.wheel(0, deltaY);
    if (pinch) await page.keyboard.up("Control");
    return distance();
  };

  // Default: wheel down zooms out (the distance grows), wheel up zooms in.
  const d0 = await distance();
  const d1 = await wheel(200);
  expect(d1, "wheel down zooms out by default").toBeGreaterThan(d0);
  const d2 = await wheel(-200);
  expect(d2, "wheel up zooms in by default").toBeLessThan(d1);

  // The setting is in the settings dialog, display tab, and nowhere else.
  await page.getByTestId("settings-button").click();
  await expect(page.getByTestId("setting-wheel-zoom")).toBeVisible();
  await expect(page.getByTestId("wheel-zoom-down-out")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("wheel-zoom-down-out")).toHaveText("Wheel down: zoom out");
  await page.getByTestId("wheel-zoom-down-in").click();
  await expect(page.getByTestId("wheel-zoom-down-in")).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => localStorage.getItem("halfcube.settings.wheelZoom"))).toBe("down-in");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);

  // Applies at once: wheel down now zooms in, wheel up zooms out.
  const e0 = await distance();
  const e1 = await wheel(200);
  expect(e1, "wheel down zooms in after the change").toBeLessThan(e0);
  const e2 = await wheel(-200);
  expect(e2, "wheel up zooms out after the change").toBeGreaterThan(e1);
  // A pinch (Ctrl + wheel) keeps its own direction: spreading the fingers (negative delta) zooms in, whatever the setting.
  const p1 = await wheel(-30, true);
  expect(p1, "a pinch is not turned around").toBeLessThan(e2);

  // Reload: still stored, still applied, and the dialog shows it.
  await page.reload();
  await expect(page.getByTestId("loading-screen")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("tool-sketch")).toBeEnabled({ timeout: 60_000 });
  expect(await page.evaluate(() => localStorage.getItem("halfcube.settings.wheelZoom"))).toBe("down-in");
  const r0 = await distance();
  const r1 = await wheel(200);
  expect(r1, "wheel down still zooms in after a reload").toBeLessThan(r0);
  await page.getByTestId("settings-button").click();
  await expect(page.getByTestId("wheel-zoom-down-in")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("wheel-zoom-down-out")).toHaveAttribute("aria-checked", "false");
  expect(app.errors).toEqual([]);
});

for (const lang of ["en", "de"] as const) {
  test(`the wheel zoom setting is worded for a non-technical user (${lang === "de" ? "German" : "English"})`, async ({ app }) => {
    const { page } = app;
    await openMain(app, `lang=${lang}&settings=display`);
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    const text = lang === "de"
      ? { label: "Zoomrichtung des Mausrads", out: "Mausrad nach unten: herauszoomen", in: "Mausrad nach unten: hineinzoomen" }
      : { label: "Mouse wheel zoom direction", out: "Wheel down: zoom out", in: "Wheel down: zoom in" };
    await expect(page.getByTestId("setting-wheel-zoom")).toContainText(text.label);
    await expect(page.getByTestId("wheel-zoom-down-out")).toHaveText(text.out);
    await expect(page.getByTestId("wheel-zoom-down-in")).toHaveText(text.in);
    // Both choices are shown in full: nothing is cut off at the narrowest window.
    await app.setWidth(NARROWEST_WIDTH);
    for (const id of ["wheel-zoom-down-out", "wheel-zoom-down-in"]) {
      const metrics = await page.getByTestId(id).evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
      expect(metrics.scroll, `${id} is not truncated`).toBeLessThanOrEqual(metrics.client);
    }
    expect(app.errors).toEqual([]);
  });
}

test("the welcome screen's new project opens the main window with an empty document, and a reload stays there", async ({ app }) => {
  const { page } = app;
  await app.open("?lang=en");
  const welcome = page.getByRole("dialog", { name: "Sketch first, then build." });
  await expect(welcome).toBeVisible({ timeout: 60_000 });
  await welcome.getByRole("button", { name: "Next" }).click();
  await page.getByRole("dialog", { name: "How do you want to start?" }).getByRole("button", { name: /New project/ }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("timeline-track")).toContainText("No steps yet");
  await expect(page.getByTestId("tree-row-component:root")).toContainText("Part");
  await expect.poll(() => page.url()).toContain("screen=main");

  await page.reload();
  await expect(page.getByTestId("loading-screen")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("main-window")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

test("a reload keeps the open sketch with its steps and the working document", async ({ app }) => {
  const { page } = app;
  await openMain(app, "lang=en");
  await startSketchOnTop(page);
  const drawn = await page.evaluate(() => (window as unknown as Hooks).__halfcube?.editor?.addRectangle({ x: 0, y: 0 }, { x: 30, y: 20 }));
  expect(drawn?.ok).toBe(true);
  await expect.poll(() => page.url()).toContain("sketch=f1");

  await page.reload();
  await expect(page.getByTestId("loading-screen")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("finish-sketch")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("tab-sketch")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("status-bar")).toContainText("Sketch1 is being edited");
  await page.getByTestId("timeline-expand-f1").click();
  await expect(page.getByTestId("timeline-sub-steps-f1").getByRole("button")).toHaveCount(1); // the rectangle is one step

  // Finished, a reload keeps the sketch step but not the editing state.
  await page.getByTestId("finish-sketch").click();
  await expect(page.getByTestId("finish-sketch")).toHaveCount(0);
  await expect.poll(() => page.url()).not.toContain("sketch=");
  await page.reload();
  await expect(page.getByTestId("loading-screen")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("timeline-step-f1")).toBeVisible();
  await expect(page.getByTestId("finish-sketch")).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

test("an address that names a sketch the document does not have says so in our own dialog, in both languages, and starts without a sketch", async ({ app }) => {
  const { page } = app;
  const words = {
    en: { title: "The sketch from the address does not exist", text: "asks for the sketch “f99”", finish: "Finish sketch" },
    de: { title: "Die Skizze aus der Adresse gibt es nicht", text: "verlangt die Skizze „f99“", finish: "Skizze beenden" },
  } as const;
  for (const lang of ["en", "de"] as const) {
    await openMain(app, `lang=${lang}&sketch=f99`);
    const dialog = page.getByTestId("failure-dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toContainText(words[lang].title);
    await expect(dialog).toContainText("HC-MAIN-006");
    await expect(dialog).toContainText(words[lang].text);
    // The technical English line is behind the details and names the same id, so it can be copied.
    await expect(dialog).toContainText("The sketch \"f99\" from the address is not in the document.");
    await expect(page.getByTestId("finish-sketch")).toHaveCount(0); // the page started without an open sketch
  }
  expect(app.errors).toEqual([]);
});

test("no native dialog is used: the main window never calls alert, confirm or prompt", async ({ app }) => {
  const { page } = app;
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.type());
    void d.dismiss();
  });
  await openMain(app, "lang=en");
  await startSketchOnTop(page);
  await page.getByTestId("finish-sketch").click();
  await page.getByTestId("settings-button").click();
  await page.keyboard.press("Escape");
  expect(dialogs).toEqual([]);
});
