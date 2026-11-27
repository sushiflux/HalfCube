// The extrude command (step U3b), through the real window: the toolbar tool needs a finished sketch with a closed area, the area is
// picked in the 3D view with the mouse, the dialog previews through the engine (one side, the opposite direction, symmetric = total
// thickness), OK is ONE undo step with the step in the timeline and the body in the browser tree, Cancel leaves nothing, a double-click
// on the step or the body edits it, a changed sketch rebuilds the body, undo and redo reach across all steps, an engine that crashes
// while the dialog is open comes back with the same body, and fast typing ends on the last value (durchstich-engine.md 6.4, cases 5
// to 9). Runs in the Electron program (native engine).
import type { Page } from "@playwright/test";
import { expect, test, type AppUnderTest } from "../support/fixtures.ts";
import { expectNoHorizontalOverflow, expectNothingMoved, expectNotTruncated, snapshot, type Targets } from "../support/layout.ts";
import { NARROWEST_WIDTH } from "../support/paths.ts";
import { colourDistance, decodePng, meanColour } from "../support/png.ts";

interface BodyState {
  id: string;
  preview: boolean;
  volume: number;
  bbox: { min: { x: number; y: number; z: number } | number[]; max: { x: number; y: number; z: number } | number[] };
}
interface ModelState {
  bodies: BodyState[];
  steps: { id: string; state: string; code?: string }[];
  timeline: { id: string; type: string; name: string; sketch?: string; region?: string; extent?: string; distance?: number }[];
  documentBodies: { id: string; name: string; createdBy: string }[];
}

interface Hooks {
  __halfcube?: {
    model: unknown;
    editor: unknown;
    viewport: { worldToClient(p: [number, number, number]): { x: number; y: number } | null } | null;
    extrude: {
      getState(): Record<string, unknown> & { phase: string; profile: { sketchId: string; regionId: string } | null; form: { text: string; reversed: boolean; extent: string } };
      pick(ref: { sketchId: string; regionId: string }): void;
    } | null;
  };
  __halfcubeSession?: { client: { request(c: unknown): { reply: Promise<unknown> } }; getStatus(): { phase: string } };
}

async function openMain(app: AppUnderTest, search: string): Promise<void> {
  const { page } = app;
  await app.open(`?screen=main&${search}`);
  await expect(page.getByTestId("loading-screen")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("tool-sketch")).toBeEnabled({ timeout: 60_000 });
}

/** What the model layer holds right now: the bodies of the last answer, the step states, the document's steps and bodies. */
const readModel = (page: Page): Promise<ModelState> =>
  page.evaluate(() => {
    type Model = {
      getModelView(): { bodies: BodyState[]; steps: { featureId: string; state: string; problem?: { code: string } }[] };
      document: { getSnapshot(): { timeline: Record<string, unknown>[]; components: { bodies: { id: string; name: string; createdBy: string }[] }[] } };
    };
    const model = (window as unknown as Hooks).__halfcube?.model as Model | undefined;
    if (!model) throw new Error("no model");
    const view = model.getModelView();
    const doc = model.document.getSnapshot();
    return {
      bodies: view.bodies.map((b) => ({ id: b.id, preview: b.preview, volume: b.volume, bbox: b.bbox })),
      steps: view.steps.map((s) => ({ id: s.featureId, state: s.state, ...(s.problem ? { code: s.problem.code } : {}) })),
      timeline: doc.timeline.map((f) => ({
        id: f.id as string,
        type: f.type as string,
        name: f.name as string,
        ...(f.type === "extrude"
          ? { sketch: (f.profile as { sketch: string }).sketch, region: (f.profile as { region: string }).region, extent: f.extent as string, distance: (f.distance as { value: number }).value }
          : {}),
      })),
      documentBodies: (doc.components[0]?.bodies ?? []).map((b) => ({ id: b.id, name: b.name, createdBy: b.createdBy })),
    };
  });

const z = (p: BodyState["bbox"]["min"], axis: "x" | "y" | "z"): number => (Array.isArray(p) ? p[{ x: 0, y: 1, z: 2 }[axis]]! : (p as Record<string, number>)[axis]!);

/** The body of the engine's last answer that is (or is not) a preview. */
async function lastBody(page: Page, preview: boolean): Promise<BodyState | undefined> {
  return (await readModel(page)).bodies.find((b) => b.preview === preview);
}

async function expectPreviewVolume(page: Page, volume: number): Promise<void> {
  await expect.poll(async () => (await lastBody(page, true))?.volume ?? -1, { message: `the preview body has the volume ${volume}`, timeout: 20_000 }).toBeCloseTo(volume, 3);
}

/**
 * A sketch on the top plane with a 40 x 25 rectangle (drawn through the function the sketch tools call), finished. Waits until the
 * toolbar's extrude tool has learned (from the engine) that the sketch has a closed area.
 */
async function makeSketchWithRectangle(page: Page, width = 40, height = 25, extraCircle = false): Promise<void> {
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("tree-row-plane:xy").click();
  await expect(page.getByTestId("finish-sketch")).toBeVisible({ timeout: 30_000 });
  const drawn = await page.evaluate(([w, h]) => (window as unknown as { __halfcube: { editor: { addRectangle(a: unknown, b: unknown): Promise<{ ok: boolean }> } } }).__halfcube.editor.addRectangle({ x: 0, y: 0 }, { x: w, y: h }), [width, height] as const);
  expect(drawn.ok).toBe(true);
  if (extraCircle) {
    // A second, separate closed area in the same sketch: the command cannot know which one is meant, so it asks.
    const circle = await page.evaluate(() => (window as unknown as { __halfcube: { editor: { addCircle(c: unknown, d: unknown): Promise<{ ok: boolean }> } } }).__halfcube.editor.addCircle({ x: 80, y: 12 }, { value: 16, unit: "mm" }));
    expect(circle.ok).toBe(true);
  }
  await page.getByTestId("finish-sketch").click();
  await expect(page.getByTestId("tab-sketch")).toHaveCount(0);
  await expect(page.getByTestId("tool-extrude")).toBeEnabled({ timeout: 30_000 });
}

