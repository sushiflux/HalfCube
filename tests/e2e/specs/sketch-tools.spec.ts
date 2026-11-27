// The sketch tools (step U2b): drawing with the mouse and with typed values, dimensions until the sketch is fully determined and
// highlighted, the dialog for a contradicting dimension, dragging, undo and redo inside the sketch, the timeline's inner steps
// and the layout in German and English at the narrowest width. Runs in the Electron
// program (native engine). The mouse works on real pixels; where a test needs a position it asks the sketch layer (the dev
// channel exposes it as window.__halfcube.layer) where a sketch point is on the screen.
import type { Locator, Page } from "@playwright/test";
import { expect, test, type AppUnderTest } from "../support/fixtures.ts";
import { expectNoHorizontalOverflow, expectNothingMoved, expectNotTruncated, snapshot, type Targets } from "../support/layout.ts";
import { NARROWEST_WIDTH, type Lang } from "../support/paths.ts";
import { colourDistance, decodePng, meanColour } from "../support/png.ts";
import { serializeDocument } from "../../../app/src/document/validate.ts";
import { document as sampleDocument, rectangle } from "../../fixtures/engine/cases.ts";

interface PlainView {
  points: { id: string; x: number; y: number }[];
  lines: { id: string; p1: string; p2: string }[];
  circles: { id: string; center: string; radius: number }[];
  constraints: { id: string; kind: string; refs: string[] }[];
  dimensions: { id: string; kind: string; refs: string[]; value: { value: number; unit: string }; driving: boolean; measured?: number; reverse?: boolean[] }[];
  dof: number;
  status: string;
}

interface Hooks {
  __halfcube?: {
    editor: { getView(): PlainView } | null;
    layer: { toScreen(u: number, v: number): { x: number; y: number }; pxPerMm(): number } | null;
  };
}

const words: Record<Lang, { fully: string; under: string; rectangle: string; undoLimit: string; dialogTitle: string; asReference: string; cancel: string }> = {
  en: {
    fully: "Fully defined",
    under: "Under-defined",
    rectangle: "Rectangle",
    undoLimit: "Finish the sketch to undo further.",
    dialogTitle: "Dimension contradicts the sketch",
    asReference: "Add as reference dimension",
    cancel: "Cancel",
  },
  de: {
    fully: "Vollständig bestimmt",
    under: "Unterbestimmt",
    rectangle: "Rechteck",
    undoLimit: "Skizze beenden, um weiter rückgängig zu machen.",
    dialogTitle: "Maß widerspricht der Skizze",
    asReference: "Als Referenzmaß anlegen",
    cancel: "Abbrechen",
  },
};

async function openMain(app: AppUnderTest, search: string): Promise<void> {
  const { page } = app;
  await app.open(`?screen=main&${search}`);
  await expect(page.getByTestId("loading-screen")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("tool-sketch")).toBeEnabled({ timeout: 60_000 });
}

/** Opens the main window and a sketch on the top plane; waits until the tools and the palette are there. */
async function openSketch(app: AppUnderTest, search = "lang=en"): Promise<Page> {
  const { page } = app;
  await openMain(app, search);
  await page.getByTestId("tool-sketch").click();
  await page.getByTestId("tree-row-plane:xy").click();
  await expect(page.getByTestId("sketch-palette")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("tool-line")).toBeEnabled();
  await settled(page);
  return page;
}

/** The view turns to the sketch plane with a short animation; positions are only reliable once it has stopped. */
async function settled(page: Page): Promise<void> {
  let last = "";
  let still = 0;
  await expect
    .poll(
      async () => {
        const now = await page.evaluate(() => {
          const layer = (window as unknown as Hooks).__halfcube?.layer;
          const a = layer?.toScreen(0, 0);
          const b = layer?.toScreen(10, 10);
          return a && b ? `${a.x.toFixed(2)},${a.y.toFixed(2)},${b.x.toFixed(2)},${b.y.toFixed(2)}` : "";
        });
        still = now !== "" && now === last ? still + 1 : 0;
        last = now;
        return still;
      },
      { message: "the view kept moving after the sketch opened", intervals: [120], timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(3);
}

const readView = (page: Page): Promise<PlainView> =>
  page.evaluate(() => {
    const v = (window as unknown as Hooks).__halfcube?.editor?.getView();
    if (!v) throw new Error("no open sketch");
    return {
      points: v.points.map((p) => ({ id: p.id, x: p.x, y: p.y })),
      lines: v.lines.map((l) => ({ id: l.id, p1: l.p1, p2: l.p2 })),
      circles: v.circles.map((c) => ({ id: c.id, center: c.center, radius: c.radius })),
      constraints: v.constraints.map((c) => ({ id: c.id, kind: c.kind, refs: c.refs })),
      dimensions: v.dimensions.map((d) => ({ id: d.id, kind: d.kind, refs: d.refs, value: d.value, driving: d.driving, ...(d.measured !== undefined ? { measured: d.measured } : {}), ...(d.reverse ? { reverse: d.reverse } : {}) })),
      dof: v.dof,
      status: v.status,
    };
  });

/** The number in a value field (German comma or English point). */
async function liveValue(field: Locator): Promise<number> {
  return Number((await field.inputValue()).replace(",", "."));
}

/** Page coordinates of a sketch point (plus an offset in pixels), asked from the sketch layer. */
async function at(page: Page, u: number, v: number, dx = 0, dy = 0): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(
    ([a, b]) => {
      const layer = (window as unknown as Hooks).__halfcube?.layer;
      const host = document.querySelector("[data-testid='viewport']");
      if (!layer || !host) throw new Error("no sketch layer");
      const s = layer.toScreen(a, b);
      const r = host.getBoundingClientRect();
      return { x: r.left + s.x, y: r.top + s.y };
    },
    [u, v] as const,
  );
  return { x: p.x + dx, y: p.y + dy };
}

async function click(page: Page, p: { x: number; y: number }): Promise<void> {
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
}

/** Draws a rectangle from the origin 240 x 150 pixels to the upper left with the rectangle tool (the palette sits on the right). */
async function drawRectangle(page: Page): Promise<void> {
  await page.getByTestId("tool-rectangle").click();
  const o = await at(page, 0, 0);
  await click(page, o);
  await page.mouse.move(o.x - 120, o.y - 70, { steps: 4 });
  await click(page, { x: o.x - 240, y: o.y - 150 });
  await expect.poll(async () => (await readView(page)).lines.length).toBe(4);
}

async function bounds(page: Page): Promise<{ minU: number; maxU: number; minV: number; maxV: number }> {
  const v = await readView(page);
  const us = v.points.map((p) => p.x);
  const vs = v.points.map((p) => p.y);
  return { minU: Math.min(...us), maxU: Math.max(...us), minV: Math.min(...vs), maxV: Math.max(...vs) };
}

/** Dimension tool: pick the edge at (u, v), place the label (dx, dy) pixels away and type the value. */
async function dimension(page: Page, u: number, v: number, dx: number, dy: number, value: string): Promise<void> {
  await page.keyboard.press("d"); // the dimension tool stays on after a dimension; the key picks it, a second click on the button would end it
  await expect(page.getByTestId("tool-dimension")).toHaveAttribute("aria-pressed", "true");
  await click(page, await at(page, u, v));
  await click(page, await at(page, u, v, dx, dy));
  const input = page.getByTestId("dim-input");
  await expect(input).toBeVisible();
  await input.fill(value);
  await input.press("Enter");
  await expect(page.getByTestId("dim-box")).toHaveCount(0);
}

/** Bottom edge 60 mm, right side 40 mm: with the corner on the origin the rectangle is fully determined. */
async function dimensionBothSides(page: Page): Promise<void> {
  const b = await bounds(page);
  await dimension(page, (b.minU + b.maxU) / 2, b.minV, 0, 36, "60");
  await expect.poll(async () => (await readView(page)).dimensions.length).toBe(1);
  const c = await bounds(page);
  await dimension(page, c.maxU, (c.minV + c.maxV) / 2, 40, 0, "40");
  await expect.poll(async () => (await readView(page)).dimensions.length).toBe(2);
}

const statusOf = (page: Page) => page.getByTestId("sketch-status");

test("draw a rectangle, dimension both sides until the palette says fully defined; the highlight shows as band and as fill", async ({ app }) => {
  const page = await openSketch(app);
  await expect(statusOf(page)).toHaveAttribute("data-status", "none");
  await drawRectangle(page);
  await expect(statusOf(page)).toHaveAttribute("data-status", "under");
  await expect(statusOf(page)).toContainText("2 degrees of freedom");
  await expect(page.getByTestId("tool-rectangle")).toHaveAttribute("aria-pressed", "false");

  await dimensionBothSides(page);
  await expect(statusOf(page)).toHaveAttribute("data-status", "full", { timeout: 15_000 });
  await expect(page.getByTestId("sketch-status-word")).toHaveText("Fully defined");
  const v = await readView(page);
  expect(v.dof).toBe(0);
  expect(v.dimensions.map((d) => d.value.value).sort((x, y) => x - y)).toEqual([40, 60]);
  const b = await bounds(page);
  expect(b.maxU - b.minU).toBeCloseTo(60, 6);
  expect(b.maxV - b.minV).toBeCloseTo(40, 6);
  await expect(page.getByTestId("dim-" + v.dimensions[0]!.id)).toBeVisible();

  // The highlight: a narrow band on the inner side of the contour, or the whole area (settings dialog). Pixels of the real view.
  await page.keyboard.press("Escape"); // leave the dimension tool, nothing hovers the sketch
  // The symbols and value labels are HTML on top of the view; hide them so the pixels are the drawing alone.
  await page.getByRole("checkbox", { name: "Constraints" }).uncheck();
  await page.getByRole("checkbox", { name: "Dimensions" }).uncheck();
  const host = page.getByTestId("viewport-host");
  const shoot = async () => {
    await page.mouse.move(2, 2);
    await page.waitForTimeout(250);
    const img = decodePng(await host.screenshot());
    const box = (await host.boundingBox())!;
    const scale = img.width / box.width; // the screenshot has device pixels, the positions are CSS pixels
    const centre = await at(page, (b.minU + b.maxU) / 2, (b.minV + b.maxV) / 2);
    const left = await at(page, b.minU, (b.minV + b.maxV) / 2, 3.5, 0);
    const outside = await at(page, b.minU, b.minV, -60, 60);
    return {
      centre: meanColour(img, (centre.x - box.x) * scale, (centre.y - box.y) * scale, 2),
      band: meanColour(img, (left.x - box.x) * scale, (left.y - box.y) * scale, 1),
      outside: meanColour(img, (outside.x - box.x) * scale, (outside.y - box.y) * scale, 2),
    };
  };
  const band = await shoot();
  // Band: the middle of the region looks like the background (a grid line may add a few levels), the strip inside the contour does not.
  const bandCentre = colourDistance(band.centre, band.outside);
  expect(bandCentre).toBeLessThan(30);
  expect(colourDistance(band.band, band.centre)).toBeGreaterThan(25);

  await page.getByTestId("settings-button").click();
  await page.getByTestId("settings-tab-sketch").click();
  await page.getByTestId("sketch-fill-fill").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
  await expect.poll(async () => {
    const s = await shoot();
    // The same spot as in band mode (so the grid is the same): now it is tinted by the area fill.
    return colourDistance(s.centre, band.centre);
  }).toBeGreaterThan(12);
  expect(app.errors).toEqual([]);
});

test("a typed value that contradicts the sketch is not applied: the dialog says why; the reference dimension works, Cancel changes nothing", async ({ app }) => {
  const page = await openSketch(app);
  await drawRectangle(page);
  // Only the width is dimensioned (60), the height is free: the diagonal is no fixed quantity yet.
  const b = await bounds(page);
  await dimension(page, (b.minU + b.maxU) / 2, b.minV, 0, 36, "60");
  await expect.poll(async () => (await readView(page)).dimensions.length).toBe(1);
  const c = await bounds(page); // the typed width changed the size of the rectangle
  const diagonalFrom = await at(page, c.minU, c.minV);
  const diagonalTo = await at(page, c.maxU, c.maxV);
  const centre = await at(page, (c.minU + c.maxU) / 2, (c.minV + c.maxV) / 2);

  // The diagonal needs at least the width: 50 mm cannot be, the sketch cannot be solved with it.
  await page.keyboard.press("d");
  await click(page, diagonalFrom);
  await click(page, diagonalTo);
  await click(page, centre);
  const input = page.getByTestId("dim-input");
  await expect(input).toBeVisible();
  await input.fill("50");
  await input.press("Enter");

  const dialog = page.getByTestId("sketch-reject-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Dimension contradicts the sketch");
  await expect(dialog).toContainText("HC-SKETCH-");
  await expect(dialog).toContainText("was not applied, the sketch stays unchanged");
  await expect(dialog).toContainText("The sketch cannot be solved with these dimensions and constraints.");
  await expect(dialog.getByRole("button", { name: "Copy" })).toBeVisible();
  // Nothing in the dialog, the folded technical lines included, shows an internal id (l4, k5, (d3)).
  expect(await dialog.textContent()).not.toMatch(/\b[lkpc]\d+\b|\(d\d+\)|\bd\d{2,}\b/);
  // The diagonal was placed with its measured value first (one step with the typed value), the typed value was not applied.
  const placed = await readView(page);
  expect(placed.dimensions).toHaveLength(2);
  const diagonal = placed.dimensions.find((d) => d.value.value !== 60)!;
  expect(diagonal.value.value).toBeGreaterThan(60);
  expect(diagonal.driving).toBe(true);

  // Cancel: nothing changes.
  await page.getByRole("alertdialog").or(page.getByRole("dialog")).getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect((await readView(page)).dimensions).toEqual(placed.dimensions);

  // Again, this time as a reference dimension: it shows the measured value in brackets and determines nothing.
  await page.getByTestId("dim-" + diagonal.id).dblclick();
  await page.getByTestId("dim-input").fill("50");
  await page.getByTestId("dim-input").press("Enter");
  await expect(dialog).toBeVisible();
  await page.getByRole("button", { name: "Add as reference dimension" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await readView(page)).dimensions.filter((d) => !d.driving).length).toBe(1);
  const after = await readView(page);
  expect(after.dof).toBe(1); // the height is still free: the reference determines nothing
  const reference = after.dimensions.find((d) => !d.driving)!;
  expect(reference.id).toBe(diagonal.id);
  await expect(page.getByTestId("dim-" + reference.id)).toHaveAttribute("data-reference", "true");
  await expect(page.getByTestId("dim-" + reference.id)).toHaveText(/^\(\d+(\.\d+)?\)$/);
  expect(app.errors).toEqual([]);
});

/** The fully defined 60 x 40 rectangle of the owner's cases: the lines by where they lie. */
async function definedRectangle(page: Page) {
  await drawRectangle(page);
  await dimensionBothSides(page);
  await expect(statusOf(page)).toHaveAttribute("data-status", "full", { timeout: 15_000 });
  await page.keyboard.press("Escape"); // leave the dimension tool
  const view = await readView(page);
  const b = await bounds(page);
  const pointOf = (id: string) => view.points.find((q) => q.id === id)!;
  const lineWhere = (test: (a: { x: number; y: number }, c: { x: number; y: number }) => boolean) =>
    view.lines.find((l) => test(pointOf(l.p1), pointOf(l.p2)))!;
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-6;
  return {
    b,
    bottom: lineWhere((a, c) => near(a.y, b.minV) && near(c.y, b.minV)),
    top: lineWhere((a, c) => near(a.y, b.maxV) && near(c.y, b.maxV)),
    left: lineWhere((a, c) => near(a.x, b.minU) && near(c.x, b.minU)),
    right: lineWhere((a, c) => near(a.x, b.maxU) && near(c.x, b.maxU)),
    midU: (b.minU + b.maxU) / 2,
    midV: (b.minV + b.maxV) / 2,
  };
}

/** Picks the dimension tool, clicks the given things in turn and places the label at the last position. */
async function pickAndPlace(page: Page, ...clicks: { x: number; y: number }[]): Promise<void> {
  await page.keyboard.press("d");
  await expect(page.getByTestId("tool-dimension")).toHaveAttribute("aria-pressed", "true");
  for (const c of clicks) await click(page, c);
}

/** A circle of 20 mm with its centre where the pointer clicks (the value is typed, so the circle is exact; big enough to hit its rim). */
async function drawCircleAt(page: Page, u: number, v: number): Promise<void> {
  await page.getByTestId("tool-circle").click();
  await click(page, await at(page, u, v));
  await page.keyboard.press("2");
  await page.keyboard.type("0");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await readView(page)).circles.length).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
}