/** The start view (front, right, above): every origin plane can be seen and clicked. */
const goHome = (page: Page): Promise<void> =>
  page.evaluate(() => (window as unknown as { __halfcube: { viewport: { goHome(animate: boolean): void } } }).__halfcube.viewport.goHome(false));

/** Page coordinates of a world point in the 3D view. */
const clientAt = (page: Page, p: [number, number, number]): Promise<{ x: number; y: number }> =>
  page.evaluate((point) => {
    const at = (window as unknown as Hooks).__halfcube?.viewport?.worldToClient(point);
    if (!at) throw new Error("the point is not in the view");
    return { x: at.x, y: at.y };
  }, p);

/**
 * Starts the command when the sketch that was just finished is still selected and has exactly one area: the dialog opens at once
 * with that area (nothing is left to ask).
 */
async function startExtrude(page: Page): Promise<void> {
  await page.getByTestId("tool-extrude").click();
  await expect(page.getByTestId("extrude-dialog")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("pick-profile-hint")).toHaveCount(0);
}

/** Starts the command where it has to ask (several areas) and picks the rectangle with a real click on it. */
async function startAndPick(page: Page, mid: [number, number, number] = [20, 12.5, 0]): Promise<void> {
  await page.getByTestId("tool-extrude").click();
  await expect(page.getByTestId("pick-profile-hint")).toBeVisible();
  await goHome(page);
  const at = await clientAt(page, mid);
  await page.mouse.move(at.x, at.y, { steps: 4 });
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByTestId("extrude-dialog")).toBeVisible({ timeout: 15_000 });
}

const distanceField = (page: Page) => page.getByTestId("extrude-distance");

function layoutTargets(page: Page): Targets {
  return {
    titlebar: page.getByTestId("titlebar"),
    toolbar: page.getByTestId("toolbar"),
    tree: page.getByTestId("browser-tree"),
    contextBar: page.getByTestId("context-bar"),
    viewport: page.getByTestId("viewport"),
    timeline: page.getByTestId("timeline"),
    statusBar: page.getByTestId("status-bar"),
  };
}

// ----------------------------------------------------------------------------------------------------------------------- 6.4 #5

test("the Extrude tool needs a finished sketch with a closed area: a sketch that is still open does not count", async ({ app }) => {
  const { page } = app;
  await openMain(app, "lang=en");
  await expect(page.getByTestId("tool-extrude")).toBeDisabled();
  await page.getByTestId("tool-extrude").hover();
  await expect(page.getByTestId("tool-extrude").locator("xpath=ancestor::span[@data-tip][1]")).toHaveAttribute("data-tip", /closed area/);

  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("tree-row-plane:xy").click();
  await expect(page.getByTestId("finish-sketch")).toBeVisible({ timeout: 30_000 });
  // Two lines are no area.
  await page.evaluate(async () => {
    type Editor = { getView(): { points: { id: string }[] }; addLine(a: unknown, b: unknown): Promise<unknown> };
    const editor = (window as unknown as { __halfcube: { editor: Editor } }).__halfcube.editor;
    await editor.addLine({ x: 0, y: 0 }, { x: 30, y: 0 });
    const end = editor.getView().points[1]!.id;
    await editor.addLine({ snap: end }, { x: 30, y: 20 });
  });
  await page.getByTestId("finish-sketch").click();
  await expect(page.getByTestId("tab-sketch")).toHaveCount(0);
  await expect(page.getByTestId("tool-sketch")).toBeEnabled();
  await page.waitForTimeout(600); // the engine has had time to answer for the sketch
  await expect(page.getByTestId("tool-extrude")).toBeDisabled();

  // Closing the third side makes an area: the sketch is opened again, the tool follows without a click.
  await page.getByTestId("timeline-step-f1").dblclick();
  await expect(page.getByTestId("finish-sketch")).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    const editor = (window as unknown as { __halfcube: { editor: { getView(): { points: { id: string }[] }; addLine(a: unknown, b: unknown): Promise<unknown> } } }).__halfcube.editor;
    const ids = editor.getView().points.map((p) => p.id);
    return editor.addLine({ snap: ids[0]! }, { snap: ids[ids.length - 1]! });
  });
  await page.getByTestId("finish-sketch").click();
  await expect(page.getByTestId("tool-extrude")).toBeEnabled({ timeout: 30_000 });
  expect(app.errors).toEqual([]);
});

test("pick the area with a real click: dialog and live preview for one side, the opposite direction and symmetric (total thickness)", async ({ app }) => {
  const { page } = app;
  await openMain(app, "lang=en");
  await makeSketchWithRectangle(page, 40, 25, true);
  await startAndPick(page);

  // The dialog says which area it extrudes and starts with 10 mm, one side, a new body; the preview is the engine's body.
  const dialog = page.getByTestId("extrude-dialog");
  await expect(dialog).toHaveAttribute("data-mode", "create");
  await expect(page.getByTestId("extrude-profile")).toHaveText(/^Area \d · Sketch1$/);
  await expect(distanceField(page)).toHaveValue("10");
  await expect(distanceField(page)).toBeFocused();
  await expect(page.getByTestId("extrude-one-side")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("extrude-new-body")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: "Join" })).toBeDisabled();
  await expectPreviewVolume(page, 40 * 25 * 10);
  let body = (await lastBody(page, true))!;
  expect(z(body.bbox.min, "z")).toBeCloseTo(0, 6);
  expect(z(body.bbox.max, "z")).toBeCloseTo(10, 6);
  // The step is in the timeline as a draft after the sketch, marked in progress; nothing is committed yet.
  await expect(page.locator("[data-testid^='timeline-step-'][data-draft]")).toHaveAttribute("aria-label", /\(in progress\)/);
  expect((await readModel(page)).timeline.map((f) => f.type)).toEqual(["sketch"]);
  await expect(page.getByTestId("undo")).toBeDisabled();

  // Every keystroke is previewed.
  await distanceField(page).fill("20");
  await expectPreviewVolume(page, 40 * 25 * 20);
  // The opposite direction: the body grows against the sketch normal.
  await page.getByTestId("extrude-flip").click();
  await expect(page.getByTestId("extrude-flip")).toHaveAttribute("aria-pressed", "true");
  await expectPreviewVolume(page, 40 * 25 * 20);
  await expect.poll(async () => z((await lastBody(page, true))!.bbox.min, "z")).toBeCloseTo(-20, 6);
  body = (await lastBody(page, true))!;
  expect(z(body.bbox.max, "z")).toBeCloseTo(0, 6);
  // Symmetric: the value is the TOTAL thickness, half on each side, and the flip has nothing to do.
  await page.getByTestId("extrude-symmetric").click();
  await expect(page.getByTestId("extrude-flip")).toBeDisabled();
  await expect.poll(async () => z((await lastBody(page, true))!.bbox.min, "z")).toBeCloseTo(-10, 6);
  body = (await lastBody(page, true))!;
  expect(z(body.bbox.max, "z")).toBeCloseTo(10, 6);
  expect(body.volume).toBeCloseTo(40 * 25 * 20, 3);
  // Back to one side: the direction the user had comes back.
  await page.getByTestId("extrude-one-side").click();
  await expect.poll(async () => z((await lastBody(page, true))!.bbox.min, "z")).toBeCloseTo(-20, 6);

  // Esc cancels from the field: no body, no step, the dialog and the draft step are gone.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("[data-testid^='timeline-step-'][data-draft]")).toHaveCount(0);
  await expect.poll(async () => (await readModel(page)).bodies.length).toBe(0);
  const state = await readModel(page);
  expect(state.timeline.map((f) => f.type)).toEqual(["sketch"]);
  expect(state.documentBodies).toEqual([]);
  expect(app.errors).toEqual([]);
});

test("OK is ONE undo step: the step follows its sketch in the timeline with the extrude icon, the body is in the tree; Cancel leaves nothing", async ({ app }) => {
  const { page } = app;
  await openMain(app, "lang=en");
  await makeSketchWithRectangle(page);
  const before = await readModel(page);
  expect(before.timeline.map((f) => f.type)).toEqual(["sketch"]);

  // Cancel button: nothing.
  await startExtrude(page);
  await distanceField(page).fill("33");
  await page.getByTestId("extrude-cancel").click();
  await expect(page.getByTestId("extrude-dialog")).toHaveCount(0);
  await expect.poll(async () => (await readModel(page)).bodies.length).toBe(0);
  expect((await readModel(page)).timeline).toEqual(before.timeline);

  // The corner button cancels as well.
  await startExtrude(page);
  await page.getByTestId("extrude-close").click();
  await expect(page.getByTestId("extrude-dialog")).toHaveCount(0);
  expect((await readModel(page)).timeline).toEqual(before.timeline);

  // OK with 12.5 mm.
  const undoSteps = () =>
    // How many undo steps the document has: undo all of them through the model, then redo all of them (the document ends as it was).
    page.evaluate(() => {
      const model = (window as unknown as { __halfcube: { model: { undo(): boolean; redo(): boolean } } }).__halfcube.model;
      let n = 0;
      while (model.undo()) n++;
      for (let i = 0; i < n; i++) model.redo();
      return n;
    });
  const stepsBefore = await undoSteps();
  await startExtrude(page);
  await distanceField(page).fill("12.5");
  await expectPreviewVolume(page, 40 * 25 * 12.5);
  await page.getByTestId("extrude-ok").click();
  await expect(page.getByTestId("extrude-dialog")).toHaveCount(0);

  const state = await expect
    .poll(async () => (await lastBody(page, false))?.volume ?? -1, { message: "the committed body arrives", timeout: 20_000 })
    .toBeCloseTo(40 * 25 * 12.5, 3)
    .then(() => readModel(page));
  expect(state.bodies.filter((b) => b.preview)).toHaveLength(0);
  expect(state.timeline.map((f) => [f.type, f.name])).toEqual([
    ["sketch", "Sketch1"],
    ["extrude", "Extrude1"],
  ]);
  const step = state.timeline[1]!;
  expect(step).toMatchObject({ sketch: "f1", extent: "oneSide", distance: 12.5 });
  expect(state.documentBodies).toEqual([{ id: expect.any(String), name: "Body1", createdBy: step.id }]);

  // The timeline: the extrude step with its icon right after the sketch step, not marked as a draft; selected.
  const stepButton = page.getByTestId(`timeline-step-${step.id}`);
  await expect(stepButton).toBeVisible();
  await expect(stepButton).toHaveAccessibleName("Extrude1");
  await expect(stepButton).not.toHaveAttribute("data-draft", "");
  await expect(stepButton).toHaveAttribute("data-state", "ok");
  await expect(stepButton.locator("svg")).toHaveCount(1);
  const order = await page.locator("[data-testid^='timeline-step-']").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(order).toEqual(["timeline-step-f1", `timeline-step-${step.id}`]);
  await expect(page.getByTestId("timeline-position")).toContainText("step 2 of 2");
  // The tree: a folder "Bodies" with the body, selected after OK.
  await expect(page.getByTestId("tree-row-folder:bodies")).toContainText("Bodies");
  const bodyRow = page.getByTestId(`tree-row-body:${state.documentBodies[0]!.id}`);
  await expect(bodyRow).toContainText("Body1");
  await expect(bodyRow).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("status-selection")).toContainText("Body1");

  // ONE undo step more than before; one undo takes the step and the body away, one redo brings both back.
  expect(await undoSteps()).toBe(stepsBefore + 1);
  await page.getByTestId("undo").click();
  await expect(stepButton).toHaveCount(0);
  await expect.poll(async () => (await lastBody(page, false)) === undefined).toBe(true);
  await expect(page.getByTestId("tree-row-folder:bodies")).toHaveCount(0);
  await page.getByTestId("redo").click();
  await expect(stepButton).toBeVisible();
  await expect.poll(async () => (await lastBody(page, false))?.volume ?? -1).toBeCloseTo(40 * 25 * 12.5, 3);
  expect(app.errors).toEqual([]);
});