test("an angle at the corner of a fully defined rectangle is a reference dimension at once, (90°), no box, no dialog, one undo step, and a notice", async ({ app }) => {
  const page = await openSketch(app);
  const r = await definedRectangle(page);
  const before = await readView(page);
  const dimensionsBefore = before.dimensions.length;
  // The corner at the origin: the bottom edge and the right edge meet there (the rectangle was drawn up and to the left of it).
  await pickAndPlace(page, await at(page, r.midU, r.b.minV), await at(page, r.b.maxU, r.midV));
  await expect(page.getByTestId("sketch-prompt")).toHaveAttribute("data-prompt", "dimensionPlace");
  // Inside the corner (up and to the left of the origin): the angle of that sector is 90, never 270.
  await click(page, await at(page, r.b.maxU, r.b.minV, -34, -34));
  await expect(page.getByTestId("dim-box")).toHaveCount(0);
  await expect(page.getByTestId("sketch-reject-dialog")).toHaveCount(0);
  await expect.poll(async () => (await readView(page)).dimensions.length).toBe(dimensionsBefore + 1);
  const added = (await readView(page)).dimensions.at(-1)!;
  expect(added).toMatchObject({ kind: "angle", driving: false });
  expect(added.measured).toBeCloseTo(90, 6);
  expect(added.reverse).toHaveLength(2);
  await expect(page.getByTestId("dim-" + added.id)).toHaveText("(90°)");
  await expect(page.getByTestId("dim-" + added.id)).toHaveAttribute("data-reference", "true");
  await expect(page.getByTestId("sketch-prompt")).toHaveAttribute("data-prompt", "alreadyFixed");
  await expect(page.getByTestId("sketch-prompt")).toContainText("Already fixed: added as a reference dimension.");
  await expect(statusOf(page)).toHaveAttribute("data-status", "full");
  // ONE undo step takes it away again.
  await page.getByTestId("undo").click();
  await expect.poll(async () => (await readView(page)).dimensions.length).toBe(dimensionsBefore);
  // And the opposite sector of the same two lines is 90 as well (outside the rectangle at the corner).
  await pickAndPlace(page, await at(page, r.midU, r.b.minV), await at(page, r.b.maxU, r.midV), await at(page, r.b.maxU, r.b.minV, 34, 34));
  await expect.poll(async () => (await readView(page)).dimensions.length).toBe(dimensionsBefore + 1);
  expect((await readView(page)).dimensions.at(-1)!.measured).toBeCloseTo(90, 6);
  expect(app.errors).toEqual([]);
});

test("while a dimension is placed its own graphics are drawn, and a reference dimension is shown in brackets and muted", async ({ app }) => {
  const page = await openSketch(app);
  const r = await definedRectangle(page);
  await page.getByRole("checkbox", { name: "Constraints" }).uncheck();
  await page.getByRole("checkbox", { name: "Dimensions" }).uncheck();
  const empty = await hideLabelsAndShoot(page);
  // The label is held 6 mm right of the middle of the two parallel edges: the dimension line runs there, from the bottom edge to the top edge.
  const labelAt = await at(page, r.midU + 6, r.midV);
  const samples = await Promise.all([0.35, 0.45, 0.55, 0.65].map((k) => at(page, r.midU + 6, r.b.minV + k * (r.b.maxV - r.b.minV))));
  const base = samples.map((q) => empty(q, 1));
  // Pick the bottom and the top edge (parallel: their distance) and hold the label there: the dimension line appears.
  await pickAndPlace(page, await at(page, r.midU - 10, r.b.minV), await at(page, r.midU - 10, r.b.maxV));
  await page.mouse.move(labelAt.x, labelAt.y, { steps: 4 });
  await page.waitForTimeout(250);
  const placing = await hideLabelsAndShoot(page);
  const strongest = Math.max(...samples.map((q, i) => colourDistance(placing(q, 1), base[i]!)));
  expect(strongest, "the dimension line is drawn while the label is placed").toBeGreaterThan(10);
  await click(page, labelAt);
  await page.keyboard.press("Escape");
  await page.getByRole("checkbox", { name: "Dimensions" }).check();
  const reference = (await readView(page)).dimensions.at(-1)!;
  expect(reference).toMatchObject({ kind: "distance", driving: false });
  const chip = page.getByTestId("dim-" + reference.id);
  await expect(chip).toHaveText("(40)");
  // Muted text colour: the muted token of the theme (6.2:1 on the surface or better in every theme and mode), not the dimension colour.
  const colours = await chip.evaluate((el) => {
    const probeColour = (cls: string) => {
      const x = document.createElement("span");
      x.className = cls;
      document.body.appendChild(x);
      const c = getComputedStyle(x).color;
      x.remove();
      return c;
    };
    return { chip: getComputedStyle(el).color, muted: probeColour("text-muted"), dim: probeColour("text-dim-text") };
  });
  expect(colours.chip).toBe(colours.muted);
  expect(colours.chip).not.toBe(colours.dim);
  expect(app.errors).toEqual([]);
});

test("a circle's centre and a line: measured from the centre, perpendicular to the line", async ({ app }) => {
  const page = await openSketch(app);
  const r = await definedRectangle(page);
  const cu = r.b.minU + 0.35 * (r.b.maxU - r.b.minU), cv = r.midV;
  await drawCircleAt(page, cu, cv);
  const circle = (await readView(page)).circles[0]!;
  const centre = (await readView(page)).points.find((q) => q.id === circle.center)!;
  await pickAndPlace(page, await at(page, centre.x, centre.y), await at(page, r.midU, r.b.minV));
  await click(page, await at(page, r.midU, r.b.minV, 60, -50));
  const input = page.getByTestId("dim-input");
  await expect(input).toBeVisible();
  // The measured value is the distance of the centre from the bottom line.
  expect(await liveValue(input)).toBeCloseTo(centre.y - r.b.minV, 2);
  await input.fill("12");
  await input.press("Enter");
  await expect(page.getByTestId("dim-box")).toHaveCount(0);
  const dim = (await readView(page)).dimensions.at(-1)!;
  expect(dim).toMatchObject({ kind: "distance", driving: true });
  expect(dim.refs).toEqual(expect.arrayContaining([circle.center, r.bottom.id]));
  const moved = (await readView(page)).points.find((q) => q.id === circle.center)!;
  expect(moved.y - r.b.minV).toBeCloseTo(12, 6);
  expect(app.errors).toEqual([]);
});

test("a circle's rim and a line: measured from the rim, the shortest distance", async ({ app }) => {
  const page = await openSketch(app);
  const r = await definedRectangle(page);
  await drawCircleAt(page, r.b.minU + 0.35 * (r.b.maxU - r.b.minU), r.midV);
  const circle = (await readView(page)).circles[0]!;
  const centre = (await readView(page)).points.find((q) => q.id === circle.center)!;
  // The rim on the left of the circle (the symbols of the sketch sit on its right), then the bottom line.
  await pickAndPlace(page, await at(page, centre.x - circle.radius, centre.y), await at(page, r.midU, r.b.minV));
  await click(page, await at(page, r.midU, r.b.minV, 60, -50));
  const input = page.getByTestId("dim-input");
  await expect(input).toBeVisible();
  expect(await liveValue(input)).toBeCloseTo(centre.y - r.b.minV - circle.radius, 2);
  await input.fill("5");
  await input.press("Enter");
  const dim = (await readView(page)).dimensions.at(-1)!;
  expect(dim.refs).toEqual(expect.arrayContaining([circle.id, r.bottom.id]));
  const moved = (await readView(page)).points.find((q) => q.id === circle.center)!;
  expect(moved.y - r.b.minV - circle.radius).toBeCloseTo(5, 6);
  // After a circle a click into empty space still places the diameter; the drawn circle has its diameter already, so it is a reference.
  await pickAndPlace(page, await at(page, moved.x - circle.radius, moved.y));
  await click(page, await at(page, r.b.minU, r.midV, -70, 0)); // empty space left of the rectangle
  await expect(page.getByTestId("dim-box")).toHaveCount(0);
  await expect.poll(async () => (await readView(page)).dimensions.at(-1)!.kind).toBe("diameter");
  const diameter = (await readView(page)).dimensions.at(-1)!;
  expect(diameter).toMatchObject({ kind: "diameter", driving: false });
  expect(diameter.measured).toBeCloseTo(20, 6);
  expect(app.errors).toEqual([]);
});

test("two parallel lines (their distance, not an angle), and a point and a line", async ({ app }) => {
  const page = await openSketch(app);
  const r = await definedRectangle(page);
  // Bottom and top edge are parallel: the distance between them (40) is fixed by the rectangle, so a reference dimension.
  await pickAndPlace(page, await at(page, r.midU, r.b.minV), await at(page, r.midU, r.b.maxV));
  // The label goes to the left of the rectangle, where no symbol or value box of the sketch lies in the way.
  await click(page, await at(page, r.b.minU, r.midV, -70, 0));
  await expect(page.getByTestId("dim-box")).toHaveCount(0);
  await expect.poll(async () => (await readView(page)).dimensions.at(-1)!.driving).toBe(false);
  const parallel = (await readView(page)).dimensions.at(-1)!;
  expect(parallel).toMatchObject({ kind: "distance", driving: false });
  expect(parallel.refs).toEqual([r.bottom.id, r.top.id]);
  expect(parallel.measured).toBeCloseTo(r.b.maxV - r.b.minV, 6);

  // A free line inside the rectangle: its end point is a point of the sketch.
  await page.getByTestId("tool-line").click();
  await click(page, await at(page, r.midU, r.midV, 0, 40));
  await click(page, await at(page, r.midU, r.midV, 60, 40));
  await expect.poll(async () => (await readView(page)).lines.length).toBe(5);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const free = (await readView(page)).lines.at(-1)!;
  const end = (await readView(page)).points.find((q) => q.id === free.p2)!;
  // The right half of the bottom edge: the extension lines of the dimension above lie on its left half.
  await pickAndPlace(page, await at(page, end.x, end.y), await at(page, r.b.maxU - 8, r.b.minV));
  await click(page, await at(page, r.b.maxU, r.midV, 90, 0));
  const input = page.getByTestId("dim-input");
  await expect(input).toBeVisible();
  await input.fill("10");
  await input.press("Enter");
  const dim = (await readView(page)).dimensions.at(-1)!;
  expect(dim).toMatchObject({ kind: "distance", driving: true });
  expect(dim.refs).toEqual(expect.arrayContaining([free.p2, r.bottom.id]));
  // The end point was below the line and stays on that side, 10 mm from it.
  expect(Math.abs(((await readView(page)).points.find((q) => q.id === free.p2)!).y - r.b.minV)).toBeCloseTo(10, 6);
  expect(app.errors).toEqual([]);
});

/** The owner's rectangle: 12 x 55 typed, started away from the origin (so nothing holds its position). */
async function ownersRectangle(page: Page): Promise<{ start: { x: number; y: number } }> {
  await page.getByTestId("tool-rectangle").click();
  const start = await at(page, 0, 0, -60, 40);
  await click(page, start);
  await page.mouse.move(start.x - 40, start.y - 80, { steps: 4 });
  await expect.poll(() => liveValue(page.getByTestId("typed-width"))).toBeGreaterThan(1);
  await page.keyboard.press("1");
  await page.keyboard.type("2");
  await page.keyboard.press("Tab");
  await page.keyboard.type("55");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await readView(page)).lines.length).toBe(4);
  await expect(statusOf(page)).toHaveAttribute("data-status", "under", { timeout: 15_000 });
  // "under" is also the state with only the width applied (3 degrees of freedom); wait for both sizes, so a read of the view is not early.
  await expect.poll(async () => (await readView(page)).dof).toBe(2);
  return { start };
}

/** Opens the list behind the chip of "what is still missing" (it is collapsed in every sketch session). */
async function openMissing(page: Page): Promise<void> {
  const chip = page.getByTestId("missing-chip");
  if ((await chip.getAttribute("aria-expanded")) !== "true") await chip.click();
  await expect(page.getByTestId("sketch-missing")).toBeVisible();
}