test("Enter in the field confirms; a wrong value says why on every keystroke, blocks OK and moves nothing; the engine keeps the last good preview", async ({ app }) => {
  const { page } = app;
  await openMain(app, "lang=en");
  await makeSketchWithRectangle(page);
  await startExtrude(page);
  await expectPreviewVolume(page, 10_000);
  await expectNoHorizontalOverflow(page, "main window with the extrude dialog");

  const targets: Targets = { ...layoutTargets(page), dialog: page.getByTestId("extrude-dialog"), hint: page.getByTestId("extrude-hint"), ok: page.getByTestId("extrude-ok"), field: distanceField(page) };
  const calm = await snapshot(page, targets);
  const field = page.getByTestId("extrude-distance").locator("..");
  await expect(field).toHaveAttribute("data-look", "dimension");
  await expect(field).toHaveAttribute("data-tone", "active");

  const hint = page.getByTestId("extrude-hint");
  await expect(hint).toContainText("The area is pulled to one side");
  const cases: [string, RegExp][] = [
    ["", /Please enter a value/],
    ["abc", /“abc” is not a number/],
    ["0", /greater than 0/],
    ["-5", /Reverse direction/],
    ["30°", /A length is expected here/],
    ["1e9", /too large/],
  ];
  for (const [text, message] of cases) {
    await distanceField(page).fill(text);
    // The message is there before any blur or click: the field is red (aria-invalid, text, never colour alone), OK is off.
    await expect(hint).toContainText(message);
    await expect(hint).toHaveAttribute("data-invalid", "true");
    await expect(distanceField(page)).toHaveAttribute("aria-invalid", "true");
    await expect(field).toHaveAttribute("data-tone", "invalid");
    await expect(page.getByTestId("extrude-ok")).toBeDisabled();
    await expectNotTruncated(hint, `hint for "${text}"`);
    expectNothingMoved(calm, await snapshot(page, targets), `message for "${text}"`, { height: ["hint"] });
  }
  // Wrong values were never sent: the preview still shows the last good value.
  expect((await lastBody(page, true))?.volume).toBeCloseTo(10_000, 3);
  // Enter with a wrong value does nothing; a good value brings the calm state back, and Enter confirms.
  await distanceField(page).fill("");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("extrude-dialog")).toBeVisible();
  await distanceField(page).fill("8");
  await expect(hint).not.toHaveAttribute("data-invalid", "true");
  await expect(page.getByTestId("extrude-ok")).toBeEnabled();
  expectNothingMoved(calm, await snapshot(page, targets), "good value again", { height: ["hint"] });
  await expectPreviewVolume(page, 8_000);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("extrude-dialog")).toHaveCount(0);
  await expect.poll(async () => (await lastBody(page, false))?.volume ?? -1).toBeCloseTo(8_000, 3);
  expect(app.errors).toEqual([]);
});

test("the command asks for an area when several exist, Esc ends it from the view, a selected sketch with one area starts the dialog at once", async ({ app }) => {
  const { page } = app;
  await openMain(app, "lang=en");
  await makeSketchWithRectangle(page, 40, 25, true);
  // A second sketch on another plane: two areas to choose from.
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("tree-row-plane:xz").click();
  await expect(page.getByTestId("finish-sketch")).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => (window as unknown as { __halfcube: { editor: { addCircle(c: unknown, d: unknown): Promise<unknown> } } }).__halfcube.editor.addCircle({ x: 60, y: 20 }, { value: 16, unit: "mm" }));
  await page.getByTestId("finish-sketch").click();
  await expect(page.getByTestId("tool-extrude")).toBeEnabled({ timeout: 30_000 });
  const second = (await readModel(page)).timeline.at(-1)!.id;

  // The first sketch (two areas) is selected: the command cannot know which one is meant, so it asks.
  await page.getByTestId("timeline-step-f1").click();
  await page.getByTestId("tool-extrude").click();
  await expect(page.getByTestId("pick-profile-hint")).toBeVisible();
  await expect(page.getByTestId("tool-extrude")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("extrude-dialog")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pick-profile-hint")).toHaveCount(0);
  await expect(page.getByTestId("tool-extrude")).toHaveAttribute("aria-pressed", "false");
  // A second click on the tool also ends the asking.
  await page.getByTestId("tool-extrude").click();
  await expect(page.getByTestId("pick-profile-hint")).toBeVisible();
  await page.getByTestId("tool-extrude").click();
  await expect(page.getByTestId("pick-profile-hint")).toHaveCount(0);

  // The sketch step of the circle is selected (it has one area): the dialog opens at once with that area.
  await page.getByTestId(`timeline-step-${second}`).click();
  await page.getByTestId("tool-extrude").click();
  await expect(page.getByTestId("extrude-dialog")).toBeVisible();
  await expect(page.getByTestId("extrude-profile")).toHaveText("Area 1 · Sketch2");
  await expectPreviewVolume(page, Math.PI * 8 * 8 * 10);
  // While the dialog is open the rest of the window waits: the other tools say why, undo is off.
  await expect(page.getByTestId("tool-sketch")).toBeDisabled();
  await expect(page.getByTestId("undo")).toBeDisabled();
  // Another area in the view switches the profile and keeps the typed value.
  await distanceField(page).fill("7");
  await goHome(page);
  const at = await clientAt(page, [20, 12.5, 0]);
  await page.mouse.move(at.x, at.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByTestId("extrude-profile")).toHaveText(/^Area \d · Sketch1$/);
  await expect(distanceField(page)).toHaveValue("7");
  await expectPreviewVolume(page, 40 * 25 * 7);
  await page.getByTestId("extrude-cancel").click();
  await expect(page.getByTestId("extrude-dialog")).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

// ----------------------------------------------------------------------------------------------------------------------- 6.4 #6

test("a double-click on the step or on the body edits the extrusion with the same dialog; editing the sketch afterwards rebuilds the body", async ({ app }) => {
  const { page } = app;
  await openMain(app, "lang=en");
  await makeSketchWithRectangle(page);
  await startExtrude(page);
  await distanceField(page).fill("10");
  await page.getByTestId("extrude-symmetric").click();
  await expectPreviewVolume(page, 10_000);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("extrude-dialog")).toHaveCount(0);
  await expect.poll(async () => (await lastBody(page, false))?.volume ?? -1).toBeCloseTo(10_000, 3);
  const { timeline, documentBodies } = await readModel(page);
  const step = timeline[1]!;
  const stepButton = page.getByTestId(`timeline-step-${step.id}`);

  // Double-click on the step: the dialog comes with the values the step has (symmetric, 10).
  await stepButton.dblclick();
  const dialog = page.getByTestId("extrude-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-mode", "edit");
  await expect(page.getByTestId("extrude-symmetric")).toHaveAttribute("aria-checked", "true");
  await expect(distanceField(page)).toHaveValue("10");
  await expect(page.getByTestId("extrude-profile")).toHaveText("Area 1 · Sketch1");
  await expect(page.getByTestId("status-bar")).toContainText("Extrude1 is being edited");
  await expect(stepButton).toHaveAttribute("data-editing", "true");
  // The step stays where it is (no second draft step), and the old body gives way to the preview.
  await expect(page.locator("[data-testid^='timeline-step-']")).toHaveCount(2);
  await distanceField(page).fill("6");
  await expectPreviewVolume(page, 40 * 25 * 6);
  await page.getByTestId("extrude-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await lastBody(page, false))?.volume ?? -1).toBeCloseTo(10_000, 3); // nothing changed

  // Double-click on the body in the tree does the same; OK changes the same step (still one step, one body) in ONE undo step.
  await page.getByTestId(`tree-row-body:${documentBodies[0]!.id}`).dblclick();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-mode", "edit");
  await distanceField(page).fill("6");
  await page.getByTestId("extrude-one-side").click();
  await page.getByTestId("extrude-flip").click();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await lastBody(page, false))?.volume ?? -1).toBeCloseTo(40 * 25 * 6, 3);
  const edited = await readModel(page);
  expect(edited.timeline).toHaveLength(2);
  expect(edited.documentBodies).toHaveLength(1);
  expect(edited.timeline[1]).toMatchObject({ id: step.id, extent: "oneSide", distance: -6 });
  expect(z((await lastBody(page, false))!.bbox.min, "z")).toBeCloseTo(-6, 6);
  await page.getByTestId("undo").click();
  await expect.poll(async () => (await lastBody(page, false))?.volume ?? -1).toBeCloseTo(10_000, 3);
  expect((await readModel(page)).timeline[1]).toMatchObject({ extent: "symmetric", distance: 10 });
  await page.getByTestId("redo").click();
  await expect.poll(async () => (await lastBody(page, false))?.volume ?? -1).toBeCloseTo(40 * 25 * 6, 3);

  // Edit the sketch: a dimension makes the bottom edge 60 mm; "Finish sketch" rebuilds the body with the new size.
  await page.getByTestId("timeline-step-f1").dblclick();
  await expect(page.getByTestId("finish-sketch")).toBeVisible({ timeout: 30_000 });
  const widthAfter = await page.evaluate(async () => {
    type View = { points: { id: string; x: number; y: number }[]; lines: { id: string; p1: string; p2: string }[] };
    const editor = (window as unknown as { __halfcube: { editor: { getView(): View; addDimension(k: string, refs: string[], v: unknown, label: unknown): Promise<{ ok: boolean }> } } }).__halfcube.editor;
    const view = editor.getView();
    const at = (id: string) => view.points.find((p) => p.id === id)!;
    const bottom = view.lines.find((l) => at(l.p1).y === at(l.p2).y && at(l.p1).y === Math.min(...view.points.map((p) => p.y)))!;
    const outcome = await editor.addDimension("distance", [bottom.id], { value: 60, unit: "mm" }, { x: 30, y: -8 });
    if (!outcome.ok) throw new Error("the dimension was refused");
    const after = editor.getView();
    const xs = after.points.map((p) => p.x);
    const ys = after.points.map((p) => p.y);
    return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  });
  expect(widthAfter.width).toBeCloseTo(60, 6);
  // While the sketch is open the body is not rebuilt (it is, when the sketch is finished).
  await page.getByTestId("finish-sketch").click();
  await expect(page.getByTestId("tab-sketch")).toHaveCount(0);
  await expect.poll(async () => (await lastBody(page, false))?.volume ?? -1, { timeout: 20_000 }).toBeCloseTo(widthAfter.width * widthAfter.height * 6, 3);
  const rebuilt = await readModel(page);
  expect(rebuilt.steps.every((s) => s.state === "ok")).toBe(true);
  expect(rebuilt.timeline).toHaveLength(2);
  expect(app.errors).toEqual([]);
});