test("what is still missing: the owner's 12 x 55 rectangle away from the origin - the list names the free position and offers three ways; Fix on one corner makes it fully defined, with the band", async ({ app }) => {
  const page = await openSketch(app);
  await ownersRectangle(page);
  const view = await readView(page);
  expect(view.dof).toBe(2);
  // Collapsed by default: the chip counts the open items, the list is not there.
  await expect(page.getByTestId("sketch-missing")).toHaveCount(0);
  await expect(page.getByTestId("missing-chip")).toHaveAttribute("data-state", "open");
  await expect(page.getByTestId("missing-chip-count")).toHaveText("1");
  await openMissing(page);
  const missing = page.getByTestId("sketch-missing");
  await expect(page.getByTestId("missing-only-position")).toHaveText("Shape and size are fully determined, only the position is still free.");
  await expect(page.getByTestId("missing-position")).toHaveText(
    "Position free: Rectangle 1 can still be moved. Fix a point with Fix, put it on the origin or dimension the distance to the origin.",
  );
  await expect(missing.getByRole("listitem")).toHaveCount(1);

  // The list sits below the palette and the palette keeps its size.
  const palette = (await page.getByTestId("sketch-palette").boundingBox())!;
  const box = (await missing.boundingBox())!;
  expect(box.y).toBeGreaterThan(palette.y + palette.height);
  expect(box.x).toBeCloseTo(palette.x, 0);
  expect(box.width).toBeCloseTo(palette.width, 0);

  // Hovering the entry lights up the rectangle in the view.
  await page.keyboard.press("Escape");
  await page.getByRole("checkbox", { name: "Constraints" }).uncheck();
  await page.getByRole("checkbox", { name: "Dimensions" }).uncheck();
  const b = await bounds(page);
  const edge = await at(page, (b.minU + b.maxU) / 2, b.minV);
  const before = (await hideLabelsAndShoot(page))(edge, 1);
  await openMissing(page);
  await page.getByTestId("missing-position").hover();
  // The highlight is drawn on the next frames after the hover; poll the pixels instead of a fixed pause (a fixed pause of 300 ms was too short once in 12 runs).
  await expect
    .poll(
      async () => {
        const lit = await page.getByTestId("viewport-host").screenshot();
        const box2 = (await page.getByTestId("viewport-host").boundingBox())!;
        const img = decodePng(lit);
        const scale = img.width / box2.width;
        return colourDistance(meanColour(img, (edge.x - box2.x) * scale, (edge.y - box2.y) * scale, 1), before);
      },
      { message: "the rectangle is highlighted while the entry is hovered", intervals: [100, 200, 300], timeout: 10_000 },
    )
    .toBeGreaterThan(12);
  await page.mouse.move(2, 2);
  await page.getByRole("checkbox", { name: "Constraints" }).check();
  await page.getByRole("checkbox", { name: "Dimensions" }).check();

  // "Fix" on one corner: the position is fixed, nothing is free, the chip shows the check, the band shows.
  await page.getByTestId("tool-fix").click();
  await click(page, await at(page, b.minU, b.minV));
  await expect(statusOf(page)).toHaveAttribute("data-status", "full", { timeout: 15_000 });
  await expect(page.getByTestId("missing-chip")).toHaveAttribute("data-state", "full");
  await expect(page.getByTestId("missing-full")).toBeVisible();
  expect((await readView(page)).dof).toBe(0);
  await page.keyboard.press("Escape");
  await page.getByRole("checkbox", { name: "Constraints" }).uncheck();
  await page.getByRole("checkbox", { name: "Dimensions" }).uncheck();
  await page.getByTestId("missing-chip").click(); // collapse again: the list is not in the pixels
  const shoot = await hideLabelsAndShoot(page);
  const inside = await at(page, b.minU, (b.minV + b.maxV) / 2, 1.5, 0);
  const outside = await at(page, b.minU, b.minV, -40, 40);
  expect(colourDistance(shoot(inside, 1), shoot(outside, 1)), "the green band runs inside the contour").toBeGreaterThan(20);
  expect(app.errors).toEqual([]);
});

test("what is still missing: a corner on the origin by a coincidence also makes the rectangle fully defined (German texts)", async ({ app }) => {
  const page = await openSketch(app, "lang=de");
  await ownersRectangle(page);
  await openMissing(page);
  await expect(page.getByTestId("missing-only-position")).toHaveText("Form und Größe sind vollständig bestimmt, nur die Lage ist noch frei.");
  await expect(page.getByTestId("missing-position")).toHaveText(
    "Lage frei: Rechteck 1 lässt sich noch verschieben. Einen Punkt mit „Fest“ festsetzen, an den Ursprung legen oder den Abstand zum Ursprung bemaßen.",
  );
  const view = await readView(page);
  const corner = view.points.reduce((a, c) => (c.x + c.y < a.x + a.y ? c : a));
  await page.keyboard.press("Escape"); // closes the list
  await page.getByTestId("tool-coincident").click();
  await click(page, await at(page, corner.x, corner.y));
  await click(page, await at(page, 0, 0));
  await expect(statusOf(page)).toHaveAttribute("data-status", "full", { timeout: 15_000 });
  await expect(page.getByTestId("missing-chip")).toHaveAttribute("data-state", "full");
  expect((await readView(page)).dof).toBe(0);
  expect(app.errors).toEqual([]);
});

test("what is still missing: a free rectangle lists its position, width and height; the palette never moves", async ({ app }) => {
  const page = await openSketch(app);
  const palette = page.getByTestId("sketch-palette");
  const empty = (await palette.boundingBox())!;
  await expect(page.getByTestId("missing-chip")).toHaveCount(0); // nothing drawn: no chip
  await page.getByTestId("tool-rectangle").click();
  const from = await at(page, 0, 0, -60, 40);
  await click(page, from);
  await page.mouse.move(from.x - 100, from.y - 60, { steps: 4 });
  await click(page, { x: from.x - 200, y: from.y - 120 });
  await expect.poll(async () => (await readView(page)).lines.length).toBe(4);
  await expect(page.getByTestId("missing-chip-count")).toHaveText("3");
  await expect(page.getByTestId("sketch-missing")).toHaveCount(0);
  await openMissing(page);
  await expect(page.getByTestId("missing-only-position")).toHaveCount(0);
  await expect(page.getByTestId("missing-position")).toContainText("Rectangle 1 can still be moved.");
  await expect(page.getByTestId("missing-length")).toHaveCount(2);
  await expect(page.getByTestId("missing-length").nth(0)).toContainText("Width free: The width of Rectangle 1");
  await expect(page.getByTestId("missing-length").nth(1)).toContainText("Height free: The height of Rectangle 1");
  expect(await palette.boundingBox()).toEqual(empty);
  await page.getByTestId("missing-length").nth(0).click();
  await expect(page.getByTestId("missing-length").nth(0)).toHaveAttribute("data-elements", /l\d+ l\d+/);
  expect(app.errors).toEqual([]);
});

test("what is still missing: collapsed by default, expands by click, Enter and Space and collapses by click and Esc; nothing moves; the triangle is for problems only", async ({ app }) => {
  const page = await openSketch(app);
  await ownersRectangle(page);
  const chip = page.getByTestId("missing-chip");
  const finish = page.getByTestId("finish-sketch-palette");
  const palette = page.getByTestId("sketch-palette");
  await expect(chip).toHaveAttribute("aria-expanded", "false");
  await expect(chip).toHaveAttribute("data-state", "open"); // free position is no error: no triangle
  const before = { palette: await palette.boundingBox(), finish: await finish.boundingBox(), chip: await chip.boundingBox() };
  await chip.click();
  await expect(chip).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("sketch-missing")).toBeVisible();
  expect({ palette: await palette.boundingBox(), finish: await finish.boundingBox(), chip: await chip.boundingBox() }).toEqual(before);
  await chip.click();
  await expect(page.getByTestId("sketch-missing")).toHaveCount(0);
  // The keyboard: focus the chip, Enter opens, Space closes, Esc closes.
  await chip.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sketch-missing")).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("sketch-missing")).toHaveCount(0);
  await page.keyboard.press("Space");
  await expect(page.getByTestId("sketch-missing")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sketch-missing")).toHaveCount(0);
  await expect(chip).toHaveAttribute("aria-expanded", "false");
  expect({ palette: await palette.boundingBox(), finish: await finish.boundingBox() }).toEqual({ palette: before.palette, finish: before.finish });
  // It never opens by itself: a new edit leaves it collapsed.
  await page.getByTestId("tool-circle").click();
  await click(page, await at(page, 0, 0, -200, 100));
  await page.keyboard.press("6");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await readView(page)).circles.length).toBe(1);
  await expect(page.getByTestId("sketch-missing")).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

test("what is still missing: the chip shows a warning triangle for a conflict in the sketch, and only then", async ({ app }) => {
  // A document whose sketch has contradicting dimensions (a stored session document; the editor never commits one itself).
  const conflicting = sampleDocument(rectangle(3));
  const feature = conflicting.timeline[0] as { sketch: { constraints: unknown[] } };
  feature.sketch.constraints.push({ id: "d9", kind: "distance", refs: ["l1"], value: { value: 70, unit: "mm" }, driving: true, label: { x: 0, y: 0 } });
  const { page } = app;
  // Wait until the first load is complete: a navigation while the engine process is still starting could abort the start and report a page error.
  await openMain(app, "lang=en");
  await page.evaluate(([key, text]) => sessionStorage.setItem(key!, text!), ["halfcube.session.document.2", serializeDocument(conflicting as never)]);
  await page.goto(app.url("/index.html?screen=main&lang=en&sketch=f1"));
  await expect(page.getByTestId("sketch-palette")).toBeVisible({ timeout: 60_000 });
  await expect(statusOf(page)).toHaveAttribute("data-status", "over", { timeout: 30_000 });
  const chip = page.getByTestId("missing-chip");
  await expect(chip).toHaveAttribute("data-state", "problem");
  await expect(chip).toHaveAccessibleName("What is still missing: Problem in the sketch");
  await expect(page.getByTestId("sketch-missing")).toHaveCount(0);
  await chip.click();
  await expect(page.getByTestId("missing-problem")).toBeVisible();
  expect(app.errors).toEqual([]);
});

test("what is still missing: shapes carry names - two rectangles and two circles are told apart - and a click brings the shape to the middle of the view", async ({ app }) => {
  const page = await openSketch(app);
  // Sizes are typed, so each shape only has its position left to give (one entry each).
  const draw = async (tool: string, from: { x: number; y: number }) => {
    await page.getByTestId(tool).click();
    await click(page, from);
    if (tool === "tool-rectangle") {
      await page.mouse.move(from.x - 40, from.y - 40, { steps: 3 });
      await page.keyboard.press("1");
      await page.keyboard.type("0");
      await page.keyboard.press("Tab");
      await page.keyboard.type("10");
    } else {
      await page.keyboard.press("6");
    }
    await page.keyboard.press("Enter");
  };
  const o = await at(page, 0, 0);
  await draw("tool-rectangle", { x: o.x - 330, y: o.y - 200 });
  await expect.poll(async () => (await readView(page)).lines.length).toBe(4);
  await draw("tool-rectangle", { x: o.x - 230, y: o.y - 200 });
  await expect.poll(async () => (await readView(page)).lines.length).toBe(8);
  await draw("tool-circle", { x: o.x - 130, y: o.y - 180 });
  await expect.poll(async () => (await readView(page)).circles.length).toBe(1);
  await draw("tool-circle", { x: o.x - 90, y: o.y - 90 });
  await expect.poll(async () => ({ lines: (await readView(page)).lines.length, circles: (await readView(page)).circles.length })).toEqual({ lines: 8, circles: 2 });
  await openMissing(page);
  const texts = await page.getByTestId("missing-position").allInnerTexts();
  expect(texts.map((t) => t.split(" can still")[0]!.replace("Position free: ", ""))).toEqual(["Rectangle 1", "Rectangle 2", "Circle 1", "Circle 2"]);
  // Click the second rectangle's entry: it ends up in the middle of the view, the sketch is not turned.
  const second = page.getByTestId("missing-position").nth(1);
  const wanted = await second.getAttribute("data-elements");
  expect(wanted).toMatch(/l\d+/);
  await second.click();
  const view = await readView(page);
  const ids = wanted!.split(" ");
  const points = view.lines.filter((l) => ids.includes(l.id)).flatMap((l) => [l.p1, l.p2]).map((id) => view.points.find((q) => q.id === id)!);
  const centre = { u: (Math.min(...points.map((q) => q.x)) + Math.max(...points.map((q) => q.x))) / 2, v: (Math.min(...points.map((q) => q.y)) + Math.max(...points.map((q) => q.y))) / 2 };
  const host = (await page.getByTestId("viewport-host").boundingBox())!;
  await expect
    .poll(async () => {
      const p = await at(page, centre.u, centre.v);
      return Math.hypot(p.x - (host.x + host.width / 2), p.y - (host.y + host.height / 2));
    }, { message: "the second rectangle comes to the middle of the view", timeout: 10_000 })
    .toBeLessThan(8);
  expect(app.errors).toEqual([]);
});

test("screenshots of the palette's chip and list, for the report", async ({ app }, testInfo) => {
  test.skip(process.env.HALFCUBE_PALETTE_SHOTS === undefined, "only when HALFCUBE_PALETTE_SHOTS names a folder");
  const dir = process.env.HALFCUBE_PALETTE_SHOTS!;
  for (const mode of ["light", "dark"] as const) {
    const page = await openSketch(app, `lang=de&theme=praezision&mode=${mode}`);
    await settled(page);
    // Element screenshots (page.screenshot with a clip hangs in the Electron window); the palette alone, and the list on its own when it is open.
    const clip = async (name: string) => {
      await page.mouse.move(2, 2);
      const path = `${dir}/palette-${name}-praezision-${mode}.png`;
      await page.getByTestId("sketch-palette").screenshot({ path, animations: "disabled" });
      testInfo.attachments.push({ name: path, path, contentType: "image/png" });
      if (await page.getByTestId("sketch-missing").count()) {
        const listPath = `${dir}/palette-${name}-liste-praezision-${mode}.png`;
        await page.getByTestId("sketch-missing").screenshot({ path: listPath, animations: "disabled" });
        testInfo.attachments.push({ name: listPath, path: listPath, contentType: "image/png" });
      }
    };
    // Open: something is free.
    await ownersRectangle(page);
    await clip("chip-offen");
    await openMissing(page);
    await clip("liste-offen");
    await page.keyboard.press("Escape");
    // Full: Fix on one corner.
    const b = await bounds(page);
    await page.getByTestId("tool-fix").click();
    await click(page, await at(page, b.minU, b.minV));
    await expect(statusOf(page)).toHaveAttribute("data-status", "full", { timeout: 15_000 });
    await page.keyboard.press("Escape");
    await clip("chip-bestimmt");
    // Problem: a stored document with a conflict.
    const conflicting = sampleDocument(rectangle(3));
    (conflicting.timeline[0] as { sketch: { constraints: unknown[] } }).sketch.constraints.push({ id: "d9", kind: "distance", refs: ["l1"], value: { value: 70, unit: "mm" }, driving: true, label: { x: 0, y: 0 } });
    await page.evaluate(([key, text]) => sessionStorage.setItem(key!, text!), ["halfcube.session.document.2", serializeDocument(conflicting as never)]);
    await page.goto(app.url(`/index.html?screen=main&lang=de&theme=praezision&mode=${mode}&sketch=f1`));
    await expect(statusOf(page)).toHaveAttribute("data-status", "over", { timeout: 30_000 });
    await settled(page);
    await clip("chip-problem");
  }
});