test("when a changed sketch no longer has the area of a step, the step fails with its reason; editing it asks for the area again and never guesses", async ({ app }) => {
  const { page } = app;
  await openMain(app, "lang=en");
  await makeSketchWithRectangle(page);
  await startExtrude(page);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("extrude-dialog")).toHaveCount(0);
  const step = (await readModel(page)).timeline[1]!;
  await expect.poll(async () => (await lastBody(page, false))?.volume ?? -1).toBeCloseTo(10_000, 3);

  // A circle inside the rectangle makes a hole: the area's key changes, the step cannot find its area any more.
  await page.getByTestId("timeline-step-f1").dblclick();
  await expect(page.getByTestId("finish-sketch")).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => (window as unknown as { __halfcube: { editor: { addCircle(c: unknown, d: unknown): Promise<unknown> } } }).__halfcube.editor.addCircle({ x: 20, y: 12 }, { value: 10, unit: "mm" }));
  await page.getByTestId("finish-sketch").click();
  await expect(page.getByTestId("tab-sketch")).toHaveCount(0);
  await expect(page.getByTestId(`timeline-step-${step.id}`)).toHaveAttribute("data-state", "error", { timeout: 20_000 });
  expect((await readModel(page)).steps.find((s) => s.id === step.id)?.code).toBe("profile_not_found");

  // Edit the step: the dialog says the area is gone and asks for a new one; OK waits for it.
  await page.getByTestId(`timeline-step-${step.id}`).dblclick();
  await expect(page.getByTestId("extrude-dialog")).toBeVisible();
  await expect(page.getByTestId("extrude-profile-gone")).toContainText("no longer exists");
  await expect(page.getByTestId("extrude-profile")).toHaveText("No area chosen");
  await expect(page.getByTestId("extrude-ok")).toBeDisabled();
  // The ring (rectangle with the hole) is picked far from the dialog, between the hole and the outline.
  await goHome(page);
  const ring = await clientAt(page, [35, 20, 0]);
  await page.mouse.move(ring.x, ring.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByTestId("extrude-profile")).toHaveText(/^Area \d · Sketch1$/);
  await expect(page.getByTestId("extrude-profile-gone")).toHaveCount(0);
  await expect(page.getByTestId("extrude-ok")).toBeEnabled();
  await expectPreviewVolume(page, (40 * 25 - Math.PI * 25) * 10);
  await page.getByTestId("extrude-ok").click();
  await expect(page.getByTestId("extrude-dialog")).toHaveCount(0);
  await expect(page.getByTestId(`timeline-step-${step.id}`)).toHaveAttribute("data-state", "ok", { timeout: 20_000 });
  expect(app.errors).toEqual([]);
});

// ----------------------------------------------------------------------------------------------------------------------- 6.4 #7

test("undo and redo reach across all steps: sketch, rectangle, extrusion and an edited extrusion, by button and by Ctrl+Z / Ctrl+Y", async ({ app }) => {
  const { page } = app;
  await openMain(app, "lang=en");
  await makeSketchWithRectangle(page);
  await startExtrude(page);
  await distanceField(page).fill("10");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("extrude-dialog")).toHaveCount(0);
  await expect.poll(async () => (await lastBody(page, false))?.volume ?? -1).toBeCloseTo(10_000, 3);
  const extrudeId = (await readModel(page)).timeline[1]!.id;
  await page.getByTestId(`timeline-step-${extrudeId}`).dblclick();
  await distanceField(page).fill("30");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("extrude-dialog")).toHaveCount(0);
  await expect.poll(async () => (await lastBody(page, false))?.volume ?? -1).toBeCloseTo(30_000, 3);

  const stateName = async () => {
    const s = await readModel(page);
    return `${s.timeline.map((f) => f.type).join("+")}|bodies=${s.documentBodies.length}`;
  };
  expect(await stateName()).toBe("sketch+extrude|bodies=1");

  // Undo 1: the edit of the extrusion (back to 10 mm).
  await page.getByTestId("undo").click();
  await expect.poll(async () => (await lastBody(page, false))?.volume ?? -1).toBeCloseTo(10_000, 3);
  // Undo 2 (Ctrl+Z): the extrusion and its body.
  await page.getByTestId("viewport").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+z");
  await expect.poll(stateName).toBe("sketch|bodies=0");
  await expect.poll(async () => (await lastBody(page, false)) === undefined).toBe(true);
  // Undo 3: the rectangle, undo 4: the sketch itself.
  await page.getByTestId("undo").click();
  await expect.poll(async () => (await readModel(page)).timeline.length).toBe(1);
  await page.getByTestId("undo").click();
  await expect.poll(stateName).toBe("|bodies=0");
  await expect(page.getByTestId("undo")).toBeDisabled();
  await expect(page.getByTestId("tool-extrude")).toBeDisabled();

  // Redo everything: the sketch, the rectangle, the extrusion at 10 mm, its edit at 30 mm.
  await page.getByTestId("redo").click();
  await page.getByTestId("redo").click();
  await expect.poll(stateName).toBe("sketch|bodies=0");
  await page.keyboard.press("Control+y");
  await expect.poll(stateName).toBe("sketch+extrude|bodies=1");
  await expect.poll(async () => (await lastBody(page, false))?.volume ?? -1).toBeCloseTo(10_000, 3);
  await page.getByTestId("redo").click();
  await expect.poll(async () => (await lastBody(page, false))?.volume ?? -1).toBeCloseTo(30_000, 3);
  await expect(page.getByTestId("redo")).toBeDisabled();
  await expect(page.getByTestId(`tree-row-body:${(await readModel(page)).documentBodies[0]!.id}`)).toBeVisible();
  expect(app.errors).toEqual([]);
});

// ----------------------------------------------------------------------------------------------------------------------- 6.4 #8

test("the engine crashes while the dialog is open: a notice says so and keeps the input, the engine restarts, the preview of the same body comes back", async ({ app }) => {
  const { page } = app;
  // The native engine process is simply ended from outside (app.crashEngine).
  await openMain(app, "lang=en");
  await makeSketchWithRectangle(page);
  await startExtrude(page);
  await expectPreviewVolume(page, 10_000);
  const idBefore = (await lastBody(page, true))!.id;
  const crashed = await app.crashEngine();
  expect(crashed, "the engine was ended on purpose").toBe(true);
  // While the engine is down nothing can be computed: typing is accepted, the notice names the engine and keeps the values.
  await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).__halfcubeSession?.getStatus().phase), { timeout: 10_000 }).not.toBe("ready");
  await distanceField(page).fill("30");
  await expect(page.getByTestId("extrude-failure")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("extrude-failure")).toHaveAttribute("data-code", "HC-EXTRUDE-ENGINE");
  await expect(page.getByTestId("extrude-failure")).toContainText("did not compute the preview");
  await expect(distanceField(page)).toHaveValue("30");
  // The failure notice has the copy button with the complete text (skill ui-regeln).
  await expect(page.getByTestId("extrude-failure").getByRole("button", { name: "Copy" })).toBeVisible();

  // The engine is back: the notice goes, the preview is asked again with the typed value, it is the same body.
  await expect(page.getByTestId("extrude-failure")).toHaveCount(0, { timeout: 60_000 });
  await expectPreviewVolume(page, 30_000);
  expect((await lastBody(page, true))!.id).toBe(idBefore);
  // OK works as if nothing had happened.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("extrude-dialog")).toHaveCount(0);
  await expect.poll(async () => (await lastBody(page, false))?.volume ?? -1, { timeout: 20_000 }).toBeCloseTo(30_000, 3);
  expect((await lastBody(page, false))!.id).toBe(idBefore);
  expect(app.errors.filter((e) => !/engine|terminated|crash|exit/i.test(e))).toEqual([]);
});

// ----------------------------------------------------------------------------------------------------------------------- 6.4 #9

test("fast typing: the view ends on the last value", async ({ app }) => {
  const { page } = app;
  await openMain(app, "lang=en");
  await makeSketchWithRectangle(page);
  await startExtrude(page);
  await expectPreviewVolume(page, 10_000);
  // Digits as fast as the page takes them, then more, without waiting for any answer in between.
  await distanceField(page).fill("");
  await distanceField(page).pressSequentially("12345", { delay: 0 });
  await distanceField(page).press("Backspace");
  await distanceField(page).pressSequentially("678", { delay: 0 });
  await expect(distanceField(page)).toHaveValue("1234678");
  // 1234678 mm is more than 100 m: the field says so while the typing goes on.
  await expect(page.getByTestId("extrude-hint")).toContainText("too large");
  await distanceField(page).fill("");
  await distanceField(page).pressSequentially("4321", { delay: 0 });
  await distanceField(page).press("Backspace");
  await distanceField(page).pressSequentially("9", { delay: 0 });
  await expect(distanceField(page)).toHaveValue("4329");
  await expectPreviewVolume(page, 4329 * 1000);
  // After the last answer nothing else arrives that would change the view back to an older value.
  await page.waitForTimeout(500);
  expect((await lastBody(page, true))?.volume).toBeCloseTo(4329 * 1000, 3);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("extrude-dialog")).toHaveCount(0);
  await expect.poll(async () => (await lastBody(page, false))?.volume ?? -1).toBeCloseTo(4329 * 1000, 3);
  expect(app.errors).toEqual([]);
});

// ----------------------------------------------------------------------------------------------------------------------- German, narrowest width, the view