test("dragging a point moves the sketch as one undo step; Esc during the drag puts it back", async ({ app }) => {
  const page = await openSketch(app);
  await drawRectangle(page);
  const b0 = await bounds(page);
  const corner = await at(page, b0.minU, b0.maxV); // the free corner; the one at the origin is held there

  // Esc while dragging: the sketch is as it was.
  await page.mouse.move(corner.x, corner.y, { steps: 2 });
  await page.mouse.down();
  await page.mouse.move(corner.x - 80, corner.y - 40, { steps: 6 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  const b1 = await bounds(page);
  expect(b1.minU).toBeCloseTo(b0.minU, 6);
  await expect(page.getByTestId("undo")).toBeEnabled(); // the rectangle itself is one step

  // Drag and let go: the corner moved, the rectangle follows (its sides stay horizontal and vertical).
  await page.mouse.move(corner.x, corner.y, { steps: 2 });
  await page.mouse.down();
  await page.mouse.move(corner.x - 60, corner.y - 30, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await bounds(page)).minU).toBeLessThan(b0.minU - 1);
  const b2 = await bounds(page);
  expect(b2.maxV).toBeGreaterThan(b0.maxV + 1);
  // Undo takes the drag back in one step.
  await page.getByTestId("undo").click();
  await expect.poll(async () => (await bounds(page)).minU).toBeCloseTo(b0.minU, 6);
  expect(app.errors).toEqual([]);
});

test("Esc and Enter while typing a length; Tab changes the field; a wrong value says why before anything is sent", async ({ app }) => {
  const page = await openSketch(app);
  await page.getByTestId("tool-line").click();
  const o = await at(page, 0, 0);
  await click(page, { x: o.x + 20, y: o.y - 20 });
  await page.mouse.move(o.x + 300, o.y - 20, { steps: 4 });

  // The fields are there before anything was typed, and they show the live length (not focused, not typed into).
  await expect(page.getByTestId("typed-fields")).toBeVisible();
  await expect(page.getByTestId("typed-length")).not.toBeFocused();
  await expect(page.getByTestId("typed-fields")).not.toHaveAttribute("data-typing", /.*/);
  const live = await liveValue(page.getByTestId("typed-length"));
  expect(live).toBeGreaterThan(5);

  await page.keyboard.press("3");
  await expect(page.getByTestId("typed-fields")).toHaveAttribute("data-typing", "true");
  await expect(page.getByTestId("typed-length")).toBeFocused();
  await expect(page.getByTestId("typed-length")).toHaveValue("3");
  await page.keyboard.type("0");
  await expect(page.getByTestId("typed-length")).toHaveValue("30");

  // Esc discards the typing only: the line is not drawn, the start point stays, and the fields stay with their live values.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("typed-fields")).not.toHaveAttribute("data-typing", /.*/);
  await expect(page.getByTestId("typed-length")).not.toBeFocused();
  await expect.poll(() => liveValue(page.getByTestId("typed-length"))).toBeCloseTo(live, 1);
  expect((await readView(page)).lines).toHaveLength(0);
  await expect(page.getByTestId("sketch-prompt")).toHaveAttribute("data-prompt", "lineEnd");

  // A wrong value is flagged on every keystroke and not sent.
  await page.keyboard.press("4");
  await page.keyboard.type("5x");
  await expect(page.getByTestId("typed-length")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toContainText("x");
  await page.keyboard.press("Enter");
  expect((await readView(page)).lines).toHaveLength(0);
  await page.getByTestId("typed-length").fill("45");
  await expect(page.getByTestId("typed-length")).not.toHaveAttribute("aria-invalid", "true");

  // Tab: the angle field; 90 degrees makes the line vertical. Enter commits the line.
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("typed-angle")).toBeFocused();
  await page.keyboard.type("90");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await readView(page)).lines.length).toBe(1);
  const v = await readView(page);
  const [a, b] = [v.points.find((p) => p.id === v.lines[0]!.p1)!, v.points.find((p) => p.id === v.lines[0]!.p2)!];
  expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(45, 6);
  expect(Math.abs(b.x - a.x)).toBeLessThan(1e-6);
  expect(v.constraints.map((c) => c.kind)).toContain("vertical");
  expect(v.dimensions.map((d) => d.value.value)).toContain(45);
  // The chain goes on: the next segment starts at the end of this one, and its fields are live again (nothing typed).
  await expect(page.getByTestId("typed-fields")).not.toHaveAttribute("data-typing", /.*/);
  await expect(page.getByTestId("typed-length")).toBeVisible();
  await page.keyboard.press("Escape"); // ends the chain: no shape in progress, no fields
  await expect(page.getByTestId("typed-fields")).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

/** The box of a value field as drawn (the label around the input: line, unit and all). */
const fieldBox = async (page: Page, testId: string) => (await page.getByTestId(testId).locator("..").boundingBox())!;

const NUMBER_TEXT = /^-?\d+([.,]\d{1,2})?$/;

test("value fields are there from the first click on and follow the pointer: circle, line, rectangle (English)", async ({ app }) => {
  const page = await openSketch(app);
  const host = (await page.getByTestId("sketch-overlay").boundingBox())!;
  const inside = async (id: string) => {
    const b = await fieldBox(page, id);
    expect(b.x, `${id} inside the view (left)`).toBeGreaterThanOrEqual(host.x);
    expect(b.y, `${id} inside the view (top)`).toBeGreaterThanOrEqual(host.y);
    expect(b.x + b.width, `${id} inside the view (right)`).toBeLessThanOrEqual(host.x + host.width);
    expect(b.y + b.height, `${id} inside the view (bottom)`).toBeLessThanOrEqual(host.y + host.height);
  };
  const ppm = await page.evaluate(() => (window as unknown as Hooks).__halfcube!.layer!.pxPerMm());

  // Circle: no field before the centre, the diameter right after it.
  await page.getByTestId("tool-circle").click();
  await expect(page.getByTestId("typed-fields")).toHaveCount(0);
  const o = await at(page, 0, 0);
  await click(page, o);
  const diameter = page.getByTestId("typed-diameter");
  await expect(diameter).toBeVisible();
  await expect(diameter).toHaveAccessibleName("Diameter");
  await expect(diameter).toHaveValue("0");
  await expect(diameter).toHaveJSProperty("readOnly", true);
  await expect(diameter).not.toBeFocused();
  await page.mouse.move(o.x + 100, o.y, { steps: 3 });
  await expect.poll(() => liveValue(diameter)).toBeCloseTo(200 / ppm, 1);
  await page.mouse.move(o.x + 150, o.y + 37, { steps: 5 });
  // A diagonal, so the value is not a round number: at most two decimals, never a long tail.
  await expect.poll(async () => diameter.inputValue()).toMatch(NUMBER_TEXT);
  await expect.poll(() => liveValue(diameter)).toBeCloseTo((2 * Math.hypot(150, 37)) / ppm, 1);
  await inside("typed-diameter");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("typed-fields")).toHaveCount(0);

  // Line: length and angle, the angle straight up is 90.
  await page.keyboard.press("l");
  const start = await at(page, 0, 0, 40, 100);
  await click(page, start);
  await page.mouse.move(start.x, start.y - 120, { steps: 4 });
  await expect.poll(() => liveValue(page.getByTestId("typed-length"))).toBeCloseTo(120 / ppm, 1);
  await expect.poll(() => liveValue(page.getByTestId("typed-angle"))).toBeCloseTo(90, 1);
  await expect(page.getByTestId("typed-angle")).toHaveAccessibleName("Angle");
  // The length sits on its dimension line, 34 px to the right of the middle of the (vertical) rubber band; the angle sits beyond
  // its arc (84 px radius for this 120 px line: 70 %, 62 px further) on the bisector of the angle, 45 degrees up and to the right.
  const length = await fieldBox(page, "typed-length");
  const angle = await fieldBox(page, "typed-angle");
  expect(Math.abs(length.y + length.height / 2 - (start.y - 60)), "length field at the middle of the line").toBeLessThan(3);
  expect(Math.abs(length.x + length.width / 2 - (start.x + 34)), "length field on its dimension line, 34 px beside the line").toBeLessThan(3);
  const bisector = (84 + 62) * Math.SQRT1_2;
  expect(Math.abs(angle.x + angle.width / 2 - (start.x + bisector)), "angle field beyond its arc (x)").toBeLessThan(3);
  expect(Math.abs(angle.y + angle.height / 2 - (start.y - bisector)), "angle field beyond its arc (y)").toBeLessThan(3);
  expect(length.x + length.width <= angle.x || angle.x + angle.width <= length.x || length.y + length.height <= angle.y || angle.y + angle.height <= length.y, "the two fields do not overlap").toBe(true);
  await inside("typed-length");
  await inside("typed-angle");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Rectangle: the width at the horizontal edge, the height at the vertical edge.
  await page.keyboard.press("r");
  // To the upper left, away from the palette on the right.
  const corner = await at(page, 0, 0, 0, 0);
  await click(page, corner);
  await page.mouse.move(corner.x - 200, corner.y - 100, { steps: 4 });
  await expect.poll(() => liveValue(page.getByTestId("typed-width"))).toBeCloseTo(200 / ppm, 1);
  await expect.poll(() => liveValue(page.getByTestId("typed-height"))).toBeCloseTo(100 / ppm, 1);
  const width = await fieldBox(page, "typed-width");
  const height = await fieldBox(page, "typed-height");
  expect(Math.abs(width.x + width.width / 2 - (corner.x - 100)), "width field at the middle of the horizontal edge").toBeLessThan(2);
  expect(Math.abs(height.y + height.height / 2 - (corner.y - 50)), "height field at the middle of the vertical edge").toBeLessThan(2);
  // On the dimension lines outside the rectangle: the width 32 px below the edge through the start, the height 72 px left of the far edge.
  expect(Math.abs(width.y + width.height / 2 - (corner.y + 32)), "width field 32 px below its edge").toBeLessThan(2);
  expect(Math.abs(height.x + height.width / 2 - (corner.x - 200 - 72)), "height field 72 px left of its edge").toBeLessThan(2);
  expect(height.x + height.width).toBeLessThan(corner.x - 200);
  await inside("typed-width");
  await inside("typed-height");
  expect((await readView(page)).lines).toHaveLength(0);
  expect(app.errors).toEqual([]);
});

test("value fields show the decimal comma in German and two decimals at most", async ({ app }) => {
  const page = await openSketch(app, "lang=de");
  await page.getByTestId("tool-circle").click();
  const o = await at(page, 0, 0);
  await click(page, o);
  await page.mouse.move(o.x + 133, o.y + 41, { steps: 4 });
  const diameter = page.getByTestId("typed-diameter");
  await expect(diameter).toHaveAccessibleName("Durchmesser");
  await expect.poll(async () => diameter.inputValue()).toMatch(/^\d+(,\d{1,2})?$/);
  expect(await diameter.inputValue()).not.toContain(".");
  expect(app.errors).toEqual([]);
});

test("typing locks one value, the other keeps following the pointer; Tab selects the next field; Enter commits one undo step", async ({ app }) => {
  const page = await openSketch(app);
  const ppm = await page.evaluate(() => (window as unknown as Hooks).__halfcube!.layer!.pxPerMm());
  await page.getByTestId("tool-rectangle").click();
  const o = await at(page, 0, 0);
  await click(page, o);
  await page.mouse.move(o.x - 120, o.y - 70, { steps: 4 });
  const width = page.getByTestId("typed-width");
  const height = page.getByTestId("typed-height");
  await expect.poll(() => liveValue(width)).toBeCloseTo(120 / ppm, 1);

  // The first digit overwrites the width: the field is locked at what was typed, the height still follows.
  await page.keyboard.press("6");
  await page.keyboard.type("0");
  await expect(width).toBeFocused();
  await expect(width).toHaveValue("60");
  await page.mouse.move(o.x - 150, o.y - 100, { steps: 4 });
  await expect(width).toHaveValue("60");
  await expect.poll(() => liveValue(height)).toBeCloseTo(100 / ppm, 1);
  await page.mouse.move(o.x - 150, o.y - 160, { steps: 4 });
  await expect.poll(() => liveValue(height)).toBeCloseTo(160 / ppm, 1);
  expect((await readView(page)).lines, "nothing is drawn before Enter").toHaveLength(0);

  // Tab: the height takes the keyboard with its live value selected, so the next digits replace it.
  await page.keyboard.press("Tab");
  await expect(height).toBeFocused();
  expect(await height.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd, el.value.length])).toEqual([0, (await height.inputValue()).length, (await height.inputValue()).length]);
  await page.keyboard.type("45");
  await expect(height).toHaveValue("45");
  await page.mouse.move(o.x - 150, o.y - 20, { steps: 4 });
  await expect(height).toHaveValue("45");
  await expect(width).toHaveValue("60");

  await page.keyboard.press("Enter");
  await expect.poll(async () => (await readView(page)).lines.length).toBe(4);
  await expect.poll(async () => (await readView(page)).dimensions.map((d) => d.value.value).sort((a, b) => a - b)).toEqual([45, 60]);
  await expect(page.getByTestId("typed-fields")).toHaveCount(0);
  await page.keyboard.press("Control+Z");
  await expect.poll(async () => (await readView(page)).lines.length).toBe(0);
  expect(app.errors).toEqual([]);
});

for (const dir of [
  { name: "upper left", dx: -1, dy: -1 },
  { name: "lower right", dx: 1, dy: 1 },
  { name: "lower left", dx: -1, dy: 1 },
]) {
  test(`rectangle from the origin with typed width and height (pointer to the ${dir.name}): Enter makes it fully defined, with the highlight`, async ({ app }) => {
    const page = await openSketch(app);
    await page.getByTestId("tool-rectangle").click();
    const o = await at(page, 0, 0);
    await click(page, o);
    await page.mouse.move(o.x + dir.dx * 130, o.y + dir.dy * 80, { steps: 5 });
    // The live values are shown; the first digit replaces the width, Tab goes to the height, its digits replace the live value.
    await expect.poll(() => liveValue(page.getByTestId("typed-width"))).toBeGreaterThan(5);
    await page.keyboard.press("4");
    await page.keyboard.type("0");
    await expect(page.getByTestId("typed-width")).toHaveValue("40");
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("typed-height")).toBeFocused();
    await page.keyboard.type("30");
    await expect(page.getByTestId("typed-height")).toHaveValue("30");
    await expect(page.getByTestId("typed-width")).toHaveValue("40");
    await page.keyboard.press("Enter");

    await expect.poll(async () => (await readView(page)).lines.length).toBe(4);
    await expect(statusOf(page)).toHaveAttribute("data-status", "full", { timeout: 15_000 });
    const v = await readView(page);
    expect(v.dof).toBe(0);
    expect(v.dimensions.map((d) => d.value.value).sort((x, y) => x - y)).toEqual([30, 40]);
    const b = await bounds(page);
    expect(b.maxU - b.minU).toBeCloseTo(40, 6);
    expect(b.maxV - b.minV).toBeCloseTo(30, 6);
    expect(Math.min(Math.abs(b.minU), Math.abs(b.maxU)), "one corner stays on the origin").toBeCloseTo(0, 6);
    expect(Math.min(Math.abs(b.minV), Math.abs(b.maxV)), "one corner stays on the origin").toBeCloseTo(0, 6);

    // The highlight of the fully defined loop: the strip inside the contour differs from the middle of the area.
    await page.getByRole("checkbox", { name: "Constraints" }).uncheck();
    await page.getByRole("checkbox", { name: "Dimensions" }).uncheck();
    const host = page.getByTestId("viewport-host");
    await page.mouse.move(2, 2);
    await page.waitForTimeout(250);
    const img = decodePng(await host.screenshot());
    const box = (await host.boundingBox())!;
    const scale = img.width / box.width;
    const centre = await at(page, (b.minU + b.maxU) / 2, (b.minV + b.maxV) / 2);
    const side = await at(page, b.minU, (b.minV + b.maxV) / 2, 3.5, 0);
    const outside = await at(page, b.minU, b.minV, -60, 60);
    const colour = (p: { x: number; y: number }, r: number) => meanColour(img, (p.x - box.x) * scale, (p.y - box.y) * scale, r);
    expect(colourDistance(colour(centre, 2), colour(outside, 2)), "the middle of the area looks like the background").toBeLessThan(30);
    expect(colourDistance(colour(side, 1), colour(centre, 2)), "the strip inside the contour is highlighted").toBeGreaterThan(25);

    // One undo takes the rectangle and both dimensions.
    await page.getByTestId("undo").click();
    await expect.poll(async () => (await readView(page)).lines.length).toBe(0);
    expect(app.errors).toEqual([]);
  });
}