test("German: the dialog, the hint bar and the timeline in German with the decimal comma, at the narrowest width, nothing cut", async ({ app }) => {
  const { page } = app;
  await openMain(app, "lang=de");
  await makeSketchWithRectangle(page, 40, 25, true);
  const innerWidth = await app.setWidth(NARROWEST_WIDTH);
  test.info().annotations.push({ type: "width", description: `window ${NARROWEST_WIDTH} px, page ${innerWidth} px` });
  await expect(page.getByTestId("tool-extrude")).toContainText("Extrudieren");
  await page.getByTestId("tool-extrude").click();
  await expect(page.getByTestId("pick-profile-hint")).toContainText("Wähle die Fläche, die extrudiert werden soll");
  await expectNotTruncated(page.getByTestId("pick-profile-hint"), "pick hint");
  const at = await clientAt(page, [20, 12.5, 0]);
  await page.mouse.move(at.x, at.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  const dialog = page.getByTestId("extrude-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Extrudieren");
  await expect(dialog).toContainText("Profil");
  await expect(page.getByTestId("extrude-profile")).toHaveText(/^Fläche \d · Skizze1$/);
  await expect(page.getByTestId("extrude-one-side")).toHaveText("Eine Seite");
  await expect(page.getByTestId("extrude-symmetric")).toHaveText("Symmetrisch");
  await expect(page.getByTestId("extrude-new-body")).toHaveText("Neuer Körper");
  await expect(page.getByTestId("extrude-ok")).toHaveText("OK");
  await expect(page.getByTestId("extrude-cancel")).toHaveText("Abbrechen");
  await expect(page.getByTestId("extrude-close")).toHaveAccessibleName("Fenster „Extrudieren“ schließen");
  await expectNoHorizontalOverflow(page, "main window with the extrude dialog (German)");
  await expectPreviewVolume(page, 10_000);
  // A German decimal comma works and is previewed as a decimal number.
  await distanceField(page).fill("12,5");
  await expectPreviewVolume(page, 12_500);
  await distanceField(page).fill("abc");
  await expect(page.getByTestId("extrude-hint")).toContainText("„abc“ ist keine Zahl");
  await expectNotTruncated(page.getByTestId("extrude-hint"), "German hint");
  await expect(page.locator("[data-testid^='timeline-step-'][data-draft]")).toHaveAttribute("aria-label", "Extrusion1 (in Arbeit)");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

test("the preview is drawn in the view, translucent, and goes away with Esc; the area is highlighted while the command asks for it", async ({ app }) => {
  const { page } = app;
  await openMain(app, "lang=en&theme=praezision&mode=light");
  await makeSketchWithRectangle(page);
  const host = page.getByTestId("viewport-host");
  const spot = async () => {
    await page.mouse.move(2, 2);
    await page.waitForTimeout(300);
    const img = decodePng(await host.screenshot());
    const box = (await host.boundingBox())!;
    const scale = img.width / box.width;
    const top = await clientAt(page, [20, 12.5, 10]); // the middle of the top face of the previewed body
    return meanColour(img, (top.x - box.x) * scale, (top.y - box.y) * scale, 2);
  };
  const empty = await spot();
  await startExtrude(page);
  await expectPreviewVolume(page, 10_000);
  await page.mouse.move(2, 2);
  await expect.poll(async () => colourDistance(await spot(), empty), { message: "the preview body is visible in the view", timeout: 10_000 }).toBeGreaterThan(8);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("extrude-dialog")).toHaveCount(0);
  await expect.poll(async () => colourDistance(await spot(), empty), { message: "the preview is gone again", timeout: 10_000 }).toBeLessThan(8);
  expect(app.errors).toEqual([]);
});

// ----------------------------------------------------------------------------------------------------------------------- screenshots

async function setMode(page: Page, mode: "light" | "dark"): Promise<void> {
  await page.getByTestId("settings-button").click();
  await page.getByTestId(`mode-${mode}`).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
}

test("screenshots of the real app for the report (extrude, light and dark)", async ({ app }, testInfo) => {
  test.skip(process.env.HALFCUBE_U3B_SHOTS === undefined, "only when HALFCUBE_U3B_SHOTS names a folder");
  const dir = process.env.HALFCUBE_U3B_SHOTS!;
  const { page } = app;
  await openMain(app, "lang=de&theme=praezision&mode=light");
  await page.setViewportSize({ width: 1440, height: 860 });
  await makeSketchWithRectangle(page, 40, 25, true);
  const home = () => page.evaluate(() => (window as unknown as { __halfcube: { viewport: { goHome(animate: boolean): void; whenIdle(): Promise<void> } } }).__halfcube.viewport.goHome(false));
  await home();
  const shoot = async (name: string) => {
    await page.mouse.move(2, 2);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${dir}/u3b-${name}.png` });
  };
  // 1) the command asks for an area; the pointer is over one of them
  await page.getByTestId("tool-extrude").click();
  await expect(page.getByTestId("pick-profile-hint")).toBeVisible();
  const over = await clientAt(page, [20, 12.5, 0]);
  await page.mouse.move(over.x, over.y, { steps: 4 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/u3b-profil-waehlen-hell.png` });
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByTestId("extrude-dialog")).toBeVisible();
  await distanceField(page).fill("18");
  await expectPreviewVolume(page, 40 * 25 * 18);
  await home();
  // 2) dialog with the preview, light and dark
  await shoot("dialog-vorschau-hell");
  await setMode(page, "dark");
  await shoot("dialog-vorschau-dunkel");
  await setMode(page, "light");
  // 3) a wrong value: the message under the field, the preview keeps the last good value
  await distanceField(page).fill("abc");
  await shoot("dialog-fehler-hell");
  await distanceField(page).fill("18");
  // 4) OK: the body with its step in the timeline and the body in the tree, light and dark
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("extrude-dialog")).toHaveCount(0);
  await expect.poll(async () => (await lastBody(page, false))?.volume ?? -1).toBeCloseTo(40 * 25 * 18, 3);
  await shoot("koerper-fertig-hell");
  await setMode(page, "dark");
  await shoot("koerper-fertig-dunkel");
  testInfo.annotations.push({ type: "screenshots", description: dir });
});