/** Pixels of the sketch view (the HTML symbols and value labels hidden first, so only the drawing is left). */
async function hideLabelsAndShoot(page: Page) {
  const host = page.getByTestId("viewport-host");
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  const img = decodePng(await host.screenshot());
  const box = (await host.boundingBox())!;
  const scale = img.width / box.width; // the screenshot has device pixels, the positions are CSS pixels
  return (p: { x: number; y: number }, r = 2) => meanColour(img, (p.x - box.x) * scale, (p.y - box.y) * scale, r);
}

test("per loop: a fully dimensioned rectangle with two free circles inside is highlighted on its own, the circles stay empty (band and fill)", async ({ app }) => {
  const page = await openSketch(app);
  // The rectangle from the origin with the typed sizes 40 and 30, pointer to the lower right (away from the palette).
  await page.getByTestId("tool-rectangle").click();
  const o = await at(page, 0, 0);
  await click(page, o);
  await page.mouse.move(o.x + 130, o.y + 80, { steps: 5 });
  await expect.poll(() => liveValue(page.getByTestId("typed-width"))).toBeGreaterThan(5);
  await page.keyboard.press("4");
  await page.keyboard.type("0");
  await page.keyboard.press("Tab");
  await page.keyboard.type("30");
  await page.keyboard.press("Enter");
  await expect(statusOf(page)).toHaveAttribute("data-status", "full", { timeout: 15_000 });
  const b = await bounds(page);
  expect(b.maxU - b.minU).toBeCloseTo(40, 6);
  expect(b.maxV - b.minV).toBeCloseTo(30, 6);

  // Two circles of 8 mm inside; their centres are free.
  const midV = (b.minV + b.maxV) / 2;
  for (const u of [b.minU + 12, b.minU + 28]) {
    await page.getByTestId("tool-circle").click();
    await click(page, await at(page, u, midV));
    await page.keyboard.press("8");
    await page.keyboard.press("Enter");
  }
  await expect.poll(async () => (await readView(page)).circles.length).toBe(2);
  // The circles are free, so the sketch is not fully defined; the rectangle's own highlight is not affected.
  await expect(statusOf(page)).toHaveAttribute("data-status", "under", { timeout: 15_000 });
  await page.keyboard.press("Escape");
  await page.getByRole("checkbox", { name: "Constraints" }).uncheck();
  await page.getByRole("checkbox", { name: "Dimensions" }).uncheck();

  const view = await readView(page);
  const circle = view.circles[0]!;
  const centre = view.points.find((p) => p.id === circle.center)!;
  // Band mode (the default): a strip inside the contour of the rectangle; nothing around the free circles, in the middle nothing.
  const colourBand = await hideLabelsAndShoot(page);
  const outside = colourBand(await at(page, b.minU, b.minV, -60, 60));
  const strip = colourBand(await at(page, b.minU, midV, 3.5, 0), 1);
  const middle = colourBand(await at(page, (b.minU + b.maxU) / 2, b.maxV - 6));
  const ring = colourBand(await at(page, centre.x + circle.radius, centre.y, 4.5, 0), 1);
  expect(colourDistance(middle, outside), "the middle of the area looks like the background").toBeLessThan(30);
  expect(colourDistance(strip, middle), "the determined rectangle has its band").toBeGreaterThan(25);
  expect(colourDistance(ring, middle), "a free circle has no band around it").toBeLessThan(25);

  // Fill mode: the rectangle's area is tinted, the free circles are cut out.
  await page.getByTestId("settings-button").click();
  await page.getByTestId("settings-tab-sketch").click();
  await page.getByTestId("sketch-fill-fill").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
  await expect
    .poll(async () => colourDistance((await hideLabelsAndShoot(page))(await at(page, (b.minU + b.maxU) / 2, b.maxV - 6)), outside))
    .toBeGreaterThan(12);
  const colourFill = await hideLabelsAndShoot(page);
  const filled = colourFill(await at(page, (b.minU + b.maxU) / 2, b.maxV - 6));
  const inCircle = colourFill(await at(page, centre.x, centre.y + 1.5));
  expect(colourDistance(filled, outside), "the area of the determined rectangle is filled").toBeGreaterThan(12);
  expect(colourDistance(inCircle, outside), "the free circle stays empty (it is cut out of the fill)").toBeLessThan(colourDistance(filled, outside) / 2);
  expect(app.errors).toEqual([]);
});

test("Ctrl+Z and Ctrl+Y work after a palette checkbox was clicked; a text field and a dialog keep their keys", async ({ app }) => {
  const page = await openSketch(app);
  await drawRectangle(page);
  // Ticking a checkbox leaves the focus on it; the undo and redo keys must still reach the sketch.
  const dimensions = page.getByRole("checkbox", { name: "Dimensions" });
  await dimensions.click();
  await expect(dimensions).toBeFocused();
  await page.keyboard.press("Control+Z");
  await expect.poll(async () => (await readView(page)).lines.length).toBe(0);
  await page.keyboard.press("Control+Y");
  await expect.poll(async () => (await readView(page)).lines.length).toBe(4);
  const constraints = page.getByRole("checkbox", { name: "Constraints" });
  await constraints.click();
  await expect(constraints).toBeFocused();
  await page.keyboard.press("Control+Z");
  await expect.poll(async () => (await readView(page)).lines.length).toBe(0);
  await page.keyboard.press("Control+Shift+Z");
  await expect.poll(async () => (await readView(page)).lines.length).toBe(4);

  // In a value field the key belongs to the field: the sketch stays as it is.
  const b = await bounds(page);
  await page.keyboard.press("d");
  await click(page, await at(page, (b.minU + b.maxU) / 2, b.minV));
  await click(page, await at(page, (b.minU + b.maxU) / 2, b.minV, 0, 36));
  const input = page.getByTestId("dim-input");
  await expect(input).toBeFocused();
  await input.fill("55");
  await page.keyboard.press("Control+Z");
  await expect(page.getByTestId("dim-box")).toBeVisible();
  expect((await readView(page)).dimensions).toHaveLength(1);
  expect((await readView(page)).lines).toHaveLength(4);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("dim-box")).toHaveCount(0);

  // In a dialog too: with the settings dialog open and a control focused, Ctrl+Z leaves the sketch alone.
  await page.getByTestId("settings-button").click();
  await page.getByTestId("settings-tab-sketch").click();
  await page.getByTestId("sketch-fill-fill").focus();
  await page.keyboard.press("Control+Z");
  await page.waitForTimeout(300);
  expect((await readView(page)).lines).toHaveLength(4);
  expect((await readView(page)).dimensions).toHaveLength(1);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

test("a dimension label travels with its geometry: dragging the rectangle takes the value labels along", async ({ app }) => {
  const page = await openSketch(app);
  // Away from the origin, so nothing holds the rectangle in place and dragging a corner moves all of it.
  await page.getByTestId("tool-rectangle").click();
  const start = await at(page, 0, 0, -40, 30);
  await click(page, start);
  await page.mouse.move(start.x - 120, start.y - 70, { steps: 4 });
  await click(page, { x: start.x - 240, y: start.y - 150 });
  await expect.poll(async () => (await readView(page)).lines.length).toBe(4);
  await dimensionBothSides(page);
  await expect(statusOf(page)).toHaveAttribute("data-status", "under");
  await page.keyboard.press("Escape"); // leave the dimension tool: the pointer drags again
  const label = (id: string) => page.getByTestId("dim-" + id);
  const centreOf = async (id: string) => {
    const box = (await label(id).boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const v0 = await readView(page);
  const ids = v0.dimensions.map((d) => d.id);
  const before = await Promise.all(ids.map(centreOf));
  const b0 = await bounds(page);
  const corner = await at(page, b0.minU, b0.maxV);
  // Both sizes are dimensioned, so the whole rectangle follows the free corner.
  await page.mouse.move(corner.x, corner.y, { steps: 2 });
  await page.mouse.down();
  await page.mouse.move(corner.x - 50, corner.y + 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await bounds(page)).minU).toBeLessThan(b0.minU - 1);
  const b1 = await bounds(page);
  const shift = { x: (await at(page, b1.minU, b1.maxV)).x - corner.x, y: (await at(page, b1.minU, b1.maxV)).y - corner.y };
  expect(Math.hypot(shift.x, shift.y), "the rectangle moved").toBeGreaterThan(20);
  const after = await Promise.all(ids.map(centreOf));
  after.forEach((c, i) => {
    expect(c.x, "label " + ids[i] + " moved with the geometry (x)").toBeCloseTo(before[i]!.x + shift.x, 0);
    expect(c.y, "label " + ids[i] + " moved with the geometry (y)").toBeCloseTo(before[i]!.y + shift.y, 0);
  });
  // One undo takes the drag back and the labels return to where they were.
  await page.getByTestId("undo").click();
  await expect.poll(async () => (await bounds(page)).minU).toBeCloseTo(b0.minU, 6);
  const back = await Promise.all(ids.map(centreOf));
  back.forEach((c, i) => {
    expect(c.x).toBeCloseTo(before[i]!.x, 0);
    expect(c.y).toBeCloseTo(before[i]!.y, 0);
  });
  expect(app.errors).toEqual([]);
});

test("Tab before typing moves the keyboard to the second field; Esc steps back one level at a time", async ({ app }) => {
  const page = await openSketch(app);
  await page.getByTestId("tool-line").click();
  const o = await at(page, 0, 0);
  await click(page, { x: o.x + 20, y: o.y - 20 });
  await page.mouse.move(o.x + 220, o.y - 20, { steps: 4 });
  // The first field has the keyboard from the start (clear focus look), the second one is calm.
  await expect(page.getByTestId("typed-length").locator("..")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("typed-angle").locator("..")).not.toHaveAttribute("data-active", "true");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("typed-angle").locator("..")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("typed-length").locator("..")).not.toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("typed-fields")).not.toHaveAttribute("data-typing", /.*/);
  await page.keyboard.press("9");
  await expect(page.getByTestId("typed-angle")).toBeFocused();
  await page.keyboard.type("0");
  await expect(page.getByTestId("typed-angle")).toHaveValue("90");
  // The length is still live, so its text is not what the user typed.
  await expect.poll(() => liveValue(page.getByTestId("typed-length"))).toBeGreaterThan(0);

  await page.keyboard.press("Escape"); // typing off, fields stay live
  await expect(page.getByTestId("typed-fields")).not.toHaveAttribute("data-typing", /.*/);
  await expect(page.getByTestId("typed-angle")).not.toBeFocused();
  await expect.poll(() => liveValue(page.getByTestId("typed-angle"))).toBeCloseTo(0, 0);
  await page.keyboard.press("Escape"); // the shape ends, no fields
  await expect(page.getByTestId("typed-fields")).toHaveCount(0);
  await expect(page.getByTestId("tool-line")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape"); // the tool ends
  await expect(page.getByTestId("tool-line")).toHaveAttribute("aria-pressed", "false");
  expect((await readView(page)).lines).toHaveLength(0);
  expect(app.errors).toEqual([]);
});

test("an error under a value field moves nothing: not the fields, not the view; the fields have no frame and no panel, Geist with tabular digits", async ({ app }) => {
  const page = await openSketch(app);
  await page.getByTestId("tool-line").click();
  const o = await at(page, 0, 0);
  await click(page, { x: o.x + 20, y: o.y - 20 });
  await page.mouse.move(o.x + 220, o.y - 20, { steps: 4 });
  // A typed length, then the angle field with a wrong text: the angle was not typed before, so the shape does not change
  // and the fields stay where they are; only the message appears.
  await page.keyboard.press("3");
  await page.keyboard.type("0");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("typed-angle")).toBeFocused();
  const targets: Targets = {
    length: page.getByTestId("typed-length"),
    angle: page.getByTestId("typed-angle"),
    lengthBox: page.getByTestId("typed-length").locator(".."),
    angleBox: page.getByTestId("typed-angle").locator(".."),
    viewport: page.getByTestId("viewport"),
    palette: page.getByTestId("sketch-palette"),
    prompt: page.getByTestId("sketch-prompt"),
    toolbar: page.getByTestId("toolbar"),
    timeline: page.getByTestId("timeline"),
  };
  const before = await snapshot(page, targets);

  await page.keyboard.type("x");
  await expect(page.getByTestId("typed-angle")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toBeVisible();
  expectNothingMoved(before, await snapshot(page, targets), "error under the angle field");
  await page.keyboard.press("Backspace");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expectNothingMoved(before, await snapshot(page, targets), "error gone again");

  // No panel, no frame and no frame inside a frame: neither the input nor its label has a border; the label is the calm
  // text on the dimension line, or the active field with a light surface and its accent line.
  const style = await page.getByTestId("typed-length").evaluate((input) => {
    const label = input.closest("label")!;
    const read = (el: Element) => {
      const cs = getComputedStyle(el);
      return { border: cs.borderTopWidth, radius: cs.borderTopLeftRadius, shadow: cs.boxShadow, font: cs.fontFamily, numerals: cs.fontVariantNumeric };
    };
    const wrapper = label.parentElement!;
    return { input: read(input), label: read(label), wrapper: read(wrapper), grand: read(wrapper.parentElement!), width: label.getBoundingClientRect().width };
  });
  expect(style.input.border).toBe("0px");
  expect(style.label.border).toBe("0px");
  expect(style.label.radius).toBe("3px");
  expect(style.wrapper.border).toBe("0px");
  expect(style.wrapper.shadow).toBe("none");
  expect(style.grand.border).toBe("0px");
  expect(style.label.font).toMatch(/Geist/);
  expect(style.label.font).not.toMatch(/mono/i);
  expect(style.label.numerals).toContain("tabular-nums");
  // 112 CSS px up to the float noise of layout units: at a fractional display scale (175 %) the computed width reads 112.0000076.
  expect(style.width).toBeCloseTo(112, 3);
  expect(app.errors).toEqual([]);
});

test("the field that edits a dimension looks exactly like the value fields of a drawing tool", async ({ app }) => {
  const page = await openSketch(app);
  await drawRectangle(page);
  const b = await bounds(page);
  await dimension(page, (b.minU + b.maxU) / 2, b.minV, 0, 36, String(Math.round(b.maxU - b.minU)));
  const d = (await readView(page)).dimensions[0]!;

  const look = (id: string) =>
    page.getByTestId(id).evaluate((input) => {
      const label = input.closest("label")!;
      const cs = getComputedStyle(label);
      const rect = label.getBoundingClientRect();
      return {
        border: cs.borderTopWidth,
        radius: cs.borderTopLeftRadius,
        font: cs.fontFamily,
        size: cs.fontSize,
        height: rect.height,
        width: rect.width,
        unit: getComputedStyle(label.lastElementChild!).color,
        inputBorder: getComputedStyle(input).borderTopWidth,
      };
    });

  await page.getByTestId("dim-" + d.id).dblclick();
  await expect(page.getByTestId("dim-input")).toBeFocused();
  const dim = await look("dim-input");
  // No panel around it either.
  expect(await page.getByTestId("dim-box").evaluate((el) => [getComputedStyle(el).borderTopWidth, getComputedStyle(el).boxShadow])).toEqual(["0px", "none"]);
  await page.keyboard.press("Escape");

  await page.keyboard.press("l");
  const o = await at(page, 0, 0, -100, 100);
  await click(page, o);
  await page.mouse.move(o.x + 100, o.y, { steps: 3 });
  const drawing = await look("typed-length");
  expect(drawing).toEqual(dim);
  expect(app.errors).toEqual([]);
});

test("a dimension value: typing follows the sketch, Esc brings the old value back, Enter commits one undo step; double-click edits", async ({ app }) => {
  const page = await openSketch(app);
  await drawRectangle(page);
  const b = await bounds(page);
  const width0 = b.maxU - b.minU;
  await dimension(page, (b.minU + b.maxU) / 2, b.minV, 0, 36, String(Math.round(width0)));
  const d = (await readView(page)).dimensions[0]!;
  const chip = page.getByTestId("dim-" + d.id);

  await chip.dblclick();
  const input = page.getByTestId("dim-input");
  await expect(input).toBeVisible();
  await input.fill("80");
  // The sketch follows while typing, without being committed.
  await expect.poll(async () => {
    const c = await bounds(page);
    return c.maxU - c.minU;
  }).toBeCloseTo(80, 3);
  await input.press("Escape");
  await expect(page.getByTestId("dim-box")).toHaveCount(0);
  await expect.poll(async () => {
    const c = await bounds(page);
    return c.maxU - c.minU;
  }).toBeCloseTo(Math.round(width0), 3);

  await chip.dblclick();
  await page.getByTestId("dim-input").fill("80");
  await page.getByTestId("dim-input").press("Enter");
  await expect.poll(async () => (await readView(page)).dimensions[0]!.value.value).toBe(80);
  // One undo step brings the old value back.
  await page.getByTestId("undo").click();
  await expect.poll(async () => (await readView(page)).dimensions[0]?.value.value).toBe(Math.round(width0));
  expect(app.errors).toEqual([]);
});

test("undo and redo inside the sketch reach back only to its own start; Ctrl+Z, Ctrl+Y and the buttons do the same", async ({ app }) => {
  const page = await openSketch(app, "lang=de");
  await expect(page.getByTestId("undo")).toBeDisabled();
  await expect(page.locator(".hc-tip", { has: page.getByTestId("undo") })).toHaveAttribute("data-tip", words.de.undoLimit);
  await drawRectangle(page);
  await expect(page.getByTestId("undo")).toBeEnabled();
  await expect(page.getByTestId("redo")).toBeDisabled();

  await page.getByTestId("undo").click();
  await expect.poll(async () => (await readView(page)).lines.length).toBe(0);
  await expect(page.getByTestId("undo")).toBeDisabled();
  await expect(page.getByTestId("redo")).toBeEnabled();
  // The sketch itself is still there: undo stopped at its start.
  await expect(page.getByTestId("timeline-step-f1")).toBeVisible();
  await expect(page.getByTestId("finish-sketch")).toBeVisible();

  await page.keyboard.press("Control+Y");
  await expect.poll(async () => (await readView(page)).lines.length).toBe(4);
  await page.keyboard.press("Control+Z");
  await expect.poll(async () => (await readView(page)).lines.length).toBe(0);
  await page.keyboard.press("Control+Z");
  await expect(page.getByTestId("timeline-step-f1")).toBeVisible();
  await page.keyboard.press("Control+Shift+Z");
  await expect.poll(async () => (await readView(page)).lines.length).toBe(4);
  expect(app.errors).toEqual([]);
});

test("a new dimension with a typed value is undone by ONE Ctrl+Z, and redone by one Ctrl+Y", async ({ app }) => {
  const page = await openSketch(app);
  await drawRectangle(page);
  const b = await bounds(page);
  const width0 = Math.round(b.maxU - b.minU);

  // Place the dimension and type another value: the sketch follows, Enter commits. That is one step, not two.
  const target = width0 + 25;
  await dimension(page, (b.minU + b.maxU) / 2, b.minV, 0, 36, String(target));
  await expect.poll(async () => (await readView(page)).dimensions.length).toBe(1);
  await expect.poll(async () => (await readView(page)).dimensions[0]!.value.value).toBe(target);
  await expect.poll(async () => {
    const c = await bounds(page);
    return c.maxU - c.minU;
  }).toBeCloseTo(target, 3);

  // ONE undo takes the dimension and its value; the rectangle (its own step) stays, and so does the width it had.
  await page.keyboard.press("Control+Z");
  await expect.poll(async () => (await readView(page)).dimensions.length).toBe(0);
  const undone = await readView(page);
  expect(undone.lines).toHaveLength(4);
  await expect.poll(async () => {
    const c = await bounds(page);
    return c.maxU - c.minU;
  }).toBeCloseTo(width0, 0);
  await expect(page.getByTestId("undo")).toBeEnabled();
  await expect(page.getByTestId("redo")).toBeEnabled();

  // ONE redo brings the dimension back with the typed value.
  await page.keyboard.press("Control+Y");
  await expect.poll(async () => (await readView(page)).dimensions.map((d) => d.value.value)).toEqual([target]);

  // The next Ctrl+Z pair reaches the rectangle and then the start of the sketch: two steps in all, not three.
  await page.keyboard.press("Control+Z");
  await expect.poll(async () => (await readView(page)).dimensions.length).toBe(0);
  await page.keyboard.press("Control+Z");
  await expect.poll(async () => (await readView(page)).lines.length).toBe(0);
  await expect(page.getByTestId("undo")).toBeDisabled();
  expect(app.errors).toEqual([]);
});

test("a rectangle with typed width and height is undone by ONE Ctrl+Z, and redone by one Ctrl+Y", async ({ app }) => {
  const page = await openSketch(app);
  await page.getByTestId("tool-rectangle").click();
  const o = await at(page, 0, 0);
  await click(page, o);
  await page.mouse.move(o.x - 120, o.y - 70, { steps: 4 });
  await page.keyboard.press("6");
  await expect(page.getByTestId("typed-width")).toBeFocused();
  await page.keyboard.type("0");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("typed-height")).toBeFocused();
  await page.keyboard.type("45");
  await page.keyboard.press("Enter");

  await expect.poll(async () => (await readView(page)).lines.length).toBe(4);
  await expect.poll(async () => (await readView(page)).dimensions.length).toBe(2);
  const drawn = await readView(page);
  expect(drawn.dimensions.map((d) => d.value.value).sort((x, y) => x - y)).toEqual([45, 60]);
  await expect(page.getByTestId("undo")).toBeEnabled();

  // ONE undo takes the rectangle with both dimensions and brings the sketch back to its start.
  await page.keyboard.press("Control+Z");
  await expect.poll(async () => (await readView(page)).lines.length).toBe(0);
  const empty = await readView(page);
  expect(empty.dimensions).toHaveLength(0);
  expect(empty.constraints).toHaveLength(0);
  await expect(page.getByTestId("undo")).toBeDisabled();
  await expect(page.getByTestId("redo")).toBeEnabled();

  // ONE redo brings the rectangle and both dimensions back.
  await page.keyboard.press("Control+Y");
  await expect.poll(async () => (await readView(page)).lines.length).toBe(4);
  const redone = await readView(page);
  expect(redone.dimensions.map((d) => d.value.value).sort((x, y) => x - y)).toEqual([45, 60]);
  await expect(page.getByTestId("redo")).toBeDisabled();

  // The timeline keeps its inner steps: the rectangle and one step per dimension.
  await page.getByTestId("timeline-expand-f1").click();
  await expect(page.getByTestId("timeline-sub-steps-f1").getByRole("button")).toHaveCount(3);
  expect(app.errors).toEqual([]);
});

test("the timeline shows the rectangle as ONE inner step, dimensions and constraints as steps of their own", async ({ app }) => {
  const page = await openSketch(app);
  await drawRectangle(page);
  await page.getByTestId("timeline-expand-f1").click();
  const inner = page.getByTestId("timeline-sub-steps-f1").getByRole("button");
  await expect(inner).toHaveCount(1);
  // The inner steps carry the names of the sketch (Rectangle 1, d0 · 60 mm), never an internal id.
  await expect(inner.first()).toHaveAccessibleName("Rectangle 1");
  await dimensionBothSides(page);
  await expect(inner).toHaveCount(3);
  await expect(inner.nth(1)).toHaveAccessibleName(/^d\d+ · 60 mm$/);
  await expect(inner.nth(2)).toHaveAccessibleName(/^d\d+ · \d+(\.\d+)? mm$/);
  expect(app.errors).toEqual([]);
});

test("a refused constraint names what it contradicts like the sketch does: d0 · 60 mm, Rectangle 1, never an id", async ({ app }) => {
  const page = await openSketch(app);
  const r = await definedRectangle(page); // bottom 60, right side 40
  // "Equal" between the bottom side (60) and the right side (40) contradicts the two dimensions.
  await page.getByTestId("tool-equal").click();
  await click(page, await at(page, r.midU, r.b.minV));
  await click(page, await at(page, r.b.maxU, r.midV));
  const dialog = page.getByTestId("sketch-reject-dialog");
  await expect(dialog).toBeVisible();
  const text = (await dialog.textContent()) ?? "";
  expect(text).not.toMatch(/\b[lkpc]\d+\b|\(d\d+\)|\bd\d{2,}\b/);
  // The names of the sketch: the dimensions that are in the way, and the shape the other constraints belong to.
  expect(text).toMatch(/d\d+ · (60|40) mm/);
  expect(text).toContain("Rectangle 1");
  expect(app.errors).toEqual([]);
});

test("constraints: a tool picks the references, Delete removes the selection, the symbols follow the display switch", async ({ app }) => {
  const page = await openSketch(app);
  await page.getByTestId("tool-line").click();
  const o = await at(page, 0, 0);
  await click(page, { x: o.x + 30, y: o.y - 20 });
  await click(page, { x: o.x + 220, y: o.y - 120 });
  await expect.poll(async () => (await readView(page)).lines.length).toBe(1);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tool-line")).toHaveAttribute("aria-pressed", "false");
  const v0 = await readView(page);
  expect(v0.lines).toHaveLength(1);
  const mid = await at(page, 0, 0, 125, -70);

  await page.getByTestId("tool-horizontal").click();
  await click(page, mid);
  await expect.poll(async () => (await readView(page)).constraints.map((c) => c.kind)).toEqual(["horizontal"]);
  const v1 = await readView(page);
  const [a, b] = [v1.points.find((p) => p.id === v1.lines[0]!.p1)!, v1.points.find((p) => p.id === v1.lines[0]!.p2)!];
  expect(a.y).toBeCloseTo(b.y, 6);
  const symbol = page.getByTestId("constraint-" + v1.constraints[0]!.id);
  await expect(symbol).toBeVisible();
  // The symbol is named by its kind and what it holds (Line 1), never by its id.
  await expect(symbol).toHaveAttribute("aria-label", "Horizontal: Line 1");

  // The display switch hides the symbols and shows them again.
  await page.getByRole("checkbox", { name: "Constraints" }).uncheck();
  await expect(symbol).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Constraints" }).check();
  await expect(symbol).toBeVisible();

  // Select the line (Esc leaves the tool first) and delete it.
  await page.keyboard.press("Escape");
  const y = (a.y + b.y) / 2;
  await click(page, await at(page, (a.x + b.x) / 2, y));
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await readView(page)).lines.length).toBe(0);
  expect(app.errors).toEqual([]);
});

for (const lang of ["en", "de"] as const) {
  test(`the sketch tools at the narrowest width: nothing moves while the state changes (${lang === "de" ? "German" : "English"})`, async ({ app }) => {
    const w = words[lang];
    const page = await openSketch(app, `lang=${lang}`);
    const innerWidth = await app.setWidth(NARROWEST_WIDTH);
    test.info().annotations.push({ type: "width", description: `window ${NARROWEST_WIDTH} px, page ${innerWidth} px` });
    const targets: Targets = {
      titlebar: page.getByTestId("titlebar"),
      toolbar: page.getByTestId("toolbar"),
      toolRow: page.getByTestId("tool-row"),
      tree: page.getByTestId("browser-tree"),
      contextBar: page.getByTestId("context-bar"),
      viewport: page.getByTestId("viewport"),
      navbar: page.getByTestId("navbar"),
      timeline: page.getByTestId("timeline"),
      statusBar: page.getByTestId("status-bar"),
      palette: page.getByTestId("sketch-palette"),
      finish: page.getByTestId("finish-sketch"),
      toolRectangle: page.getByTestId("tool-rectangle"),
      toolDimension: page.getByTestId("tool-dimension"),
      toolPointOnCurve: page.getByTestId("tool-pointOnCurve"),
    };
    await expect(page.getByTestId("tool-rectangle")).toContainText(w.rectangle);
    await expectNoHorizontalOverflow(page, "sketch tools");
    await expectNotTruncated(page.getByTestId("sketch-status-word"), "status word");
    await expectNotTruncated(page.getByTestId("sketch-prompt"), "prompt");
    const start = await snapshot(page, targets);

    // Empty -> under-defined -> fully defined, with the longest status texts: the palette keeps its size, nothing else moves.
    await drawRectangle(page);
    await expect(page.getByTestId("sketch-status-word")).toHaveText(w.under);
    expectNothingMoved(start, await snapshot(page, targets), "status under-defined");
    await dimensionBothSides(page);
    await expect(page.getByTestId("sketch-status-word")).toHaveText(w.fully);
    expectNothingMoved(start, await snapshot(page, targets), "status fully defined");
    await expectNotTruncated(page.getByTestId("sketch-status-why"), "status text");
    await expectNoHorizontalOverflow(page, "sketch tools, fully defined");

    // The message box over the view moves nothing either.
    await page.getByTestId("dim-" + (await readView(page)).dimensions[0]!.id).dblclick();
    await page.getByTestId("dim-input").fill("70x");
    await expect(page.getByRole("alert")).toBeVisible();
    expectNothingMoved(start, await snapshot(page, targets), "value box with a message");
    await page.keyboard.press("Escape");
    await page.getByTestId("undo").hover();
    expect(app.errors).toEqual([]);
  });
}

async function setMode(page: Page, mode: "light" | "dark"): Promise<void> {
  await page.getByTestId("settings-button").click();
  await page.getByTestId(`mode-${mode}`).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
}

test("screenshots of the real app for the report", async ({ app }, testInfo) => {
  test.skip(process.env.HALFCUBE_U2_SHOTS === undefined, "only when HALFCUBE_U2_SHOTS names a folder");
  const dir = process.env.HALFCUBE_U2_SHOTS!;
  const page = await openSketch(app, "lang=de&theme=praezision&mode=light");
  await page.setViewportSize({ width: 1440, height: 860 });
  await settled(page);
  await drawRectangle(page);
  // 1) drawing a line with a typed length, dark
  await page.getByTestId("tool-line").click();
  const o = await at(page, 0, 0, -130, 90);
  await click(page, o);
  await page.mouse.move(o.x + 300, o.y + 10, { steps: 4 });
  await page.keyboard.press("5");
  await page.keyboard.type("5");
  await setMode(page, "dark");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/u2-tippen-dunkel.png` });
  await setMode(page, "light");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // 2) fully defined with the band, light
  await dimensionBothSides(page);
  await page.keyboard.press("Escape");
  await page.mouse.move(4, 4);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/u2-bestimmt-hell.png` });
  // 3) a dimension the sketch already fixes: the top edge of the fully defined rectangle becomes a reference dimension at once,
  // in brackets and muted, with a calm notice, no value field and no dialog; dark
  await setMode(page, "dark");
  const c = await bounds(page);
  const before = (await readView(page)).dimensions.length;
  await page.keyboard.press("d");
  await expect(page.getByTestId("tool-dimension")).toHaveAttribute("aria-pressed", "true");
  await click(page, await at(page, (c.minU + c.maxU) / 2, c.maxV));
  await click(page, await at(page, (c.minU + c.maxU) / 2, c.maxV, 0, -36));
  await expect(page.getByTestId("dim-box")).toHaveCount(0);
  await expect(page.getByTestId("sketch-reject-dialog")).toHaveCount(0);
  await expect.poll(async () => (await readView(page)).dimensions.length).toBe(before + 1);
  const reference = (await readView(page)).dimensions.at(-1)!;
  expect(reference.driving).toBe(false);
  await expect(page.getByTestId("dim-" + reference.id)).toHaveAttribute("data-reference", "true");
  await expect(page.getByTestId("sketch-prompt")).toHaveAttribute("data-prompt", "alreadyFixed");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/u2-referenzmass-dunkel.png` });
  testInfo.annotations.push({ type: "screenshots", description: dir });
});

// ------------------------------------------------------------------------------------------------ the look of the value fields

/** The label around the input of a value field: it carries the look ("dimension" or "tag") and the tone (quiet, active, invalid). */
const fieldLabel = (page: Page, testId: string): Locator => page.getByTestId(testId).locator("..");

/** The computed colour of a token utility class (rgb string), read from a probe element, so a test names the token, not a number. */
async function tokenColour(page: Page, cls: string, prop: "color" | "backgroundColor" = "backgroundColor"): Promise<string> {
  return page.evaluate(
    ([c, p]) => {
      const probe = document.createElement("span");
      probe.className = c;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe)[p as "color"];
      probe.remove();
      return value;
    },
    [cls, prop] as const,
  );
}

/**
 * The frame of a value field (its ::after, a border all round laid over the label): present or not, the width and colour of each
 * side, its place inside the label (inset 0 on every side, so it adds no size), and the label's own size.
 */
function frameOf(label: Locator) {
  return label.evaluate((el) => {
    const after = getComputedStyle(el, "::after");
    const box = el.getBoundingClientRect();
    return {
      drawn: after.content !== "none",
      position: after.position,
      inset: [after.top, after.right, after.bottom, after.left],
      widths: [after.borderTopWidth, after.borderRightWidth, after.borderBottomWidth, after.borderLeftWidth],
      colours: [after.borderTopColor, after.borderRightColor, after.borderBottomColor, after.borderLeftColor],
      style: after.borderTopStyle,
      frameWidth: parseFloat(after.width),
      frameHeight: parseFloat(after.height),
      pointerEvents: after.pointerEvents,
      labelWidth: box.width,
      labelHeight: box.height,
      dpr: window.devicePixelRatio,
    };
  });
}

/** The frame is drawn on all four sides in one colour, thin (authored 1.5 px, the browser snaps it to whole device pixels), exactly over the label. */
function expectFrame(frame: Awaited<ReturnType<typeof frameOf>>, colour: string, what: string): void {
  expect(frame.drawn, `${what}: the frame is drawn`).toBe(true);
  expect(frame.position).toBe("absolute");
  expect(frame.inset, `${what}: the frame lies exactly over the label`).toEqual(["0px", "0px", "0px", "0px"]);
  expect(frame.style).toBe("solid");
  expect(new Set(frame.widths).size, `${what}: the same width on all four sides`).toBe(1);
  const width = parseFloat(frame.widths[0]!);
  // The browser snaps a border to whole device pixels, so the computed CSS width depends on the display scaling (1 device px at
  // 175 % is 0.571 CSS px): the check is in device pixels, at least one and at most two.
  expect(width * frame.dpr, `${what}: the frame is thin but visible (device px)`).toBeGreaterThanOrEqual(0.99);
  expect(width * frame.dpr).toBeLessThanOrEqual(2.01);
  expect(frame.colours, `${what}: one colour on all four sides`).toEqual([colour, colour, colour, colour]);
  expect(frame.frameWidth, `${what}: the frame covers the label (no extra size)`).toBeCloseTo(frame.labelWidth, 1);
  expect(frame.frameHeight).toBeCloseTo(frame.labelHeight, 1);
  expect(frame.pointerEvents, `${what}: the frame does not catch the pointer`).toBe("none");
}

/** The one size of a dimension-look field (FIELD_SIZE), in every tone. */
function expectFieldSize(frame: Awaited<ReturnType<typeof frameOf>>, what: string): void {
  expect(frame.labelWidth, `${what}: width`).toBeCloseTo(112, 1);
  expect(frame.labelHeight, `${what}: height`).toBeCloseTo(26, 1);
}

/** The look of a label: frame, shadow, colours, font, as computed. */
function labelStyle(label: Locator) {
  return label.evaluate((el) => {
    const cs = getComputedStyle(el);
    const input = el.querySelector("input")!;
    return {
      border: cs.borderTopWidth,
      shadow: cs.boxShadow,
      background: cs.backgroundColor,
      colour: cs.color,
      font: cs.fontFamily,
      numerals: cs.fontVariantNumeric,
      unitColour: getComputedStyle(el.lastElementChild!).color,
      unitSize: getComputedStyle(el.lastElementChild!).fontSize,
      caret: getComputedStyle(input).caretColor,
    };
  });
}

test("drawing a rectangle: the values are calm text on live dimension lines, the field that is typed into has a light primary tint and a frame all round, Tab moves it, a wrong value turns it red (tint and frame) and nothing moves", async ({ app }) => {
  const page = await openSketch(app);
  await page.getByTestId("tool-rectangle").click();
  const corner = await at(page, 0, 0);
  await click(page, corner);
  await page.mouse.move(corner.x - 200, corner.y - 100, { steps: 4 });
  const width = fieldLabel(page, "typed-width");
  const height = fieldLabel(page, "typed-height");
  await expect(width).toHaveAttribute("data-look", "dimension");
  await expect(width).toHaveAttribute("data-tone", "active");
  await expect(height).toHaveAttribute("data-tone", "editable");
  await expect.poll(() => liveValue(page.getByTestId("typed-width"))).toBeGreaterThan(5);

  // Calm text: no frame, no shadow, the colour of the view behind it (it hides the dimension line under the digits), Geist with
  // tabular digits (never monospace), the unit small and muted. The field that is typed into: a light tint of the primary colour
  // with a frame all round (a pseudo-element over the label, no layout border).
  const viewportColour = await tokenColour(page, "bg-viewport");
  const tintColour = await tokenColour(page, "bg-field-tint");
  // (The other typed field can be typed into too, so it has the calm "editable" look, checked further down; the read-only look
  // "quiet" is the text of a committed dimension, checked in the dimension test.)
  const quiet = await labelStyle(height);
  expect(quiet).toMatchObject({ border: "0px", unitSize: "11px" });
  const surfaceColour = await tokenColour(page, "bg-surface");
  expect(quiet.background, "editable: a plain surface").toBe(surfaceColour);
  expect(quiet.colour).toBe(await tokenColour(page, "text-fg", "color"));
  expect(quiet.unitColour).toBe(await tokenColour(page, "text-muted", "color"));
  expect(quiet.font).toMatch(/Geist/);
  expect(quiet.font).not.toMatch(/mono/i);
  expect(quiet.numerals).toContain("tabular-nums");
  const active = await labelStyle(width);
  expect(active).toMatchObject({ border: "0px", background: tintColour });
  expect(active.background, "the tint is not the quiet colour of the view").not.toBe(viewportColour);
  expect(active.colour).toBe(await tokenColour(page, "text-fg", "color"));
  expect(active.caret).toBe(await tokenColour(page, "text-primary", "color"));

  // The frame: all round in the primary colour, drawn inside the label; the quiet field has neither frame nor tint, and both have
  // the same size (nothing grows when a field becomes active).
  const primaryColour = await tokenColour(page, "bg-primary");
  const activeFrame = await frameOf(width);
  expectFrame(activeFrame, primaryColour, "active width field");
  expectFieldSize(activeFrame, "active width field");
  // The inactive field that can still be typed into: a plain surface and a thin neutral (muted) frame, no accent colour; weaker
  // than the active one (thinner, no tint), same size.
  const mutedColour = await tokenColour(page, "bg-muted");
  const editableFrame = await frameOf(height);
  expectFrame(editableFrame, mutedColour, "editable height field");
  expectFieldSize(editableFrame, "editable height field");
  // (At 100 % scaling the authored 1.5 px and 1 px both snap to one device pixel; then the tint and the colour carry the difference.)
  expect(parseFloat(editableFrame.widths[0]!), "the editable frame is not thicker than the active one").toBeLessThanOrEqual(parseFloat(activeFrame.widths[0]!));
  expect(editableFrame.colours[0], "no accent colour on the inactive field").not.toBe(primaryColour);
  expect(quiet.background, "the editable field has no primary tint").not.toBe(tintColour);
  expect(quiet.colour).toBe(await tokenColour(page, "text-fg", "color"));
  expect(quiet.caret, "the caret stays the primary colour").toBe(await tokenColour(page, "text-primary", "color"));
  // The selected text has its own solid colour, clearly different from the tint.
  expect(await width.locator("input").evaluate((el) => getComputedStyle(el, "::selection").backgroundColor)).toBe(primaryColour);

  // The dimension lines are drawn while the rectangle is drawn: the width 32 px below the edge through the start, left of the label.
  await page.getByRole("checkbox", { name: "Constraints" }).uncheck();
  const bg = await hideLabelsAndShoot(page);
  const onLine = bg({ x: corner.x - 20, y: corner.y + 32 }, 1);
  const beside = bg({ x: corner.x - 20, y: corner.y + 32 + 10 }, 1);
  expect(colourDistance(onLine, beside), "the dimension line of the width is drawn 32 px below the edge").toBeGreaterThan(10);

  // Tab moves the focus to the height: it becomes the active field, the width goes quiet.
  await page.keyboard.press("Tab");
  await expect(height).toHaveAttribute("data-tone", "active");
  await expect(width).toHaveAttribute("data-tone", "editable");
  expectFrame(await frameOf(height), primaryColour, "height field after Tab");
  // The width field went back to the calm editable look (frame thin and grey, surface, no tint).
  expectFrame(await frameOf(width), mutedColour, "width field after Tab");
  expect((await labelStyle(width)).background, "the width field lost its tint").toBe(surfaceColour);
  expectFieldSize(await frameOf(width), "width field after Tab");
  expectFieldSize(await frameOf(height), "height field after Tab");
  await page.keyboard.press("Tab");
  await expect(width).toHaveAttribute("data-tone", "active");

  // A wrong value: the field goes red (text, tint and frame), the message appears, nothing moves.
  const targets: Targets = {
    width: page.getByTestId("typed-width"),
    height: page.getByTestId("typed-height"),
    widthBox: width,
    heightBox: height,
    viewport: page.getByTestId("viewport"),
    palette: page.getByTestId("sketch-palette"),
  };
  // (The hint bar is not a target: opening the typing changes its text, which has nothing to do with the message.)
  const before = await snapshot(page, targets);
  await page.keyboard.press("-"); // opens the typing with a text that is no number yet
  await expect(page.getByTestId("typed-width")).toHaveAttribute("aria-invalid", "true");
  await expect(width).toHaveAttribute("data-tone", "invalid");
  await expect(page.getByRole("alert")).toBeVisible();
  const errorColour = await tokenColour(page, "bg-error");
  const invalidFrame = await frameOf(width);
  expectFrame(invalidFrame, errorColour, "invalid width field");
  expectFieldSize(invalidFrame, "invalid width field");
  expect((await labelStyle(width)).background).toBe(await tokenColour(page, "bg-field-tint-error"));
  expect((await labelStyle(width)).background, "the red tint differs from the primary tint").not.toBe(tintColour);
  expect((await labelStyle(width)).colour).toBe(await tokenColour(page, "text-error", "color"));
  expect(await width.locator("input").evaluate((el) => getComputedStyle(el, "::selection").backgroundColor), "selected text in a wrong value is red").toBe(errorColour);
  expectNothingMoved(before, await snapshot(page, targets), "message under the width field");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect((await readView(page)).lines).toHaveLength(0);
  expect(app.errors).toEqual([]);
});

test("a circle: the diameter sits beyond the rim on its dimension line, with the Ø sign; a line: the length beside it and the angle beyond its arc, Tab changes the active one", async ({ app }) => {
  const page = await openSketch(app);
  const ppm = await page.evaluate(() => (window as unknown as Hooks).__halfcube!.layer!.pxPerMm());
  await page.getByTestId("tool-circle").click();
  const o = await at(page, 0, 0, -60, 60);
  await click(page, o);
  await page.mouse.move(o.x + 100, o.y, { steps: 4 });
  const diameter = fieldLabel(page, "typed-diameter");
  await expect(diameter).toHaveAttribute("data-look", "dimension");
  await expect(diameter).toHaveAttribute("data-tone", "active");
  await expect(diameter).toContainText("Ø");
  await expect.poll(() => liveValue(page.getByTestId("typed-diameter"))).toBeCloseTo(200 / ppm, 1);
  // The value sits on the diameter line, beyond the rim (100 px from the centre) by 70 px, in the direction of the pointer.
  const box = (await diameter.boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - (o.x + 100 + 70)), "diameter beyond the rim (x)").toBeLessThan(3);
  expect(Math.abs(box.y + box.height / 2 - o.y), "diameter on the line through the centre (y)").toBeLessThan(3);
  await page.keyboard.press("Tab"); // one field only: nothing changes
  await expect(diameter).toHaveAttribute("data-tone", "active");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await page.keyboard.press("l");
  const start = await at(page, 0, 0, 40, 100);
  await click(page, start);
  await page.mouse.move(start.x + 150, start.y - 100, { steps: 4 });
  const length = fieldLabel(page, "typed-length");
  const angle = fieldLabel(page, "typed-angle");
  await expect(length).toHaveAttribute("data-tone", "active");
  await expect(angle).toHaveAttribute("data-tone", "editable");
  await expect.poll(() => liveValue(page.getByTestId("typed-angle"))).toBeCloseTo(33.69, 0);
  // The angle sits beyond its arc on the bisector: further from the start than the arc (70 % of the line, at most 90 px).
  // The length of this 180 px line has room: its value sits in the middle of the dimension line, 34 px up and to the left of the line.
  const l = (await length.boundingBox())!;
  expect(Math.abs(l.x + l.width / 2 - (start.x + 75 - 0.555 * 34)), "length on the middle of its dimension line (x)").toBeLessThan(3);
  expect(Math.abs(l.y + l.height / 2 - (start.y - 50 - 0.832 * 34)), "length on the middle of its dimension line (y)").toBeLessThan(3);
  const a = (await angle.boundingBox())!;
  const dist = Math.hypot(a.x + a.width / 2 - start.x, a.y + a.height / 2 - start.y);
  expect(dist, "the angle is beyond its arc").toBeGreaterThan(Math.min(90, Math.hypot(150, 100) * 0.7) + 40);
  await page.keyboard.press("Tab");
  await expect(angle).toHaveAttribute("data-tone", "active");
  await expect(length).toHaveAttribute("data-tone", "editable");
  expectFrame(await frameOf(angle), await tokenColour(page, "bg-primary"), "angle field after Tab");
  await page.keyboard.type("45");
  await expect(page.getByTestId("typed-angle")).toHaveValue("45");
  await page.keyboard.press("Tab"); // the typed 45 stays, the length takes the keyboard
  await expect(length).toHaveAttribute("data-tone", "active");
  await expect(page.getByTestId("typed-angle")).toHaveValue("45");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  expect((await readView(page)).lines).toHaveLength(0);
  expect(app.errors).toEqual([]);
});

test("editing a dimension: the value is calm text on its line, the edit field gets the primary tint and a frame all round, a wrong value turns it red, nothing moves; committed dimensions have no frame", async ({ app }) => {
  const page = await openSketch(app);
  await drawRectangle(page);
  const b = await bounds(page);
  await dimension(page, (b.minU + b.maxU) / 2, b.minV, 0, 36, "60");
  await dimension(page, b.maxU, (b.minV + b.maxV) / 2, 40, 0, "40");
  const view = await readView(page);
  const [first, second] = view.dimensions;
  const text = page.getByTestId("dim-" + first!.id);
  const other = page.getByTestId("dim-" + second!.id);

  // A committed dimension: text on the line, no box, no frame, no mono, the dimension colour.
  const committed = await text.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { border: cs.borderTopWidth, style: cs.borderTopStyle, shadow: cs.boxShadow, font: cs.fontFamily, numerals: cs.fontVariantNumeric, colour: cs.color, background: cs.backgroundColor };
  });
  expect(committed).toMatchObject({ border: "0px", shadow: "none", background: await tokenColour(page, "bg-viewport"), colour: await tokenColour(page, "text-dim-text", "color") });
  expect(committed.font).toMatch(/Geist/);
  expect(committed.font).not.toMatch(/mono/i);
  expect(committed.numerals).toContain("tabular-nums");

  await text.dblclick();
  const input = page.getByTestId("dim-input");
  const label = input.locator("..");
  await expect(input).toBeFocused();
  await expect(label).toHaveAttribute("data-look", "dimension");
  await expect(label).toHaveAttribute("data-tone", "active");
  const editFrame = await frameOf(label);
  expectFrame(editFrame, await tokenColour(page, "bg-primary"), "dimension edit field");
  expectFieldSize(editFrame, "dimension edit field");
  expect((await labelStyle(label)).background).toBe(await tokenColour(page, "bg-field-tint"));
  // Opening selects the whole value (our own selection colour, never the browser's), so typing replaces it.
  expect(await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd, el.value.length])).toEqual([0, 2, 2]);

  const targets: Targets = { box: page.getByTestId("dim-box"), input, other, viewport: page.getByTestId("viewport"), palette: page.getByTestId("sketch-palette"), prompt: page.getByTestId("sketch-prompt") };
  const before = await snapshot(page, targets);
  await input.fill("0");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(label).toHaveAttribute("data-tone", "invalid");
  await expect(page.getByRole("alert")).toBeVisible();
  const editInvalid = await frameOf(label);
  expectFrame(editInvalid, await tokenColour(page, "bg-error"), "invalid dimension edit field");
  expectFieldSize(editInvalid, "invalid dimension edit field");
  expect((await labelStyle(label)).background).toBe(await tokenColour(page, "bg-field-tint-error"));
  expect((await labelStyle(label)).colour).toBe(await tokenColour(page, "text-error", "color"));
  expectNothingMoved(before, await snapshot(page, targets), "message under the dimension field");
  await input.press("Escape");
  await expect(page.getByTestId("dim-box")).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

test("the look Etikett is a choice in the settings dialog: filled labels with a leader line, grey while the value follows the pointer, the primary colour when active, red when wrong; it is stored", async ({ app }) => {
  const page = await openSketch(app);
  await expect(page.getByTestId("typed-fields")).toHaveCount(0);
  await page.getByTestId("settings-button").click();
  await page.getByTestId("settings-tab-sketch").click();
  await expect(page.getByTestId("field-look-dimension")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("field-look-tag").click();
  await expect(page.getByTestId("field-look-tag")).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => localStorage.getItem("halfcube.settings.fieldLook"))).toBe("tag");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);

  await page.getByTestId("tool-line").click();
  const start = await at(page, 0, 0, 40, 100);
  await click(page, start);
  await page.mouse.move(start.x + 200, start.y - 60, { steps: 4 });
  const length = fieldLabel(page, "typed-length");
  const angle = fieldLabel(page, "typed-angle");
  await expect(page.getByTestId("typed-fields")).toHaveAttribute("data-look", "tag");
  await expect(length).toHaveAttribute("data-look", "tag");
  // A thin leader line from each label to the geometry.
  await expect(page.getByTestId("leader-length")).toBeVisible();
  await expect(page.getByTestId("leader-angle")).toBeVisible();
  // The fill says the state: the primary colour for the active field, grey for the other, text colours the themes guarantee.
  const activeLook = await labelStyle(length);
  const quietLook = await labelStyle(angle);
  expect(activeLook).toMatchObject({ border: "0px", background: await tokenColour(page, "bg-primary"), colour: await tokenColour(page, "text-on-primary", "color") });
  expect(quietLook).toMatchObject({ border: "0px", background: await tokenColour(page, "bg-muted"), colour: await tokenColour(page, "text-surface", "color") });
  expect(activeLook.font).toMatch(/Geist/);
  expect(activeLook.font).not.toMatch(/mono/i);
  expect(activeLook.numerals).toContain("tabular-nums");
  expect((await frameOf(length)).drawn, "the label has no frame").toBe(false);

  await page.keyboard.press("Tab");
  await expect(angle).toHaveAttribute("data-tone", "active");
  expect((await labelStyle(angle)).background).toBe(await tokenColour(page, "bg-primary"));
  expect((await labelStyle(length)).background).toBe(await tokenColour(page, "bg-muted"));

  // Red for a wrong value, and nothing moves when the message comes.
  const targets: Targets = { length: page.getByTestId("typed-length"), angle: page.getByTestId("typed-angle"), lengthBox: length, angleBox: angle, viewport: page.getByTestId("viewport"), palette: page.getByTestId("sketch-palette") };
  const before = await snapshot(page, targets);
  await page.keyboard.press("-");
  await expect(angle).toHaveAttribute("data-tone", "invalid");
  await expect(page.getByRole("alert")).toBeVisible();
  const red = await labelStyle(angle);
  expect(red).toMatchObject({ background: await tokenColour(page, "bg-error"), colour: await tokenColour(page, "text-surface", "color") });
  expectNothingMoved(before, await snapshot(page, targets), "message under the angle label");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // This look draws no measuring graphics: where the dimension line of a rectangle's width would run (32 px below the edge), the
  // view looks like it does beside that line. (The leader line and the labels are elsewhere.)
  await page.keyboard.press("r");
  const corner = await at(page, 0, 0);
  await click(page, corner);
  await page.mouse.move(corner.x - 200, corner.y - 100, { steps: 4 });
  await expect(page.getByTestId("leader-width")).toBeVisible();
  await page.getByRole("checkbox", { name: "Constraints" }).uncheck();
  const shot = await hideLabelsAndShoot(page);
  expect(
    colourDistance(shot({ x: corner.x - 20, y: corner.y + 32 }, 1), shot({ x: corner.x - 20, y: corner.y + 42 }, 1)),
    "no dimension line is drawn in the look Etikett",
  ).toBeLessThan(10);
  await page.getByRole("checkbox", { name: "Constraints" }).check();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // The dimension edit field follows the choice: the active label.
  await drawRectangle(page);
  const b = await bounds(page);
  await dimension(page, (b.minU + b.maxU) / 2, b.minV, 0, 36, "60");
  const d = (await readView(page)).dimensions[0]!;
  await page.getByTestId("dim-" + d.id).dblclick();
  const edit = page.getByTestId("dim-input").locator("..");
  await expect(edit).toHaveAttribute("data-look", "tag");
  expect((await labelStyle(edit)).background).toBe(await tokenColour(page, "bg-primary"));
  await page.keyboard.press("Escape");
  expect(app.errors).toEqual([]);
});

test("screenshots of the value fields while drawing and editing, for the report", async ({ app }, testInfo) => {
  test.skip(process.env.HALFCUBE_U2_SHOTS === undefined, "only when HALFCUBE_U2_SHOTS names a folder");
  const dir = process.env.HALFCUBE_U2_SHOTS!;
  const page = await openSketch(app, "lang=de&theme=praezision&mode=light");
  await page.setViewportSize({ width: 1440, height: 860 });
  await settled(page);
  const o = await at(page, 0, 0, -120, 60);
  // One picture in light and in dark mode of whatever is on the screen now.
  const shoot = async (name: string) => {
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${dir}/produkt-${name}-hell.png` });
    await setMode(page, "dark");
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${dir}/produkt-${name}-dunkel.png` });
    await setMode(page, "light");
  };

  // A rectangle: the width is typed (light surface and accent line), the height follows the pointer.
  await page.keyboard.press("r");
  await click(page, o);
  await page.mouse.move(o.x + 300, o.y - 160, { steps: 5 });
  await page.keyboard.press("6");
  await page.keyboard.type("0");
  await page.mouse.move(o.x + 300, o.y - 170, { steps: 3 });
  await shoot("rechteck");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // A circle: the diameter follows the pointer, nothing typed.
  await page.getByTestId("tool-circle").click();
  await click(page, o);
  await page.mouse.move(o.x + 120, o.y + 70, { steps: 5 });
  await expect(page.getByTestId("typed-diameter")).toBeVisible();
  await shoot("kreis");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // A line with its angle arc: the length has the keyboard, the angle follows.
  await page.keyboard.press("l");
  await click(page, o);
  await page.mouse.move(o.x + 260, o.y - 150, { steps: 5 });
  await expect(page.getByTestId("typed-angle")).toBeVisible();
  await shoot("linie");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // A wrong value: red line, red text and the message under it.
  await page.keyboard.press("r");
  await click(page, o);
  await page.mouse.move(o.x + 300, o.y - 160, { steps: 5 });
  await page.keyboard.press("-");
  await expect(page.getByRole("alert")).toBeVisible();
  await shoot("ungueltig");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Editing a dimension: committed values are calm text on their lines; the double-clicked one opens with its value selected.
  await drawRectangle(page);
  await dimensionBothSides(page);
  await page.keyboard.press("Escape");
  const d = (await readView(page)).dimensions[0]!;
  await page.getByTestId("dim-" + d.id).dblclick();
  await expect(page.getByTestId("dim-input")).toBeFocused();
  await page.mouse.move(4, 4);
  await shoot("masz-bearbeiten");
  await page.keyboard.press("Escape");

  // The look "Etikett" from the settings dialog: a line and a rectangle with leader lines.
  await page.getByTestId("settings-button").click();
  await page.getByTestId("settings-tab-sketch").click();
  await page.getByTestId("field-look-tag").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("l");
  await click(page, await at(page, 0, 0, -330, 150));
  await page.mouse.move((await at(page, 0, 0, -130, 20)).x, (await at(page, 0, 0, -130, 20)).y, { steps: 5 });
  await expect(page.getByTestId("leader-length")).toBeVisible();
  await shoot("etikett-linie");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("r");
  await click(page, await at(page, 0, 0, -400, 200));
  await page.mouse.move((await at(page, 0, 0, -220, 80)).x, (await at(page, 0, 0, -220, 80)).y, { steps: 5 });
  await page.keyboard.press("4");
  await page.keyboard.type("5");
  await shoot("etikett-rechteck");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  testInfo.annotations.push({ type: "screenshots", description: dir });
});

test("screenshots of the value field frames: active, editable, invalid, dimension edit, for the report", async ({ app }) => {
  test.skip(process.env.HALFCUBE_RAHMEN_SHOTS === undefined, "only when HALFCUBE_RAHMEN_SHOTS names a folder");
  const dir = process.env.HALFCUBE_RAHMEN_SHOTS!;
  for (const [theme, mode] of [["praezision", "light"], ["praezision", "dark"], ["graphit", "dark"]] as const) {
    const name = `${theme}-${mode === "light" ? "hell" : "dunkel"}`;
    const page = await openSketch(app, `lang=de&theme=${theme}&mode=${mode}`);
    await page.setViewportSize({ width: 1440, height: 860 });
    await settled(page);
    const o = await at(page, 0, 0, -120, 60);
    const shoot = async (kind: string) => {
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${dir}/produkt-rahmen-${kind}-${name}.png` });
    };
    // Rectangle: the width has the keyboard (tint and frame), the height can be typed into too (neutral frame).
    await page.keyboard.press("r");
    await click(page, o);
    await page.mouse.move(o.x + 300, o.y - 160, { steps: 5 });
    await page.keyboard.press("6");
    await page.keyboard.type("0");
    await shoot("aktiv-und-inaktiv");
    // The same with a wrong value in the width.
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("-");
    await expect(fieldLabel(page, "typed-width")).toHaveAttribute("data-tone", "invalid");
    await shoot("ungueltig");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    // The edit field of a dimension.
    await drawRectangle(page);
    const b = await bounds(page);
    await dimension(page, (b.minU + b.maxU) / 2, b.minV, 0, 36, "60");
    const d = (await readView(page)).dimensions[0]!;
    await page.getByTestId("dim-" + d.id).dblclick();
    await expect(page.getByTestId("dim-input")).toBeFocused();
    await shoot("masszahl");
    await page.keyboard.press("Escape");
  }
});
