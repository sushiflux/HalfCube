// The 3D view (demo page ?demo=viewport): it draws with WebGPU or the WebGL2 fallback, follows the theme live, navigates with
// the mouse and touchpad presets, turns with the axis navigator, picks and highlights, draws pixel-width lines with dashes,
// renders only on demand and cleans up after itself. Also the sketch layer (?demo=viewport&sketch=1). Runs in the browser and in the Electron program.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { DEFAULT_FOV_Y } from "../../../app/src/viewport/camera.ts";
import { getTheme, themeKeys, type Mode } from "../../../app/src/theme/themes.ts";
import { expect, test, type AppUnderTest } from "../support/fixtures.ts";
import { colourDistance, countDifferent, countDifferentIn, distinctColours, dominantColour, hexToRgb, meanColour, pixelAt, type Rgb } from "../support/png.ts";
import {
  backendOf, clientPointOf, demo, discRegion, frameRegion, getView, idle, isOverCanvas, openDemo, openExtrudeDemo, openSketchDemo, renderCount, setView, shootHost, sketchPoint,
  type ExtrudeEvent, type Measurement, type Ref, type SketchHoverMeasurement, type Vec3, type View, type WheelMeasurement,
} from "../support/viewport.ts";

const HALF_PI = Math.PI / 2;
const light = getTheme("praezision").tokens.light;
const dark = getTheme("praezision").tokens.dark;

const noErrors = (app: AppUnderTest) => expect(app.errors, "no console errors").toEqual([]);

/** The middle of the 3D view's area, away from the overlays. */
async function centre(app: AppUnderTest): Promise<{ x: number; y: number }> {
  const box = await app.page.getByTestId("viewport-host").boundingBox();
  if (!box) throw new Error("no 3D view");
  return { x: box.x + box.width / 2, y: box.y + box.height * 0.62 };
}

async function sampleEmptyPoint(app: AppUnderTest): Promise<{ x: number; y: number }> {
  const box = await app.page.getByTestId("viewport-host").boundingBox();
  if (!box) throw new Error("no 3D view");
  return { x: box.x + box.width - 40, y: box.y + box.height - 40 };
}

async function dragWith(app: AppUnderTest, button: "left" | "middle", keys: string[], dx: number, dy: number): Promise<void> {
  const { page } = app;
  const c = await centre(app);
  for (const k of keys) await page.keyboard.down(k);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down({ button });
  await page.mouse.move(c.x + dx / 2, c.y + dy / 2, { steps: 4 });
  await page.mouse.move(c.x + dx, c.y + dy, { steps: 4 });
  await page.mouse.up({ button });
  for (const k of keys.reverse()) await page.keyboard.up(k);
  await idle(page);
}

for (const renderer of ["auto", "webgl2"] as const) {
  test(`the demo draws and reports its backend (${renderer === "auto" ? "WebGPU when available" : "WebGL2 forced"})`, async ({ app }) => {
    const { page } = app;
    await openDemo(app, { renderer });
    const backend = await backendOf(page);
    if (renderer === "webgl2") expect(backend).toBe("WebGL2");
    expect(["WebGPU", "WebGL2"]).toContain(backend);
    const info = await page.getByTestId("viewport-backend").textContent();
    test.info().annotations.push({ type: `backend (${renderer})`, description: info ?? "" });
    expect(await demo<number>(page, "viewport.backend.msaaSamples")).toBe(4);

    const shot = await shootHost(page);
    const background = hexToRgb(light.viewport);
    // Not blank: the background is there and many pixels differ from it (grid, bodies, sketch lines, navigator).
    expect(colourDistance(dominantColour(shot.image), background), "dominant colour is the theme's viewport colour").toBeLessThanOrEqual(3);
    expect(countDifferent(shot.image, background, 12)).toBeGreaterThan(3000);
    expect(distinctColours(shot.image)).toBeGreaterThan(40);
    noErrors(app);
  });
}

test("a theme or mode switch changes the view's colours live, from the theme tokens", async ({ app }) => {
  const { page } = app;
  await openDemo(app, { theme: "praezision", mode: "light" });
  const before = await shootHost(page);
  expect(colourDistance(dominantColour(before.image), hexToRgb(light.viewport))).toBeLessThanOrEqual(3);

  await page.getByTestId("vp-mode").click();
  await idle(page);
  const after = await shootHost(page);
  expect(colourDistance(dominantColour(after.image), hexToRgb(dark.viewport)), "dark mode background").toBeLessThanOrEqual(3);

  await page.getByRole("button", { name: "skizze", exact: true }).click();
  await idle(page);
  const skizze = await shootHost(page);
  expect(colourDistance(dominantColour(skizze.image), hexToRgb(getTheme("skizze").tokens.dark.viewport)), "other theme background").toBeLessThanOrEqual(3);
  noErrors(app);
});

test.describe("axis navigator", () => {
  test("a click turns the view, a second click shows the opposite side", async ({ app }) => {
    const { page } = app;
    await openDemo(app);
    const disc = (key: string) => page.getByTestId(`nav-end-${key}`).locator("circle").last();

    await disc("+z").click();
    await idle(page);
    expect((await getView(page)).elevation).toBeCloseTo(HALF_PI, 6);
    await disc("+z").click();
    await idle(page);
    expect((await getView(page)).elevation).toBeCloseTo(-HALF_PI, 6);
    // From below the nearest end at the centre is the ring of -Z: it is the one to click for the way back.
    await disc("-z").click();
    await idle(page);
    expect((await getView(page)).elevation).toBeCloseTo(HALF_PI, 6);

    await disc("+x").click();
    await idle(page);
    let v = await getView(page);
    expect(v.elevation).toBeCloseTo(0, 6);
    expect(v.azimuth).toBeCloseTo(HALF_PI, 6); // looks from the right
    await disc("+x").click();
    await idle(page);
    v = await getView(page);
    expect(Math.abs(Math.abs(v.azimuth) - HALF_PI)).toBeLessThan(1e-6); // now from the left
    expect(v.azimuth).toBeLessThan(0);

    await disc("+y").click(); // Hinten / Back
    await idle(page);
    expect(Math.abs((await getView(page)).azimuth)).toBeCloseTo(Math.PI, 6);
    noErrors(app);
  });

  test("the house button returns to the start view", async ({ app }) => {
    const { page } = app;
    await openDemo(app);
    const start = await getView(page);
    await dragWith(app, "middle", ["Shift"], 120, 30);
    expect((await getView(page)).azimuth).not.toBeCloseTo(start.azimuth, 2);
    await page.getByTestId("nav-home").click();
    await idle(page);
    const back = await getView(page);
    expect(back.azimuth).toBeCloseTo(start.azimuth, 6);
    expect(back.elevation).toBeCloseTo(start.elevation, 6);
    expect(back.distance).toBeCloseTo(start.distance, 3);
  });

  test("dragging the navigator orbits the view", async ({ app }) => {
    const { page } = app;
    await openDemo(app);
    const before = await getView(page);
    const box = await page.getByTestId("axis-navigator").boundingBox();
    if (!box) throw new Error("no navigator");
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x - 30, y + 30);
    await page.mouse.down();
    await page.mouse.move(x - 10, y + 30, { steps: 4 });
    await page.mouse.move(x + 20, y + 30, { steps: 4 });
    await page.mouse.up();
    await idle(page);
    const after = await getView(page);
    expect(after.azimuth).toBeLessThan(before.azimuth); // dragged right: the model turns right
    expect(after.distance).toBeCloseTo(before.distance, 6);
  });

  // The turn and tip arrows around the navigator: quarter-circle arrows above turn about the vertical axis, chevrons at the
  // sides tip to the neighbouring standard view. They show only in a standard view.
  test.describe("turn and tip arrows", () => {
    const arrowIds = ["turn-left", "turn-right", "tip-up", "tip-down", "tip-left", "tip-right"] as const;
    // The top view reached by a click keeps the nearest quarter turn of the start view (that is 90 degrees), so the tests set the
    // azimuth they rely on: 0 means "down on the screen is Front".
    const align = async (page: Page, key: string): Promise<void> => {
      await demo<void>(page, "viewport.alignToAxis", [key, false]);
      await idle(page);
      const v = await getView(page);
      await setView(page, { ...v, azimuth: key === "+z" || key === "-z" ? 0 : v.azimuth });
    };
    const settled = async (page: Page): Promise<View> => {
      await idle(page);
      return getView(page);
    };
    // a quarter turn compares by direction on the circle, not by the number (-pi and pi are the same view)
    const sameAngle = (a: number, b: number) => expect(Math.cos(a - b)).toBeCloseTo(1, 6);

    test("all six arrows show in a standard view with hit targets of at least 26 px, and hide in a free view without moving anything", async ({ app }) => {
      const { page } = app;
      await openDemo(app);
      // the start view is the free isometric one
      await expect(page.getByTestId("axis-navigator")).toHaveAttribute("data-aligned", "false");
      for (const id of arrowIds) await expect(page.getByTestId(`nav-${id}`)).toBeHidden();
      await align(page, "+z");
      await expect(page.getByTestId("axis-navigator")).toHaveAttribute("data-aligned", "true");
      for (const id of arrowIds) {
        const button = page.getByTestId(`nav-${id}`);
        await expect(button).toBeVisible();
        const box = await button.boundingBox();
        // 26 px, allowing for the rounding of a fractional display scale
        expect(box!.width, id).toBeGreaterThan(25.9);
        expect(box!.height, id).toBeGreaterThan(25.9);
      }
      const home = await page.getByTestId("nav-home").boundingBox();
      const group = await page.getByTestId("axis-navigator").boundingBox();

      // an orbit drag on the navigator leaves the standard view: the arrows go away, the room stays
      const x = group!.x + group!.width / 2, y = group!.y + group!.height / 2;
      await page.mouse.move(x - 30, y + 30);
      await page.mouse.down();
      await page.mouse.move(x - 10, y + 30, { steps: 4 });
      await page.mouse.move(x + 20, y + 30, { steps: 4 });
      await page.mouse.up();
      await idle(page);
      await expect(page.getByTestId("axis-navigator")).toHaveAttribute("data-aligned", "false");
      for (const id of arrowIds) await expect(page.getByTestId(`nav-${id}`)).toBeHidden();
      expect(await page.getByTestId("axis-navigator").boundingBox()).toEqual(group);
      expect(await page.getByTestId("nav-home").boundingBox()).toEqual(home);

      // aligning again brings them back
      await page.getByTestId("nav-end-+z").locator("circle").last().click();
      await idle(page);
      for (const id of arrowIds) await expect(page.getByTestId(`nav-${id}`)).toBeVisible();
      noErrors(app);
    });

    test("the left arrow turns the top view by 90 degrees about the vertical axis, the right one back; quick clicks add up", async ({ app }) => {
      const { page } = app;
      await openDemo(app);
      await align(page, "+z");
      const start = await getView(page);
      await page.getByTestId("nav-turn-left").click();
      let v = await settled(page);
      expect(v.elevation).toBeCloseTo(HALF_PI, 6); // still the top view
      sameAngle(v.azimuth, start.azimuth - HALF_PI);
      expect(v.distance).toBeCloseTo(start.distance, 6);
      await page.getByTestId("nav-turn-right").click();
      v = await settled(page);
      sameAngle(v.azimuth, start.azimuth);
      // three clicks in a row, without waiting in between: 270 degrees
      for (let i = 0; i < 3; i++) await page.getByTestId("nav-turn-right").click();
      v = await settled(page);
      sameAngle(v.azimuth, start.azimuth + 3 * HALF_PI);
      expect(v.elevation).toBeCloseTo(HALF_PI, 6);
      // in a side view the neighbouring side comes to the front: front, turned left, is the left view
      await align(page, "-y");
      await page.getByTestId("nav-turn-left").click();
      v = await settled(page);
      expect(v.elevation).toBeCloseTo(0, 6);
      sameAngle(v.azimuth, -HALF_PI);
      noErrors(app);
    });

    test("tipping down from the top view goes to the front view, right to the right view, and back up again", async ({ app }) => {
      const { page } = app;
      await openDemo(app);
      await align(page, "+z");
      await page.getByTestId("nav-tip-down").click();
      let v = await settled(page);
      expect(v.elevation).toBeCloseTo(0, 6);
      sameAngle(v.azimuth, 0); // Front / Vorne
      await page.getByTestId("nav-tip-up").click();
      v = await settled(page);
      expect(v.elevation).toBeCloseTo(HALF_PI, 6);
      await page.getByTestId("nav-tip-right").click();
      v = await settled(page);
      expect(v.elevation).toBeCloseTo(0, 6);
      sameAngle(v.azimuth, HALF_PI); // Right
      await page.getByTestId("nav-tip-left").click();
      v = await settled(page);
      sameAngle(v.azimuth, 0);
      noErrors(app);
    });

    test("Shift + arrow turns, Ctrl + Shift + arrow tips", async ({ app }) => {
      const { page } = app;
      await openDemo(app);
      await align(page, "+z");
      const start = await getView(page);
      await page.keyboard.press("Shift+ArrowRight");
      let v = await settled(page);
      sameAngle(v.azimuth, start.azimuth + HALF_PI);
      expect(v.elevation).toBeCloseTo(HALF_PI, 6);
      await page.keyboard.press("Shift+ArrowLeft");
      v = await settled(page);
      sameAngle(v.azimuth, start.azimuth);
      await page.keyboard.press("Control+Shift+ArrowDown");
      v = await settled(page);
      expect(v.elevation).toBeCloseTo(0, 6);
      sameAngle(v.azimuth, 0);
      // without Shift, or in a free view, the keys do nothing
      await page.keyboard.press("ArrowRight");
      expect(await settled(page)).toEqual(v);
      await page.getByTestId("nav-home").click();
      const free = await settled(page);
      await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("Control+Shift+ArrowUp");
      expect(await settled(page)).toEqual(free);
      noErrors(app);
    });

    test("the keys belong to a text field while it has the focus, but not to a checkbox", async ({ app }) => {
      const { page } = app;
      await openDemo(app);
      await align(page, "+z");
      const start = await getView(page);
      await page.evaluate(() => {
        const input = document.createElement("input");
        input.type = "text";
        input.id = "probe-text";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.id = "probe-check";
        document.body.append(input, box);
      });
      await page.locator("#probe-text").focus();
      await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("Control+Shift+ArrowDown");
      expect(await settled(page), "typing in a field: no turn").toEqual(start);
      await page.locator("#probe-check").focus();
      await page.keyboard.press("Shift+ArrowRight");
      const v = await settled(page);
      sameAngle(v.azimuth, start.azimuth + HALF_PI);
      noErrors(app);
    });

    test("tooltips and labels name the target in German and English, and the arrows can be reached with the keyboard", async ({ app }) => {
      const { page } = app;
      for (const lang of ["de", "en"] as const) {
        await openDemo(app, { lang });
        await align(page, "+z");
        const down = page.getByTestId("nav-tip-down");
        await expect(down).toHaveAttribute("aria-label", lang === "de" ? "Nach Vorne kippen. Aktuell: Oben" : "Tip to Front. Currently: Top");
        await expect(page.getByTestId("nav-turn-left")).toHaveAttribute("aria-label", lang === "de" ? "Um 90° nach links drehen. Ansicht bleibt Oben" : "Rotate 90° left. View stays Top");
        await expect(page.getByTestId("nav-turn-right").locator("xpath=ancestor::span[@data-tip][1]")).toHaveAttribute("data-tip", lang === "de" ? "Um 90° nach rechts drehen (Umschalt + →)" : "Rotate 90° right (Shift + →)");
        await expect(down.locator("xpath=ancestor::span[@data-tip][1]")).toHaveAttribute("data-tip", lang === "de" ? "Nach Vorne kippen (Strg + Umschalt + ↓)" : "Tip to Front (Ctrl + Shift + ↓)");
        // keyboard: focus an arrow and press Enter
        await down.focus();
        await expect(down).toBeFocused();
        await page.keyboard.press("Enter");
        const v = await settled(page);
        expect(v.elevation).toBeCloseTo(0, 6);
        // a hidden arrow is out of the tab order
        await page.getByTestId("nav-home").click();
        await idle(page);
        await expect(page.getByTestId("nav-tip-down")).toHaveAttribute("tabindex", "-1");
      }
      noErrors(app);
    });
  });

  test("view initials: discs show O, H, R (T, Bk, R in English), rings show theirs and the view name only under the pointer", async ({ app }) => {
    const { page } = app;
    for (const lang of ["de", "en"] as const) {
      await openDemo(app, { lang });
      const initials = lang === "de" ? { "+z": "O", "+y": "H", "+x": "R" } : { "+z": "T", "+y": "Bk", "+x": "R" };
      for (const [key, letter] of Object.entries(initials)) await expect(page.getByTestId(`nav-end-${key}`)).toHaveText(letter);
      for (const key of ["-z", "-y", "-x"]) await expect(page.getByTestId(`nav-end-${key}`)).toHaveText("");
      await expect(page.getByTestId("nav-tooltip")).toHaveCount(0);

      await page.getByTestId("nav-end--z").locator("circle").last().hover();
      await expect(page.getByTestId("nav-end--z")).toHaveText(lang === "de" ? "U" : "Bm");
      await expect(page.getByTestId("nav-tooltip")).toContainText(lang === "de" ? "Unten" : "Bottom");
      await expect(page.getByTestId("nav-tooltip")).toContainText(lang === "de" ? "Noch einmal klicken: Oben" : "Click again: Top");
      await page.mouse.move(5, 5);
      await expect(page.getByTestId("nav-end--z")).toHaveText("");
    }
    noErrors(app);
  });

  test("the setting X, Y, Z labels the discs X, Y, Z (a prop, no control in the view)", async ({ app }) => {
    const { page } = app;
    await openDemo(app, { labels: "xyz" });
    for (const [key, letter] of [["+x", "X"], ["+y", "Y"], ["+z", "Z"]] as const) await expect(page.getByTestId(`nav-end-${key}`)).toHaveText(letter);
    await expect(page.getByTestId("axis-navigator")).toHaveAttribute("data-labels", "xyz");
  });

  test("the turn is eased in steps; with reduced motion it is instant", async ({ app }) => {
    const { page } = app;
    await openDemo(app);
    // A software renderer manages only a few frames in 240 ms; any count above 2 shows the turn is spread over several frames.
    expect(await demo<number>(page, "countViewEvents", ["+x", true]), "view changes during the transition").toBeGreaterThan(2);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await demo<void>(page, "viewport.alignToAxis", ["+z", false]);
    await idle(page);
    const instant = await demo<number>(page, "countViewEvents", ["+y", true]);
    expect(instant, "one change, no transition").toBe(1);
    expect(Math.abs((await getView(page)).azimuth)).toBeCloseTo(Math.PI, 6);
    noErrors(app);
  });
});

test("fit all shows the whole content, also after the view was moved and zoomed", async ({ app }) => {
  const { page } = app;
  await openDemo(app);
  const corners = () => demo<{ x: number; y: number }[]>(page, "contentCorners");
  const rect = await page.getByTestId("viewport-host").boundingBox();
  if (!rect) throw new Error("no 3D view");
  const extent = (points: { x: number; y: number }[]) => {
    let worst = 0;
    for (const p of points) {
      worst = Math.max(worst, Math.abs(p.x - (rect.x + rect.width / 2)) / (rect.width / 2), Math.abs(p.y - (rect.y + rect.height / 2)) / (rect.height / 2));
    }
    return worst;
  };
  const start = extent(await corners());
  expect(start, "the start view shows everything").toBeLessThan(1);

  await demo<void>(page, "viewport.zoomBy", [0.2]);
  await demo<void>(page, "viewport.panBy", [300, 100]);
  await idle(page);
  expect(extent(await corners()), "after zooming and panning part of the content is outside").toBeGreaterThan(1);

  await page.getByTestId("vp-fit").click();
  await idle(page);
  const fitted = extent(await corners());
  expect(fitted, "all corners inside").toBeLessThan(1);
  expect(fitted, "and fitted, not tiny").toBeGreaterThan(0.7);
  noErrors(app);
});

test.describe("mouse presets", () => {
  test("Shift + middle button orbits, middle button pans, the wheel zooms towards the cursor, the plain left button navigates nothing", async ({ app }) => {
    const { page } = app;
    await openDemo(app);
    const v0 = await getView(page);

    await dragWith(app, "middle", ["Shift"], 100, 40);
    const v1 = await getView(page);
    expect(v1.azimuth).toBeCloseTo(v0.azimuth - 100 * 0.0065, 3);
    expect(v1.elevation).toBeCloseTo(v0.elevation + 40 * 0.0065, 3);
    expect(v1.target).toEqual(v0.target);

    await dragWith(app, "middle", [], 80, -30);
    const v2 = await getView(page);
    expect(v2.azimuth).toBeCloseTo(v1.azimuth, 9);
    expect(v2.target).not.toEqual(v1.target);

    await dragWith(app, "left", [], 90, 50);
    expect(await getView(page)).toEqual(v2);

    await dragWith(app, "left", ["Alt"], -60, 0);
    expect((await getView(page)).azimuth).toBeCloseTo(v2.azimuth + 60 * 0.0065, 3);
    noErrors(app);
  });

  test("the wheel zooms towards the point under the cursor: the surface point stays under the pointer", async ({ app }) => {
    const { page } = app;
    await openDemo(app);
    const face: Ref = { kind: "face", bodyId: "box", faceId: 1 };
    const p = await clientPointOf(page, face);
    if (!p) throw new Error("no point on the top face");
    expect(await isOverCanvas(page, p)).toBe(true);
    const world = await demo<{ point: Vec3; ref: Ref } | null>(page, "viewport.pick", [p.x, p.y]);
    expect(world?.ref).toEqual(face);
    const d0 = (await getView(page)).distance;

    await page.mouse.move(p.x, p.y);
    await page.mouse.wheel(0, -400);
    await idle(page);
    const d1 = (await getView(page)).distance;
    expect(d1).toBeLessThan(d0);
    const after = await demo<{ x: number; y: number }>(page, "viewport.worldToClient", [world?.point]);
    expect(Math.abs(after.x - p.x)).toBeLessThan(1.5);
    expect(Math.abs(after.y - p.y)).toBeLessThan(1.5);

    await page.mouse.wheel(0, 400);
    await idle(page);
    expect((await getView(page)).distance).toBeGreaterThan(d1);
    noErrors(app);
  });

  test("the touchpad preset: two-finger scroll orbits, Shift + scroll pans, a pinch (Ctrl + wheel) zooms", async ({ app }) => {
    const { page } = app;
    await openDemo(app, { preset: "touchpad" });
    const c = await centre(app);
    await page.mouse.move(c.x, c.y);
    const v0 = await getView(page);

    await page.mouse.wheel(40, 30);
    await idle(page);
    const v1 = await getView(page);
    expect(v1.azimuth).not.toBeCloseTo(v0.azimuth, 3);
    expect(v1.distance).toBeCloseTo(v0.distance, 9);

    await page.keyboard.down("Shift");
    await page.mouse.wheel(40, 30);
    await page.keyboard.up("Shift");
    await idle(page);
    const v2 = await getView(page);
    expect(v2.azimuth).toBeCloseTo(v1.azimuth, 9);
    expect(v2.target).not.toEqual(v1.target);

    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -20);
    await page.keyboard.up("Control");
    await idle(page);
    expect((await getView(page)).distance).toBeLessThan(v2.distance);
    noErrors(app);
  });
});

test.describe("picking and highlight", () => {
  const hoverText = (app: AppUnderTest) => app.page.getByTestId("viewport-hover");

  test("hovering a face, an edge and a sketch line names it by its id and highlights it", async ({ app }) => {
    const { page } = app;
    await openDemo(app);
    const empty = await sampleEmptyPoint(app);
    await page.mouse.move(empty.x, empty.y);
    await expect(hoverText(app)).toHaveText("hover: none");
    const rest = await shootHost(page);

    for (const [ref, text, amount] of [
      [{ kind: "face", bodyId: "box", faceId: 1 }, "hover: face:box:1", 5],
      [{ kind: "face", bodyId: "box", faceId: 2 }, "hover: face:box:2", 5],
      [{ kind: "face", bodyId: "cylinder", faceId: 1 }, "hover: face:cylinder:1", 5],
      [{ kind: "edge", bodyId: "box", edgeId: 9 }, "hover: edge:box:9", 12],
      [{ kind: "sketch", sketchId: "kinds", entityId: 3 }, "hover: sketch:kinds:3", 12],
    ] as [Ref, string, number][]) {
      const p = await clientPointOf(page, ref);
      if (!p) throw new Error(`no point for ${text}`);
      expect(await isOverCanvas(page, p), `${text} is not covered by an overlay`).toBe(true);
      await page.mouse.move(p.x, p.y);
      await expect(hoverText(app)).toHaveText(text);
      await idle(page);
      const hovered = await shootHost(page);
      const at = hovered.at(p);
      const a = meanColour(rest.image, at.x, at.y, 2 * hovered.scale), b = meanColour(hovered.image, at.x, at.y, 2 * hovered.scale);
      expect(colourDistance(a, b), `${text}: the highlight changes the pixels there`).toBeGreaterThan(amount);
    }
    await page.mouse.move(empty.x, empty.y);
    await expect(hoverText(app)).toHaveText("hover: none");
    noErrors(app);
  });

  test("a click selects, a click on nothing clears, Shift adds; zoom to selection frames it", async ({ app }) => {
    const { page } = app;
    await openDemo(app);
    const sel = page.getByTestId("viewport-selection");
    const top = await clientPointOf(page, { kind: "face", bodyId: "box", faceId: 1 });
    const side = await clientPointOf(page, { kind: "face", bodyId: "box", faceId: 2 });
    if (!top || !side) throw new Error("no face points");
    const empty = await sampleEmptyPoint(app);
    await page.mouse.move(empty.x, empty.y);
    await idle(page);
    const rest = await shootHost(page);

    await page.mouse.click(top.x, top.y);
    await expect(sel).toHaveText("selection: face:box:1");
    await idle(page);
    const selected = await shootHost(page);
    const atTop = selected.at(top);
    expect(colourDistance(meanColour(rest.image, atTop.x, atTop.y, 3), meanColour(selected.image, atTop.x, atTop.y, 3)), "the selection is drawn over the face").toBeGreaterThan(12);

    await page.keyboard.down("Shift");
    await page.mouse.click(side.x, side.y);
    await page.keyboard.up("Shift");
    await expect(sel).toHaveText("selection: face:box:1, face:box:2");

    await page.mouse.click(empty.x, empty.y);
    await expect(sel).toHaveText("selection: none");

    // Zoom to selection: the selected face fills the view around its centre.
    await page.mouse.click(top.x, top.y);
    await expect(sel).toHaveText("selection: face:box:1");
    const d0 = (await getView(page)).distance;
    await page.getByTestId("vp-zoom-selection").click();
    await idle(page);
    expect((await getView(page)).distance).toBeLessThan(d0);
    const rect = await page.getByTestId("viewport-host").boundingBox();
    const centreNow = await demo<{ x: number; y: number }>(page, "viewport.worldToClient", [[0, 0, 20]]);
    if (!rect) throw new Error("no 3D view");
    expect(Math.abs(centreNow.x - (rect.x + rect.width / 2))).toBeLessThan(2);
    expect(Math.abs(centreNow.y - (rect.y + rect.height / 2))).toBeLessThan(2);
    noErrors(app);
  });

  test("a drag is not a click: the selection stays", async ({ app }) => {
    const { page } = app;
    await openDemo(app);
    const top = await clientPointOf(page, { kind: "face", bodyId: "box", faceId: 1 });
    if (!top) throw new Error("no point");
    await page.mouse.click(top.x, top.y);
    await expect(page.getByTestId("viewport-selection")).toHaveText("selection: face:box:1");
    const empty = await sampleEmptyPoint(app);
    await page.mouse.move(empty.x, empty.y);
    await page.mouse.down();
    await page.mouse.move(empty.x - 40, empty.y - 20, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByTestId("viewport-selection")).toHaveText("selection: face:box:1");
  });

  test("origin planes can be hovered and picked only while they are shown", async ({ app }) => {
    const { page } = app;
    await openDemo(app);
    // The planes are a small marker around the origin (a sixth of the view's shorter side) and content wins over them: with the demo's
    // bodies in the middle there is no free spot, so the scene is emptied first (what content does to them is tested further down).
    await demo<void>(page, "viewport.setBodies", [[]]);
    await demo<void>(page, "viewport.setSketches", [[]]);
    await page.getByTestId("vp-planes").click();
    await idle(page);

    // A point on each plane that is on the canvas and where that plane is the nearest thing under the pointer.
    const find = async (plane: "xy" | "xz" | "yz") => {
      for (const u of [-12, -6, -3, 3, 6, 12]) {
        for (const v of [-12, -6, -3, 3, 6, 12]) {
          const p = await demo<{ x: number; y: number } | null>(page, "planePoint", [plane, u, v]);
          if (!p || !(await isOverCanvas(page, p))) continue;
          const hit = await demo<{ ref: Ref } | null>(page, "viewport.pick", [p.x, p.y]);
          if (hit?.ref.kind === "plane" && hit.ref.plane === plane) return { p, u, v };
        }
      }
      throw new Error(`no free point found on plane ${plane}`);
    };
    const found = { xy: await find("xy"), xz: await find("xz"), yz: await find("yz") };

    for (const plane of ["xy", "xz", "yz"] as const) {
      await page.mouse.move(found[plane].p.x, found[plane].p.y);
      await expect(hoverText(app)).toHaveText(`hover: plane:${plane}`);
    }
    await page.mouse.click(found.yz.p.x, found.yz.p.y);
    await expect(page.getByTestId("viewport-selection")).toHaveText("selection: plane:yz");

    // The point where the ray of the pointer meets the XY plane, for sketching.
    const onPlane = await demo<{ u: number; v: number; point: Vec3 } | null>(page, "viewport.pointOnPlane", [found.xy.p.x, found.xy.p.y, "xy"]);
    expect(onPlane?.u).toBeCloseTo(found.xy.u, 1);
    expect(onPlane?.v).toBeCloseTo(found.xy.v, 1);
    expect(onPlane?.point[2]).toBeCloseTo(0, 6);

    // Hidden planes can no longer be hovered, and drop out of the selection.
    await page.getByTestId("vp-planes").click();
    await idle(page);
    expect(await demo<unknown[]>(page, "viewport.getSelection")).toHaveLength(0);
    await page.mouse.move(found.xy.p.x + 1, found.xy.p.y + 1);
    await page.mouse.move(found.xy.p.x, found.xy.p.y);
    await idle(page);
    await expect(hoverText(app)).toHaveText("hover: none");
    noErrors(app);
  });
});

test.describe("lines", () => {
  const topOfRows: View = { target: [0, -72, 0], azimuth: 0, elevation: HALF_PI, distance: 110 };
  // Row i of the sample sketch has the line kind demoLineKinds[i]; rows 1 (sketchFull), 2 (sketchOver), 3 (construction) and
  // 7 (projected) are used here.
  const row = (i: number): Ref => ({ kind: "sketch", sketchId: "kinds", entityId: i });

  for (const renderer of ["auto", "webgl2"] as const) {
    test(`lines have pixel widths and dash patterns in pixels (${renderer === "auto" ? "default backend" : "WebGL2"})`, async ({ app }) => {
      const { page } = app;
      await openDemo(app, { renderer });
      await page.getByTestId("vp-grid").click(); // the grid would show through the gaps of a dashed line
      // The Z axis runs from the origin to the top edge of this top view and crosses the middle of every sample line.
      await demo<void>(page, "viewport.setOriginVisible", [false]);
      await page.getByTestId("vp-preview").click();
      await setView(page, topOfRows);
      const shot = await shootHost(page);
      const s = shot.scale;

      // How much of a pixel is covered by a line of the given colour: 0 = background, 1 = full line colour.
      const bg = dominantColour(shot.image);
      const coverageOf = (rgb: readonly [number, number, number], line: readonly [number, number, number]): number => {
        let best = 0, channel = 0;
        for (let c = 0; c < 3; c++) if (Math.abs(bg[c]! - line[c]!) > best) { best = Math.abs(bg[c]! - line[c]!); channel = c; }
        return Math.min(1, Math.max(0, (bg[channel]! - rgb[channel]!) / (bg[channel]! - line[channel]!)));
      };
      /** Width of the line in CSS pixels: the coverage added up across it. */
      const widthAt = (at: { x: number; y: number }, token: string): number => {
        const line = hexToRgb(token);
        let sum = 0;
        for (let dy = -8 * s; dy <= 8 * s; dy++) sum += coverageOf(pixelAt(shot.image, at.x, at.y + dy), line);
        return sum / s;
      };

      const full = await clientPointOf(page, row(1));
      const over = await clientPointOf(page, row(2));
      const dashed = await clientPointOf(page, row(3));
      if (!full || !over || !dashed) throw new Error("no sketch row");
      const f = shot.at(full), o = shot.at(over), d = shot.at(dashed);
      const widthFull = widthAt(f, light.sketchFull), widthOver = widthAt(o, light.sketchOver);
      test.info().annotations.push({ type: `measured line widths (${renderer})`, description: `sketchFull ${widthFull.toFixed(2)} px (token 1.6), sketchOver ${widthOver.toFixed(2)} px (token 2.2)` });
      // MSAA with four samples quantises the coverage, so the measured width is within about +-0.75 px of the token value
      // (a hardware GPU measures 1.79 px for 1.8, the old sketchFull weight; a software rasteriser can be further off).
      expect(widthFull, "sketchFull is about 1.6 px wide (the same weight as under-constrained)").toBeGreaterThan(1.05);
      expect(widthFull).toBeLessThan(2.55);
      expect(widthOver, "sketchOver is about 2.2 px wide").toBeGreaterThan(1.45);
      expect(widthOver).toBeLessThan(2.95);

      // Along a solid line there is no gap.
      const fullLine = hexToRgb(light.sketchFull);
      let gaps = 0;
      for (let dx = -80 * s; dx <= 80 * s; dx++) {
        let any = 0;
        for (let dy = -2 * s; dy <= 2 * s; dy++) any = Math.max(any, coverageOf(pixelAt(shot.image, f.x + dx, f.y + dy), fullLine));
        if (any < 0.2) gaps++;
      }
      expect(gaps, "a solid line has no gaps").toBe(0);

      // A dashed line (construction, "8 5"): dashes about 8 px long and gaps about 5 px, whatever the zoom.
      const dashLine = hexToRgb(light.construction);
      const scan = (image: typeof shot.image, at: { x: number; y: number }): boolean[] => {
        const out: boolean[] = [];
        for (let dx = -100 * s; dx <= 100 * s; dx++) {
          let on = 0;
          for (let dy = -2 * s; dy <= 2 * s; dy++) on = Math.max(on, coverageOf(pixelAt(image, at.x + dx, at.y + dy), dashLine));
          out.push(on > 0.25);
        }
        return out;
      };
      const changes = (runs: boolean[]) => runs.slice(1).filter((on, i) => on !== runs[i]).length;
      /** Lengths of the line runs, without the first (cut by the window). */
      const dashRuns = (runs: boolean[]): number[] => {
        const lengths: number[] = [];
        let run = 0;
        for (const on of runs) {
          if (on) run++;
          else if (run > 0) { lengths.push(run); run = 0; }
        }
        return lengths.slice(1);
      };
      const runs = scan(shot.image, d);
      const transitions = changes(runs);
      // 200 px of a 13 px period are about 15 periods, so about 30 changes between line and gap.
      expect(transitions, "a dashed line has many gaps").toBeGreaterThanOrEqual(24);
      expect(transitions).toBeLessThanOrEqual(36);
      const lengths = dashRuns(runs);
      const mean = lengths.reduce((x, y) => x + y, 0) / Math.max(1, lengths.length) / s;
      test.info().annotations.push({ type: `mean dash length (${renderer})`, description: `${mean.toFixed(1)} px (pattern: 8 px dash, 5 px gap; anti-aliased edges widen it a little)` });
      expect(mean).toBeGreaterThan(6.5);
      expect(mean).toBeLessThan(10.5);

      // The pattern is in screen pixels: after zooming in, the dashes keep their length on the screen.
      await setView(page, { ...topOfRows, distance: 55 });
      const zoomed = await shootHost(page);
      const dashedZoomed = await clientPointOf(page, row(3));
      if (!dashedZoomed) throw new Error("no sketch row");
      const z = zoomed.at(dashedZoomed);
      const zoomTransitions = changes(scan(zoomed.image, z));
      expect(Math.abs(zoomTransitions - transitions), "same number of dashes at another zoom").toBeLessThanOrEqual(6);
      noErrors(app);
    });
  }
});

test("hidden edges show only behind solids, when switched on", async ({ app }) => {
  const { page } = app;
  await openDemo(app);
  // Look at the box from the front: its back edges are behind its front face.
  await setView(page, { target: [0, 0, 10], azimuth: 0.0, elevation: 0.35, distance: 190 });
  const before = await shootHost(page);
  await page.getByTestId("vp-hidden").click();
  await idle(page);
  const after = await shootHost(page);
  const p = await demo<{ x: number; y: number }>(page, "viewport.worldToClient", [[0, 25, 0]]);
  const at = after.at(p);
  // The back-bottom edge of the box is behind its front face: switching hidden edges on draws a dashed line along it.
  let changed = 0;
  for (let dx = -60 * after.scale; dx <= 60 * after.scale; dx++) {
    for (let dy = -3 * after.scale; dy <= 3 * after.scale; dy++) {
      if (colourDistance(pixelAt(before.image, at.x + dx, at.y + dy), pixelAt(after.image, at.x + dx, at.y + dy)) > 25) changed++;
    }
  }
  expect(changed, "pixels along the hidden edge changed").toBeGreaterThan(30);
  noErrors(app);
});

test("rendering is on demand: nothing is drawn while nothing changes", async ({ app }) => {
  const { page } = app;
  await openDemo(app);
  await idle(page);
  const n0 = await renderCount(page);
  await page.waitForTimeout(700);
  expect(await renderCount(page), "no frames while idle").toBe(n0);
  const c = await centre(app);
  const e = await sampleEmptyPoint(app);
  await page.mouse.move(c.x, c.y);
  await page.mouse.move(e.x, e.y);
  // Let the last pointer events and their frames through before counting.
  await page.waitForTimeout(250);
  await idle(page);
  await page.waitForTimeout(250);
  await idle(page);
  const n1 = await renderCount(page);
  await page.waitForTimeout(500);
  expect(await renderCount(page)).toBe(n1);
  noErrors(app);
});

// --- the ground grid ---------------------------------------------------------------------------------------------------------

test.describe("ground grid", () => {
  type Shot = Awaited<ReturnType<typeof shootHost>>;
  /** A rectangle of the shot given as fractions of its width and height. */
  const area = (shot: Shot, x0: number, y0: number, x1: number, y1: number) => ({ x0: x0 * shot.image.width, y0: y0 * shot.image.height, x1: x1 * shot.image.width, y1: y1 * shot.image.height });
  /** Share of the pixels of a rectangle that are not the view's flat colour. */
  const inked = (shot: Shot, rect: ReturnType<typeof area>, background: Rgb, tolerance = 6): number =>
    countDifferentIn(shot.image, rect, background, tolerance) / Math.max(1, (rect.x1 - rect.x0) * (rect.y1 - rect.y0));

  // Places of the default view that the grid used to leave bare: the top corners (the far half of the plane), the right edge and the
  // far middle. The bottom left and top right hold the info box and the axis navigator.
  const places: [string, number, number, number, number][] = [
    ["top left corner", 0, 0, 0.16, 0.1],
    ["top middle", 0.3, 0, 0.5, 0.06],
    ["top right, left of the navigator", 0.7, 0, 0.88, 0.08],
    ["right edge", 0.9, 0.3, 1, 0.6],
    ["bottom right corner", 0.84, 0.9, 1, 1],
    ["left edge", 0, 0.3, 0.08, 0.6],
  ];

  for (const mode of ["light", "dark"] as const satisfies readonly Mode[]) {
    test(`covers the whole ground plane of the default view, not a patch around the middle (${mode})`, async ({ app }) => {
      const { page } = app;
      await openDemo(app, { panel: false, mode });
      const shot = await shootHost(page);
      const background = hexToRgb(getTheme("praezision").tokens[mode].viewport);
      for (const [name, x0, y0, x1, y1] of places) {
        const share = inked(shot, area(shot, x0, y0, x1, y1), background);
        test.info().annotations.push({ type: `grid ink ${mode}: ${name}`, description: `${(share * 100).toFixed(2)} %` });
        expect(share, `the grid is drawn at the ${name}`).toBeGreaterThan(0.004);
      }
      noErrors(app);
    });
  }

  test("every colour theme draws the grid over the whole view, in light and dark", async ({ app }) => {
    test.setTimeout(180_000);
    const { page } = app;
    for (const theme of themeKeys) {
      for (const mode of ["light", "dark"] as const) {
        await openDemo(app, { panel: false, theme, mode });
        const shot = await shootHost(page);
        const background = hexToRgb(getTheme(theme).tokens[mode].viewport);
        for (const [name, x0, y0, x1, y1] of places) {
          expect(inked(shot, area(shot, x0, y0, x1, y1), background, 5), `${theme} ${mode}: grid at the ${name}`).toBeGreaterThan(0.003);
        }
      }
    }
    noErrors(app);
  });

  test("at a grazing angle it runs out to the horizon and nothing shows above it: no edge, no strip", async ({ app }) => {
    const { page } = app;
    await openDemo(app, { panel: false });
    const elevation = 0.06;
    await setView(page, { target: [0, 0, 0], azimuth: 0.7, elevation, distance: 300 });
    const shot = await shootHost(page);
    const background = hexToRgb(light.viewport);
    // The horizon is the height at which the plane's far end is seen: elevation above the middle of the view.
    const horizon = 0.5 - 0.5 * (Math.tan(elevation) / Math.tan(DEFAULT_FOV_Y / 2));
    const sky = area(shot, 0.02, 0.04, 0.3, horizon - 0.03);
    expect(countDifferentIn(shot.image, sky, background, 3), "nothing above the horizon").toBe(0);
    expect(inked(shot, area(shot, 0.02, horizon + 0.01, 0.3, horizon + 0.14), background, 4), "the grid reaches up to the horizon").toBeGreaterThan(0.004);
    noErrors(app);
  });

  // The axes no longer run across the whole view; they
  // fade out with the distance from the origin (the fade itself is tested in "origin axes").
  test("seen from above, X (red) and Y (green) are drawn near the origin and have faded out before the edges of the view; Z the same from the front", async ({ app }) => {
    const { page } = app;
    await openDemo(app, { panel: false });
    await demo<void>(page, "viewport.setBodies", [[]]);
    await demo<void>(page, "viewport.setSketches", [[]]);
    /** What the axes add to the picture around a point: the biggest colour difference to the same view without the origin axes. */
    const axisInkAt = async (view: View, p: (shot: Shot) => { x: number; y: number }): Promise<number> => {
      await setView(page, view);
      await demo<void>(page, "viewport.setOriginVisible", [true]);
      await idle(page);
      const withAxes = await shootHost(page);
      await demo<void>(page, "viewport.setOriginVisible", [false]);
      await idle(page);
      const without = await shootHost(page);
      await demo<void>(page, "viewport.setOriginVisible", [true]);
      const at = p(withAxes);
      let best = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) best = Math.max(best, colourDistance(pixelAt(withAxes.image, at.x + dx, at.y + dy), pixelAt(without.image, at.x + dx, at.y + dy)));
      return best;
    };
    const top: View = { target: [0, 0, 0], azimuth: 0, elevation: HALF_PI, distance: 300 };
    const front: View = { target: [0, 0, 0], azimuth: 0, elevation: 0, distance: 300 };
    const near = (offX: number, offY: number) => (shot: Shot) => ({ x: shot.image.width / 2 + offX * shot.scale, y: shot.image.height / 2 + offY * shot.scale });
    const xNear = await axisInkAt(top, near(30, 0)), yNear = await axisInkAt(top, near(0, -30)), zNear = await axisInkAt(front, near(0, -30));
    expect(xNear, "X axis near the origin").toBeGreaterThan(6);
    expect(yNear, "Y axis near the origin").toBeGreaterThan(6);
    expect(zNear, "Z axis near the origin").toBeGreaterThan(6);
    // At the edges of the view (95 mm and more from the origin at this zoom, the fade ends at 120 mm) what is left is a fraction of it.
    const edge = [
      await axisInkAt(top, (shot) => ({ x: 6 * shot.scale, y: shot.image.height / 2 })),
      await axisInkAt(top, (shot) => ({ x: shot.image.width - 6 * shot.scale, y: shot.image.height / 2 })),
      await axisInkAt(top, (shot) => ({ x: shot.image.width / 2, y: 6 * shot.scale })),
      await axisInkAt(top, (shot) => ({ x: shot.image.width / 2, y: shot.image.height - 6 * shot.scale })),
      await axisInkAt(front, (shot) => ({ x: shot.image.width / 2, y: 6 * shot.scale })),
      await axisInkAt(front, (shot) => ({ x: shot.image.width / 2, y: shot.image.height - 6 * shot.scale })),
    ];
    test.info().annotations.push({ type: "axis ink near / at the edges", description: "X " + xNear + ", Y " + yNear + ", Z " + zNear + "; edges " + edge.join(", ") });
    for (const ink of edge) expect(ink, "at the edge of the view").toBeLessThan(Math.min(xNear, yNear, zNear) * 0.7);
    // Far out, with the whole scene a speck, the axes are gone altogether.
    expect(await axisInkAt({ ...top, distance: 20000 }, (shot) => ({ x: 6 * shot.scale, y: shot.image.height / 2 })), "X axis at the left edge, far out").toBeLessThanOrEqual(2);
    noErrors(app);
  });

  test("bodies hide the grid behind them, and the grid is drawn elsewhere", async ({ app }) => {
    const { page } = app;
    await openDemo(app, { panel: false });
    const top = await clientPointOf(page, { kind: "face", bodyId: "box", faceId: 1 });
    if (!top) throw new Error("no point on the top face");
    // The axes go with the grid now; they are put away in both pictures so that only the grid is compared.
    await demo<void>(page, "viewport.setOriginVisible", [false]);
    await idle(page);
    const withGrid = await shootHost(page);
    await demo<void>(page, "viewport.setGridVisible", [false]);
    await idle(page);
    const without = await shootHost(page);
    const c = withGrid.at(top);
    // Where the box is in front of the plane the picture is the same with and without the grid.
    let differing = 0;
    for (let y = Math.floor(c.y - 25); y < c.y + 25; y++) {
      for (let x = Math.floor(c.x - 40); x < c.x + 40; x++) if (colourDistance(pixelAt(withGrid.image, x, y), pixelAt(without.image, x, y)) > 2) differing++;
    }
    expect(differing, "grid pixels on the top face of the box").toBe(0);
    // Elsewhere the grid is drawn: with it the area is inked, without it it is empty.
    expect(countDifferentIn(withGrid.image, area(withGrid, 0, 0.3, 0.2, 0.6), hexToRgb(light.viewport), 6)).toBeGreaterThan(200);
    expect(countDifferentIn(without.image, area(without, 0, 0.3, 0.2, 0.6), hexToRgb(light.viewport), 6), "without the grid the same area is empty").toBeLessThan(40);
    noErrors(app);
  });

  test("zooming in subdivides the cells without a switch: the amount of grid ink changes smoothly in small zoom steps", async ({ app }) => {
    test.setTimeout(180_000);
    const { page } = app;
    await openDemo(app, { panel: false });
    // Nothing but the grid and the axes: the scene would move in and out of the measured strips while zooming.
    await demo<void>(page, "viewport.setBodies", [[]]);
    await demo<void>(page, "viewport.setSketches", [[]]);
    await demo<void>(page, "viewport.setPreview", [null]);
    const background = hexToRgb(light.viewport);
    /** Total deviation from the view colour in two side strips that hold nothing but the grid. */
    const ink = (shot: Shot): number => {
      let sum = 0;
      for (const r of [area(shot, 0, 0, 0.25, 0.85), area(shot, 0.8, 0.15, 1, 1)]) {
        for (let y = Math.floor(r.y0); y < r.y1; y++) {
          for (let x = Math.floor(r.x0); x < r.x1; x++) {
            const p = pixelAt(shot.image, x, y);
            sum += Math.abs(p[0] - background[0]) + Math.abs(p[1] - background[1]) + Math.abs(p[2] - background[2]);
          }
        }
      }
      return sum;
    };
    // From 450 mm to 40 mm in steps of 2.5 %: the grid passes several former switching points of the line spacing.
    let previous = 0;
    let worst = 0;
    let at = 0;
    for (let distance = 450; distance > 40; distance *= 0.975) {
      await setView(page, { target: [0, 0, 0], azimuth: 0.7, elevation: 0.7, distance });
      const now = ink(await shootHost(page));
      if (previous > 0) {
        const change = Math.abs(now - previous) / previous;
        if (change > worst) { worst = change; at = distance; }
      }
      previous = now;
    }
    test.info().annotations.push({ type: "largest ink change in one zoom step", description: `${(worst * 100).toFixed(1)} % at distance ${at.toFixed(0)}` });
    expect(worst, "no step in the amount of grid between two zoom steps").toBeLessThan(0.06);
    noErrors(app);
  });

  test("the grid in the sketch plane covers the whole view too", async ({ app }) => {
    const { page } = app;
    await openSketchDemo(app, { plane: "xy" });
    const shot = await shootHost(page);
    const background = hexToRgb(light.viewport);
    for (const [name, x0, y0, x1, y1] of [["top left", 0, 0, 0.14, 0.1], ["top middle", 0.3, 0, 0.5, 0.06], ["right edge", 0.9, 0.3, 1, 0.6], ["bottom right", 0.84, 0.9, 1, 1], ["left edge", 0, 0.3, 0.08, 0.6]] as const) {
      expect(inked(shot, area(shot, x0, y0, x1, y1), background), `sketch grid at the ${name}`).toBeGreaterThan(0.004);
    }
    noErrors(app);
  });
});

// --- wheel zoom ---------------------------------------------------------------------------------------------------------------

test.describe("wheel zoom", () => {
  interface WheelRun {
    /** The view distance after every "view" event of the run. */
    distances: number[];
    start: number;
  }
  /** Sends wheel notches (deltaY = 100 * direction) to the canvas `gapMs` apart, records the distance at every view event, waits until idle. */
  const wheelRun = (page: Page, deltas: number[], gapMs: number, options: { reduced?: boolean; ctrl?: boolean } = {}): Promise<WheelRun> =>
    page.evaluate(
      async ([notches, gap, opts]) => {
        const d = (window as unknown as { __viewportDemo: { viewport: { canvas: HTMLCanvasElement; getView(): { distance: number }; on(e: "view", l: (v: { distance: number }) => void): () => void; whenIdle(): Promise<void>; setReducedMotion(m: boolean | "auto"): void } } }).__viewportDemo;
        const vp = d.viewport;
        vp.setReducedMotion(opts.reduced === true);
        await vp.whenIdle();
        const rect = vp.canvas.getBoundingClientRect();
        const distances: number[] = [];
        const off = vp.on("view", (v) => { distances.push(v.distance); });
        const start = vp.getView().distance;
        for (const deltaY of notches) {
          vp.canvas.dispatchEvent(new WheelEvent("wheel", { deltaY, deltaMode: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height * 0.62, ctrlKey: opts.ctrl === true, bubbles: true, cancelable: true }));
          await new Promise<void>((resolve) => setTimeout(resolve, gap));
        }
        await vp.whenIdle();
        off();
        vp.setReducedMotion("auto");
        return { distances, start };
      },
      [deltas, gapMs, options] as const,
    );

  test("a mouse-wheel notch is eased in over several frames and ends where one jump would", async ({ app }) => {
    const { page } = app;
    await openDemo(app, { panel: false });
    const run = await wheelRun(page, [100], 0);
    const total = run.start * Math.exp(100 * 0.0015);
    expect(run.distances.length, "the notch took several frames").toBeGreaterThanOrEqual(3);
    expect(run.distances[run.distances.length - 1]).toBeCloseTo(total, 6);
    // Every frame moves further the same way and none takes the bigger part of the way at once.
    let previous = run.start;
    for (const distance of run.distances) {
      expect(distance).toBeGreaterThan(previous - 1e-9);
      expect((distance - previous) / (total - run.start), "share of the whole notch in one frame").toBeLessThan(0.8);
      previous = distance;
    }
    noErrors(app);
  });

  test("notches in quick succession add up", async ({ app }) => {
    const { page } = app;
    await openDemo(app, { panel: false });
    const run = await wheelRun(page, [100, 100, 100], 20);
    expect(run.distances[run.distances.length - 1]).toBeCloseTo(run.start * Math.exp(3 * 100 * 0.0015), 6);
    const back = await wheelRun(page, [-100, -100, -100], 20);
    expect(back.distances[back.distances.length - 1]).toBeCloseTo(back.start * Math.exp(-3 * 100 * 0.0015), 6);
    noErrors(app);
  });

  test("with reduced motion a notch is applied at once, and a pinch (Ctrl + wheel) always is", async ({ app }) => {
    const { page } = app;
    await openDemo(app, { panel: false });
    const reduced = await wheelRun(page, [100], 0, { reduced: true });
    expect(reduced.distances, "one view event, no easing").toHaveLength(1);
    expect(reduced.distances[0]).toBeCloseTo(reduced.start * Math.exp(100 * 0.0015), 6);
    const pinch = await wheelRun(page, [-20], 0, { ctrl: true });
    expect(pinch.distances, "a pinch step is direct").toHaveLength(1);
    expect(pinch.distances[0]).toBeLessThan(pinch.start);
    noErrors(app);
  });

  test("zooming towards the cursor stays: the surface point under the pointer does not move while the notch eases", async ({ app }) => {
    const { page } = app;
    await openDemo(app, { panel: false });
    const face: Ref = { kind: "face", bodyId: "box", faceId: 1 };
    const p = await clientPointOf(page, face);
    if (!p) throw new Error("no point on the top face");
    const world = await demo<{ point: Vec3; ref: Ref } | null>(page, "viewport.pick", [p.x, p.y]);
    expect(world?.ref).toEqual(face);
    await page.mouse.move(p.x, p.y);
    await page.mouse.wheel(0, -400);
    // In the middle of the easing the point is already on its way: it stays under the pointer in every frame.
    await page.waitForTimeout(40);
    const during = await demo<{ x: number; y: number }>(page, "viewport.worldToClient", [world?.point]);
    expect(Math.abs(during.x - p.x)).toBeLessThan(1.5);
    expect(Math.abs(during.y - p.y)).toBeLessThan(1.5);
    await idle(page);
    const after = await demo<{ x: number; y: number }>(page, "viewport.worldToClient", [world?.point]);
    expect(Math.abs(after.x - p.x)).toBeLessThan(1.5);
    expect(Math.abs(after.y - p.y)).toBeLessThan(1.5);
    noErrors(app);
  });
});

test("frame time while orbiting is measured and reported", async ({ app }) => {
  const { page } = app;
  await openDemo(app);
  // Warm up: the first frames compile pipelines.
  await demo<Measurement>(page, "measureOrbit", [30, 3]);
  const m = await demo<Measurement>(page, "measureOrbit", [240, 3]);
  const backend = await backendOf(page);
  const info = await page.getByTestId("viewport-backend").textContent();
  test.info().annotations.push({
    type: `orbit frame time (${backend})`,
    description: `${m.frames} frames: mean ${m.meanMs.toFixed(2)} ms, p95 ${m.p95Ms.toFixed(2)} ms, max ${m.maxMs.toFixed(2)} ms, CPU per render ${m.meanCpuMs.toFixed(2)} ms; ${info ?? ""}`,
  });
  expect(m.frames).toBeGreaterThan(200);
  // Only a sanity bound: no frame may hang the page. The real budget (16.6 ms at 60 Hz) is read from the annotation.
  expect(m.maxMs).toBeLessThan(5000);
  noErrors(app);
});

test("frame time while zooming with the mouse wheel is measured and reported", async ({ app }) => {
  const { page } = app;
  await openDemo(app);
  // Warm up: the first frames compile pipelines.
  await demo<WheelMeasurement>(page, "measureWheel", [6, 60, -1]);
  await demo<WheelMeasurement>(page, "measureWheel", [6, 60, 1]);
  const backend = await backendOf(page);
  for (const [label, interval] of [["fast flick, one notch every 40 ms", 40], ["steady scroll, one notch every 100 ms", 100]] as const) {
    // 24 notches out and 24 in: the distance changes by a factor of about 50 each way, so the grid spacing changes many times.
    const out = await demo<WheelMeasurement>(page, "measureWheel", [24, interval, 1]);
    const back = await demo<WheelMeasurement>(page, "measureWheel", [24, interval, -1]);
    for (const [way, m] of [["out", out], ["in", back]] as const) {
      test.info().annotations.push({
        type: `wheel zoom ${way}, ${label} (${backend})`,
        description:
          `${m.rafFrames} frames: rAF mean ${m.rafMeanMs.toFixed(2)} ms, p95 ${m.rafP95Ms.toFixed(2)} ms, max ${m.rafMaxMs.toFixed(2)} ms, over 25 ms: ${m.rafOver25}; ` +
          `${m.drawnFrames} drawn, CPU per draw mean ${m.cpuMeanMs.toFixed(2)} ms, max ${m.cpuMaxMs.toFixed(2)} ms; distance ${m.distanceBefore.toFixed(1)} -> ${m.distanceAfter.toFixed(1)}`,
      });
    }
    expect(out.distanceAfter, "the wheel moved the view out").toBeGreaterThan(out.distanceBefore);
    expect(back.distanceAfter, "and in again").toBeLessThan(back.distanceBefore);
    // Only a sanity bound: no frame may hang the page. The real budget (16.6 ms at 60 Hz) is read from the annotations.
    expect(Math.max(out.rafMaxMs, back.rafMaxMs)).toBeLessThan(5000);
  }
  noErrors(app);
});

test("creating and disposing viewports leaves nothing behind", async ({ app }) => {
  const { page } = app;
  await openDemo(app);
  const r = await demo<{ canvasesBefore: number; canvasesAfter: number; backend: string }>(page, "cycle", [4]);
  expect(r.canvasesAfter).toBe(r.canvasesBefore);
  // The demo's own view still works after the others came and went.
  await page.getByTestId("vp-fit").click();
  await idle(page);
  const shot = await shootHost(page);
  expect(countDifferent(shot.image, hexToRgb(light.viewport), 12)).toBeGreaterThan(3000);
  noErrors(app);
});

// --- the sketch layer (U2a) -------------------------------------------------------------------------------------------------

test.describe("sketch layer", () => {
  type Point = { x: number; y: number };
  type Shot = Awaited<ReturnType<typeof shootHost>>;
  const layerCall = <T>(page: Page, path: string, args: unknown[] = []): Promise<T> => demo<T>(page, `sketchLayer.${path}`, args);

  /** How much of a pixel is covered by a line of the given colour over the background: 0 = background, 1 = line colour. */
  const coverageOf = (bg: Rgb, rgb: Rgb, line: Rgb): number => {
    let best = 0, channel = 0;
    for (let c = 0; c < 3; c++) if (Math.abs(bg[c]! - line[c]!) > best) { best = Math.abs(bg[c]! - line[c]!); channel = c; }
    return Math.min(1, Math.max(0, (bg[channel]! - rgb[channel]!) / (bg[channel]! - line[channel]!)));
  };

  /** Width in CSS pixels of a horizontal line at a client point: the coverage added up over a vertical scan. */
  const lineWidth = (shot: Shot, at: Point, token: string): number => {
    const bg = dominantColour(shot.image), line = hexToRgb(token);
    const a = shot.at(at);
    let sum = 0;
    for (let dy = -8 * shot.scale; dy <= 8 * shot.scale; dy++) sum += coverageOf(bg, pixelAt(shot.image, a.x, a.y + dy), line);
    return sum / shot.scale;
  };

  /** The distance of the nearest pixel colour around a client point (a few pixels each way) to a token colour. */
  const nearestToToken = (shot: Shot, at: Point, token: string, reach = 2): number => {
    const a = shot.at(at), line = hexToRgb(token);
    let best = Infinity;
    for (let dy = -reach * shot.scale; dy <= reach * shot.scale; dy++) for (let dx = -reach * shot.scale; dx <= reach * shot.scale; dx++) best = Math.min(best, colourDistance(pixelAt(shot.image, a.x + dx, a.y + dy), line));
    return best;
  };

  /**
   * How well the colour of a horizontal line at a client point matches a token: the cosine between (what the line added to the
   * view's colour) and (token - view), summed over a vertical scan. 1 = the line has exactly the token's hue; unlike the nearest
   * pixel it does not depend on where the line falls between two pixel rows.
   */
  const lineHue = (shot: Shot, at: Point, token: string): number => {
    const bg = dominantColour(shot.image), line = hexToRgb(token), a = shot.at(at);
    const sum = [0, 0, 0];
    for (let dy = -4 * shot.scale; dy <= 4 * shot.scale; dy++) {
      const p = pixelAt(shot.image, a.x, a.y + dy);
      for (let c = 0; c < 3; c++) sum[c] = sum[c]! + (p[c]! - bg[c]!);
    }
    const want = [0, 1, 2].map((c) => line[c]! - bg[c]!);
    const dot = sum.reduce((acc, v, c) => acc + v * want[c]!, 0);
    return dot / (Math.hypot(...sum) * Math.hypot(...want) || 1);
  };

  /** The most a token colour covers any pixel in a vertical scan around a client point (0 = none, 1 = a pixel of exactly that colour). */
  const peakCoverage = (shot: Shot, at: Point, token: string, reach = 3): number => {
    const bg = dominantColour(shot.image), line = hexToRgb(token), a = shot.at(at);
    let best = 0;
    for (let dy = -reach * shot.scale; dy <= reach * shot.scale; dy++) best = Math.max(best, coverageOf(bg, pixelAt(shot.image, a.x, a.y + dy), line));
    return best;
  };

  /** The mean colour right at a client point. */
  const colourAt = (shot: Shot, at: Point): Rgb => {
    const a = shot.at(at);
    return meanColour(shot.image, a.x, a.y, 1);
  };

  /** Hides the demo's overlays and the grid, so a pixel is either the view's colour or the sketch's. */
  async function bare(app: AppUnderTest, hide: ("sk-dims" | "sk-cons" | "sk-preview")[] = ["sk-dims", "sk-cons", "sk-preview"]): Promise<void> {
    const { page } = app;
    await demo<void>(page, "viewport.setGridVisible", [false]);
    for (const id of hide) await page.getByTestId(id).dispatchEvent("click");
    await page.mouse.move(2, 2);
    await idle(page);
  }

  for (const [modeName, tokens] of [["light", light], ["dark", dark]] as const) {
    test(`curves and points are drawn by solver state in the theme colours, fully constrained as heavy as under-constrained (${modeName})`, async ({ app }) => {
      const { page } = app;
      await openSketchDemo(app, { scene: "states", mode: modeName });
      await bare(app);
      const shot = await shootHost(page);
      const row = (v: number) => sketchPoint(page, 40, v);
      const [under, full, over, construction] = [await row(10), await row(22), await row(34), await row(46)];

      expect(lineHue(shot, under, tokens.sketchUnder), "under-constrained line is sketchUnder").toBeGreaterThan(0.97);
      expect(lineHue(shot, full, tokens.sketchFull), "fully constrained line is sketchFull (green)").toBeGreaterThan(0.97);
      expect(lineHue(shot, over, tokens.sketchOver), "over-constrained line is sketchOver").toBeGreaterThan(0.97);

      const wUnder = lineWidth(shot, under, tokens.sketchUnder), wFull = lineWidth(shot, full, tokens.sketchFull), wOver = lineWidth(shot, over, tokens.sketchOver);
      test.info().annotations.push({ type: `measured widths (${modeName})`, description: `under ${wUnder.toFixed(2)} px, full ${wFull.toFixed(2)} px, over ${wOver.toFixed(2)} px (tokens 1.6, 1.6, 2.2)` });
      expect(Math.abs(wFull - wUnder), "fully constrained lines are as heavy as under-constrained ones").toBeLessThan(0.45);
      expect(wUnder).toBeGreaterThan(1.0);
      expect(wUnder).toBeLessThan(2.6);
      expect(wOver, "over-constrained is the heavier token").toBeGreaterThan(wFull);

      // The construction line is dashed: many changes between line and gap along it.
      const a = shot.at(construction), line = hexToRgb(tokens.construction), bg = dominantColour(shot.image);
      let transitions = 0, last = false;
      for (let dx = -40 * shot.scale; dx <= 40 * shot.scale; dx++) {
        let on = 0;
        for (let dy = -2 * shot.scale; dy <= 2 * shot.scale; dy++) on = Math.max(on, coverageOf(bg, pixelAt(shot.image, a.x + dx, a.y + dy), line));
        const now = on > 0.3;
        if (dx > -40 * shot.scale && now !== last) transitions++;
        last = now;
      }
      expect(transitions, "the construction line has dashes").toBeGreaterThan(10);

      // Points: hollow when under-constrained (the view's colour inside), filled when fully constrained or over-constrained.
      const inside = async (u: number) => colourAt(shot, await sketchPoint(page, u, 70));
      expect(colourDistance(await inside(20), hexToRgb(tokens.viewport)), "under-constrained point is hollow").toBeLessThan(12);
      expect(colourDistance(await inside(40), hexToRgb(tokens.sketchFull)), "fully constrained point is filled in the full colour").toBeLessThan(40);
      expect(colourDistance(await inside(60), hexToRgb(tokens.sketchOver)), "over-constrained point is filled").toBeLessThan(40);
      noErrors(app);
    });
  }

  test("a theme or mode switch repaints the sketch live: lines, points, band and fill follow the tokens", async ({ app }) => {
    const { page } = app;
    await openSketchDemo(app, { scene: "states", mode: "light" });
    await bare(app);
    const row = (v: number) => sketchPoint(page, 40, v);
    expect(lineHue(await shootHost(page), await row(22), light.sketchFull)).toBeGreaterThan(0.97);
    await page.getByTestId("vp-mode").dispatchEvent("click");
    await idle(page);
    const shot = await shootHost(page);
    expect(colourDistance(dominantColour(shot.image), hexToRgb(dark.viewport))).toBeLessThanOrEqual(3);
    expect(lineHue(shot, await row(22), dark.sketchFull), "the full line has the dark theme's colour").toBeGreaterThan(0.97);
    expect(lineHue(shot, await row(10), dark.sketchUnder), "and so has the under-constrained one").toBeGreaterThan(0.97);
    // The hollow point is filled with the dark view colour now, the full one with the dark green.
    expect(colourDistance(colourAt(shot, await sketchPoint(page, 20, 70)), hexToRgb(dark.viewport))).toBeLessThan(12);
    expect(colourDistance(colourAt(shot, await sketchPoint(page, 40, 70)), hexToRgb(dark.sketchFull))).toBeLessThan(40);
    noErrors(app);
  });

  test("the colour option turns fully constrained geometry blue, with the same weight", async ({ app }) => {
    const { page } = app;
    await openSketchDemo(app, { scene: "states", colour: "blue" });
    await bare(app);
    const shot = await shootHost(page);
    const full = await sketchPoint(page, 40, 22), under = await sketchPoint(page, 40, 10);
    expect(lineHue(shot, full, light.sketchFullBlue), "the full colour is the blue token").toBeGreaterThan(0.97);
    expect(Math.abs(lineWidth(shot, full, light.sketchFullBlue) - lineWidth(shot, under, light.sketchUnder))).toBeLessThan(0.45);
    noErrors(app);
  });

  for (const [modeName, tokens] of [["light", light], ["dark", dark]] as const) {
    test(`a determined region: the inner band lies inside the contour only, the hole stays empty (${modeName})`, async ({ app }) => {
      const { page } = app;
      await openSketchDemo(app, { highlight: "band", mode: modeName });
      await bare(app);
      const shot = await shootHost(page);
      const bg = hexToRgb(tokens.viewport);
      const px = async (u: number, v: number) => colourAt(shot, await sketchPoint(page, u, v));
      // The rectangle runs from (0, 0) to (60, 40); the band is six pixels wide, at about 3.8 px per mm that is 1.6 mm.
      expect(colourDistance(await px(60 - 0.9, 28), bg), "the band tints the pixels right inside the contour").toBeGreaterThan(14);
      expect(colourDistance(await px(40, 28), bg), "the middle of the region stays empty (no fill)").toBeLessThan(6);
      expect(colourDistance(await px(60 + 0.9, 28), bg), "nothing right outside the contour").toBeLessThan(6);
      // The ring around the round hole lies on the region's side, outside the hole.
      expect(colourDistance(await px(30 + 8 + 0.9, 20), bg), "band around the hole, in the region").toBeGreaterThan(14);
      expect(colourDistance(await px(30 + 3, 20 - 4), bg), "inside the hole nothing").toBeLessThan(6);
      // The band's inner edge is clear: about six pixels in, the tint is gone.
      expect(colourDistance(await px(60 - 3.2, 28), bg), "a clear inner edge").toBeLessThan(6);
      // An under-constrained closed loop gets no highlight.
      expect(colourDistance(await px(125, 22), bg), "no highlight for a loop that is not determined").toBeLessThan(6);
      noErrors(app);
    });

    test(`the full fill is 25 % of the full colour over the region, holes empty, open loops never (${modeName})`, async ({ app }) => {
      const { page } = app;
      await openSketchDemo(app, { highlight: "fill", mode: modeName });
      await bare(app);
      const shot = await shootHost(page);
      const bg = hexToRgb(tokens.viewport), full = hexToRgb(tokens.sketchFull);
      const px = async (u: number, v: number) => colourAt(shot, await sketchPoint(page, u, v));
      const filled = await px(45, 30);
      let channel = 0;
      for (let c = 0; c < 3; c++) if (Math.abs(bg[c]! - full[c]!) > Math.abs(bg[channel]! - full[channel]!)) channel = c;
      const fraction = (filled[channel]! - bg[channel]!) / (full[channel]! - bg[channel]!);
      test.info().annotations.push({ type: `fill share (${modeName})`, description: `${(fraction * 100).toFixed(1)} % of the way from the view colour to the line colour (owner: 25 % opacity)` });
      expect(fraction, "about a quarter of the way from the view to the line colour").toBeGreaterThan(0.17);
      expect(fraction).toBeLessThan(0.34);
      expect(colourDistance(await px(25, 16), bg), "the hole stays empty").toBeLessThan(6);
      expect(colourDistance(await px(125, 22), bg), "an under-constrained loop is not filled").toBeLessThan(6);
      expect(colourDistance(await px(30, -50 + 6), bg), "the circle on its own is a determined region and is filled").toBeGreaterThan(8);
      // No band in this mode: the pixel right inside the contour is just the fill.
      expect(colourDistance(await px(60 - 0.9, 28), filled), "no extra band along the contour").toBeLessThan(10);
      noErrors(app);
    });
  }

  test("the highlight is hidden while a drag skips the regions, and comes back", async ({ app }) => {
    const { page } = app;
    for (const highlight of ["band", "fill"] as const) {
      await openSketchDemo(app, { highlight });
      await bare(app);
      const probe = highlight === "band" ? ([60 - 0.9, 28] as const) : ([45, 30] as const);
      const measure = async () => colourDistance(colourAt(await shootHost(page), await sketchPoint(page, probe[0], probe[1])), hexToRgb(light.viewport));
      expect(await measure(), `${highlight} shown`).toBeGreaterThan(8);
      await page.getByTestId("sk-skipped").dispatchEvent("click");
      await idle(page);
      expect(await measure(), `${highlight} hidden while the regions are skipped`).toBeLessThan(6);
      await page.getByTestId("sk-skipped").dispatchEvent("click");
      await idle(page);
      expect(await measure(), `${highlight} back after the drag`).toBeGreaterThan(8);
    }
    noErrors(app);
  });

  test("hover and selection are a translucent band of about 7 px on the line; points get a halo", async ({ app }) => {
    const { page } = app;
    await openSketchDemo(app, { scene: "states" });
    await bare(app);
    const view = hexToRgb(light.viewport);
    const rest = await shootHost(page);
    const at = await sketchPoint(page, 40, 22);
    const off = (shot: Shot, dy: number): Rgb => colourAt(shot, { x: at.x, y: at.y + dy });
    expect(colourDistance(off(rest, 3), view), "nothing 3 px off the line at rest").toBeLessThan(5);

    // The ids are the demo's: the second line of the calibration sketch (fully constrained) and the middle point of the row of three.
    const lineId = await demo<string>(page, "sketch.view.lines.1.id");
    await layerCall<void>(page, "setHover", [{ kind: "line", id: lineId, u: 40, v: 22 }]);
    await idle(page);
    const hovered = await shootHost(page);
    expect(colourDistance(off(hovered, 3), view), "the hover band reaches 3 px off the line").toBeGreaterThan(8);
    expect(colourDistance(off(hovered, 6), view), "and ends at about 3.5 px").toBeLessThan(5);

    await layerCall<void>(page, "setHover", [null]);
    const pointId = await demo<string>(page, "sketch.view.points.9.id");
    await layerCall<void>(page, "setSelection", [[lineId, pointId]]);
    await idle(page);
    const selected = await shootHost(page);
    expect(colourDistance(off(selected, 3), view), "the selection band is there").toBeGreaterThan(8);
    expect(colourDistance(off(selected, 3), off(hovered, 3)), "the selection colour is not the hover colour").toBeGreaterThan(5);
    const p = await sketchPoint(page, 40, 70);
    expect(colourDistance(colourAt(selected, { x: p.x + 8, y: p.y }), view), "the selected point has a halo of 9 px").toBeGreaterThan(5);

    await layerCall<void>(page, "setSelection", [[]]);
    await idle(page);
    expect(colourDistance(off(await shootHost(page), 3), view), "the selection is gone").toBeLessThan(5);
    noErrors(app);
  });

  test("pointer hover over the sketch names what is under it, and a click selects it", async ({ app }) => {
    const { page } = app;
    await openSketchDemo(app);
    const hover = page.getByTestId("sketch-hover");
    const sel = page.getByTestId("sketch-selection");
    const on = async (u: number, v: number) => {
      const p = await sketchPoint(page, u, v);
      await page.mouse.move(p.x, p.y);
    };
    await on(15, 40);
    await expect(hover).toHaveText(/sketch hover: line:l/);
    await on(60, 40);
    await expect(hover).toHaveText(/sketch hover: point:p/);
    await on(15, 8);
    await expect(hover).toHaveText("sketch hover: region:r-rect");
    await on(30 + 3, 20 + 3);
    await expect(hover, "the round hole is not part of the region").not.toHaveText(/region/);
    const dims = await layerCall<{ x: number; y: number }[]>(page, "dimensionAnchors");
    expect(dims.length).toBeGreaterThanOrEqual(4);
    const rect = await page.getByTestId("viewport-host").boundingBox();
    if (!rect) throw new Error("no view");
    await page.mouse.move(rect.x + dims[0]!.x + 20, rect.y + dims[0]!.y);
    await expect(hover).toHaveText(/sketch hover: dimension:d/);
    await page.mouse.move(rect.x + rect.width - 8, rect.y + rect.height - 8);
    await expect(hover).toHaveText("sketch hover: none");

    const p = await sketchPoint(page, 15, 40);
    await page.mouse.click(p.x, p.y);
    await expect(sel).toHaveText(/sketch selection: l\d+/);
    await page.mouse.click(rect.x + rect.width - 8, rect.y + rect.height - 8);
    await expect(sel).toHaveText("sketch selection: none");
    noErrors(app);
  });

  test("dimension graphics and HTML anchors: labels sit at their anchors, on their dimension lines", async ({ app }) => {
    const { page } = app;
    await openSketchDemo(app);
    await demo<void>(page, "viewport.setGridVisible", [false]);
    await page.getByTestId("sk-cons").dispatchEvent("click");
    await idle(page);
    const anchors = await layerCall<{ id: string; x: number; y: number }[]>(page, "dimensionAnchors");
    expect(anchors.length).toBeGreaterThanOrEqual(5);
    const rect = await page.getByTestId("viewport-host").boundingBox();
    if (!rect) throw new Error("no view");
    for (const a of anchors) {
      const box = await page.getByTestId(`sk-dim-${a.id}`).boundingBox();
      expect(box, a.id).not.toBeNull();
      expect(Math.abs(box!.x + box!.width / 2 - (rect.x + a.x)), `${a.id} x`).toBeLessThan(1.5);
      expect(Math.abs(box!.y + box!.height / 2 - (rect.y + a.y)), `${a.id} y`).toBeLessThan(1.5);
    }
    // The 60 mm dimension: its label is 14 mm below the bottom line; the dimension line left of the label has dimLine's colour.
    const shot = await shootHost(page);
    expect(peakCoverage(shot, await sketchPoint(page, 6, -14), light.dimLine), "dimension line pixels left of the label").toBeGreaterThan(0.3);
    // Hiding the dimensions removes labels and anchors.
    await page.getByTestId("sk-dims").dispatchEvent("click");
    await idle(page);
    expect(await layerCall<unknown[]>(page, "dimensionAnchors")).toEqual([]);
    expect(await page.locator("[data-testid^='sk-dim-']").count()).toBe(0);
    noErrors(app);
  });

  test("constraint anchors: one per constraint, none on another and none on a label", async ({ app }) => {
    const { page } = app;
    await openSketchDemo(app);
    const cons = await layerCall<{ id: string; x: number; y: number }[]>(page, "constraintAnchors");
    const dims = await layerCall<{ id: string; x: number; y: number }[]>(page, "dimensionAnchors");
    expect(cons.length).toBeGreaterThanOrEqual(8);
    for (let i = 0; i < cons.length; i++) {
      for (let j = i + 1; j < cons.length; j++) {
        expect(Math.abs(cons[i]!.x - cons[j]!.x) < 20 && Math.abs(cons[i]!.y - cons[j]!.y) < 20, `${cons[i]!.id} / ${cons[j]!.id}`).toBe(false);
      }
      for (const d of dims) expect(Math.abs(cons[i]!.x - d.x) < 40 && Math.abs(cons[i]!.y - d.y) < 22, `${cons[i]!.id} on label ${d.id}`).toBe(false);
    }
    await page.getByTestId("sk-cons").dispatchEvent("click");
    await idle(page);
    expect(await layerCall<unknown[]>(page, "constraintAnchors")).toEqual([]);
    noErrors(app);
  });

  test("a tool preview is drawn in its own colour, with dashed guides and hints, and goes away again", async ({ app }) => {
    const { page } = app;
    await openSketchDemo(app);
    await bare(app, ["sk-dims", "sk-cons"]);
    const mid = await sketchPoint(page, 174, -12); // the middle of the rubber band from (160, -20) to (188, -4)
    expect(nearestToToken(await shootHost(page), mid, light.primary, 3), "the preview line has the primary colour").toBeLessThan(35);
    await page.getByTestId("sk-preview").dispatchEvent("click");
    await idle(page);
    expect(nearestToToken(await shootHost(page), mid, light.primary, 3), "no preview after it is cleared").toBeGreaterThan(60);
    noErrors(app);
  });

  for (const [plane, expectedEye] of [["xy", [0, 0, 1]], ["xz", [0, -1, 0]], ["yz", [1, 0, 0]]] as const) {
    test(`alignToSketch on the ${plane.toUpperCase()} plane: u to the right, v up, from any view (the bug of the first sketch)`, async ({ app }) => {
      const { page } = app;
      await openSketchDemo(app, { plane });
      const host = await page.getByTestId("viewport-host").boundingBox();
      if (!host) throw new Error("no view");
      // Start from the start view, like the first sketch did, then align.
      await setView(page, { target: [0, 0, 0], azimuth: Math.PI / 4, elevation: 0.6, distance: 250 });
      await layerCall<void>(page, "alignToSketch", [false]);
      await idle(page);
      const view = await getView(page);
      const eye: Vec3 = [Math.sin(view.azimuth) * Math.cos(view.elevation), -Math.cos(view.azimuth) * Math.cos(view.elevation), Math.sin(view.elevation)];
      for (let i = 0; i < 3; i++) expect(eye[i]!).toBeCloseTo(expectedEye[i]!, 6);
      const o = await sketchPoint(page, 0, 0), u = await sketchPoint(page, 20, 0), v = await sketchPoint(page, 0, 20);
      expect(u.x, "+u runs to the right").toBeGreaterThan(o.x + 5);
      expect(Math.abs(u.y - o.y), "and level").toBeLessThan(0.5);
      expect(v.y, "+v runs up the screen").toBeLessThan(o.y - 5);
      expect(Math.abs(v.x - o.x)).toBeLessThan(0.5);
      // toSketch undoes toScreen.
      const back = await layerCall<{ u: number; v: number } | null>(page, "toSketch", [u.x - host.x, u.y - host.y]);
      expect(back?.u).toBeCloseTo(20, 3);
      expect(back?.v).toBeCloseTo(0, 3);
      // The animated variant ends in the same view.
      await setView(page, { target: [0, 0, 0], azimuth: -2, elevation: -0.4, distance: 250 });
      await layerCall<void>(page, "alignToSketch", [true]);
      await idle(page);
      const animated = await getView(page);
      expect(animated.azimuth).toBeCloseTo(view.azimuth, 5);
      expect(animated.elevation).toBeCloseTo(view.elevation, 5);
      noErrors(app);
    });
  }

  test("the grid lies in the sketch plane: an XZ sketch seen from the front still has its grid", async ({ app }) => {
    const { page } = app;
    await openSketchDemo(app, { plane: "xz", scene: "states" });
    const shot = await shootHost(page);
    expect(countDifferent(shot.image, hexToRgb(light.viewport), 6), "grid lines fill the view").toBeGreaterThan(4000);
    noErrors(app);
  });

  test("subscribers hear about camera changes once per frame, and anchors follow the view", async ({ app }) => {
    const { page } = app;
    await openSketchDemo(app);
    const result = await page.evaluate(async () => {
      const d = (window as unknown as { __viewportDemo: { viewport: { zoomBy(f: number): void; panBy(x: number, y: number): void; whenIdle(): Promise<void> }; sketchLayer: { subscribe(l: () => void): () => void; dimensionAnchors(): { id: string; x: number }[] } } }).__viewportDemo;
      let calls = 0;
      const off = d.sketchLayer.subscribe(() => { calls++; });
      const before = d.sketchLayer.dimensionAnchors()[0]!;
      d.viewport.zoomBy(0.8);
      d.viewport.zoomBy(0.8);
      d.viewport.panBy(40, 0);
      await d.viewport.whenIdle();
      const after = d.sketchLayer.dimensionAnchors()[0]!;
      off();
      return { calls, moved: Math.abs(after.x - before.x) };
    });
    expect(result.calls, "one notice for the changes of a frame").toBe(1);
    expect(result.moved).toBeGreaterThan(5);
    noErrors(app);
  });

  test("rendering stays on demand in sketch mode, also while the pointer rests on the same thing", async ({ app }) => {
    const { page } = app;
    await openSketchDemo(app);
    await idle(page);
    const n0 = await renderCount(page);
    await page.waitForTimeout(600);
    expect(await renderCount(page), "no frames while idle").toBe(n0);
    const p = await sketchPoint(page, 15, 40);
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(250);
    await idle(page);
    const n1 = await renderCount(page);
    await page.mouse.move(p.x + 1, p.y);
    await page.mouse.move(p.x + 2, p.y);
    await page.waitForTimeout(250);
    expect(await renderCount(page), "moving along the same line draws nothing new").toBe(n1);
    noErrors(app);
  });

  test("hover over a sketch of 200 curves stays smooth: picking and frame times are measured and reported", async ({ app }) => {
    const { page } = app;
    await openSketchDemo(app, { scene: "stress" });
    // Warm up: the first frames compile pipelines.
    await demo<unknown>(page, "measureSketchHover", [20]);
    const m = await demo<SketchHoverMeasurement>(page, "measureSketchHover", [240]);
    const backend = await backendOf(page);
    test.info().annotations.push({
      type: `sketch hover (${backend}, ${m.curves} curves)`,
      description: `${m.moves} moves, ${m.hits} hits; pick mean ${m.pickMeanMs.toFixed(3)} ms, max ${m.pickMaxMs.toFixed(2)} ms; frames mean ${m.frameMeanMs.toFixed(2)} ms, p95 ${m.frameP95Ms.toFixed(2)} ms, max ${m.frameMaxMs.toFixed(2)} ms; CPU per render ${m.cpuMeanMs.toFixed(2)} ms`,
    });
    expect(m.curves).toBe(200);
    expect(m.hits, "the moves do find things").toBeGreaterThan(5);
    expect(m.pickMeanMs, "a pick over 200 curves takes a fraction of a frame").toBeLessThan(4);
    expect(m.frameMaxMs).toBeLessThan(5000);
    noErrors(app);
  });
});

// --- the extrude command in the 3D view (U3a): profiles, preview, drag arrow -----------------------------------------------------
// Demo page ?demo=viewport&extrude=1: two profiles on the top face of the box (a frame with a hole, a disc), the arrow at the frame's
// band and a preview body that follows the arrow's distance the way the main window wires it (extrudeHandle event -> setExtrudeHandle).

test.describe("extrude command", () => {
  const ex = <T>(page: Page, path: string, args: unknown[] = []) => demo<T>(page, `extrude.${path}`, args);
  const hoverText = (app: AppUnderTest) => app.page.getByTestId("viewport-hover");
  const selectionText = (app: AppUnderTest) => app.page.getByTestId("viewport-selection");
  const frameRef = `profile:s-top:${frameRegion}`;
  const discRef = `profile:s-top:${discRegion}`;
  /** The start view of the arrow drags: the demo box seen from the front right above. */
  const dragView: View = { target: [0, 0, 20], azimuth: 0.7, elevation: 0.5, distance: 190 };
  const originOfArrow: Vec3 = [-8.5, 0, 20];
  const cursorOf = (page: Page) => page.evaluate(() => document.querySelector<HTMLCanvasElement>("[data-viewport-canvas]")?.style.cursor);

  const clientOf = async (page: Page, p: Vec3): Promise<{ x: number; y: number }> => {
    const c = await demo<{ x: number; y: number } | null>(page, "viewport.worldToClient", [p]);
    if (!c) throw new Error(`no screen point for ${p.join(",")}`);
    return c;
  };

  for (const mode of ["light", "dark"] as const) {
    test(`profiles: hovering names the region, a click selects it, hover, selection and rest look different, the hole is no profile (${mode})`, async ({ app }) => {
      const { page } = app;
      await openExtrudeDemo(app, { mode, distance: 0 });
      await setView(page, dragView);
      const frame = await ex<{ x: number; y: number }>(page, "profilePoint", [frameRegion]);
      const disc = await ex<{ x: number; y: number }>(page, "profilePoint", [discRegion]);
      const hole = await clientOf(page, [-19, 0, 20]);
      const empty = await sampleEmptyPoint(app);
      await page.mouse.move(empty.x, empty.y);
      await expect(hoverText(app)).toHaveText("hover: none");
      await idle(page);
      const rest = await shootHost(page);

      await page.mouse.move(frame.x, frame.y);
      await expect(hoverText(app)).toHaveText(`hover: ${frameRef}`);
      await idle(page);
      const hovered = await shootHost(page);
      await page.mouse.move(disc.x, disc.y);
      await expect(hoverText(app)).toHaveText(`hover: ${discRef}`);
      // The hole shows what is beneath it: no profile there (only profiles are pickable in this command).
      await page.mouse.move(hole.x, hole.y);
      await expect(hoverText(app)).toHaveText("hover: none");

      await page.mouse.click(frame.x, frame.y);
      await expect(selectionText(app)).toHaveText(`selection: ${frameRef}`);
      await page.mouse.move(empty.x, empty.y);
      await idle(page);
      const selected = await shootHost(page);

      const at = rest.at(frame);
      const r = meanColour(rest.image, at.x, at.y, 3 * rest.scale), h = meanColour(hovered.image, at.x, at.y, 3 * rest.scale), s = meanColour(selected.image, at.x, at.y, 3 * rest.scale);
      expect(colourDistance(r, h), "hover changes the fill").toBeGreaterThan(8);
      expect(colourDistance(r, s), "selection changes the fill").toBeGreaterThan(8);
      expect(colourDistance(h, s), "hover and selection differ from each other").toBeGreaterThan(8);
      // The rest fill itself is visible against the body face under it (the box top is another colour than the tinted fill).
      const away = rest.at(await clientOf(page, [30, 22, 20])); // the box top outside the profiles
      expect(colourDistance(r, meanColour(rest.image, away.x, away.y, 2 * rest.scale)), "the fill at rest differs from the bare face").toBeGreaterThan(8);

      // The disc is a region of its own: clicking it replaces the selection; Shift adds.
      await page.mouse.click(disc.x, disc.y);
      await expect(selectionText(app)).toHaveText(`selection: ${discRef}`);
      await page.keyboard.down("Shift");
      await page.mouse.click(frame.x, frame.y);
      await page.keyboard.up("Shift");
      await expect(selectionText(app)).toHaveText(`selection: ${discRef}, ${frameRef}`);
      await page.mouse.click(empty.x, empty.y);
      await expect(selectionText(app)).toHaveText("selection: none");
      noErrors(app);
    });
  }

  test("with every kind allowed a profile is picked before the face it lies on and before an origin plane; elsewhere the face", async ({ app }) => {
    const { page } = app;
    await openExtrudeDemo(app, { distance: 0 });
    await setView(page, dragView);
    await demo<void>(page, "viewport.setPickKinds", [null]);
    await demo<void>(page, "viewport.setOriginPlanesVisible", [true]);
    const frame = await ex<{ x: number; y: number }>(page, "profilePoint", [frameRegion]);
    await page.mouse.move(frame.x, frame.y);
    await expect(hoverText(app)).toHaveText(`hover: ${frameRef}`);
    // Inside the hole and on the bare top face next to the profiles: the face of the box (the planes are put away, one would be in front).
    await demo<void>(page, "viewport.setOriginPlanesVisible", [false]);
    const hole = await clientOf(page, [-19, 0, 20]);
    await page.mouse.move(hole.x, hole.y);
    await expect(hoverText(app)).toHaveText("hover: face:box:1");
    const bare = await clientOf(page, [30, 22, 20]);
    await page.mouse.move(bare.x, bare.y);
    await expect(hoverText(app)).toHaveText("hover: face:box:1");
    // When profiles are not an allowed kind, they cannot be hovered.
    await demo<void>(page, "viewport.setPickKinds", [["face"]]);
    await page.mouse.move(frame.x, frame.y + 1);
    await expect(hoverText(app)).toHaveText("hover: face:box:1");
    noErrors(app);
  });

  test("the selection drops a profile that is no longer in the list", async ({ app }) => {
    const { page } = app;
    await openExtrudeDemo(app, { distance: 0 });
    await demo<void>(page, "viewport.setSelection", [[{ kind: "profile", sketchId: "s-top", regionId: frameRegion }, { kind: "profile", sketchId: "s-top", regionId: "gone" }]]);
    // A new list with the same regions keeps the first selected profile; the unknown one drops out.
    await ex<void>(page, "reapplyProfiles", [1]);
    expect((await demo<{ kind: string; regionId?: string }[]>(page, "viewport.getSelection")).map((r) => r.regionId)).toEqual([frameRegion]);
    await demo<void>(page, "viewport.setProfiles", [null]);
    expect(await demo<unknown[]>(page, "viewport.getSelection")).toEqual([]);
    noErrors(app);
  });

  test("the preview is never pickable and hides nothing behind it", async ({ app }) => {
    const { page } = app;
    await openExtrudeDemo(app, { distance: 15 });
    await setView(page, dragView);
    await demo<void>(page, "viewport.setPickKinds", [null]);
    // Points on the preview: its top face (z = 35) over the band of the frame, and its side walls.
    const points: Vec3[] = [[-8.5, 10, 35], [-30, 10, 35], [-8.5, 10, 27], [-4, 5, 28]];
    const withPreview: ({ ref: unknown } | null)[] = [];
    for (const p of points) {
      const c = await clientOf(page, p);
      withPreview.push(await demo<{ ref: unknown } | null>(page, "viewport.pick", [c.x, c.y]));
      await page.mouse.move(c.x, c.y);
      await idle(page);
      expect(await hoverText(app).textContent(), "the preview body is never named").not.toContain("preview");
    }
    await ex<void>(page, "setDistance", [0]);
    await idle(page);
    for (const [i, p] of points.entries()) {
      const c = await clientOf(page, p);
      const without = await demo<{ ref: unknown } | null>(page, "viewport.pick", [c.x, c.y]);
      expect(without?.ref, `point ${i}: with and without the preview the same thing is picked`).toEqual(withPreview[i]?.ref);
    }
    noErrors(app);
  });

  test("the preview is translucent in its own colour: it differs from the background and from the plain preview colour, and its edges are dashed", async ({ app }) => {
    const { page } = app;
    await openExtrudeDemo(app, { distance: 15, mode: "light" });
    await setView(page, dragView);
    await demo<void>(page, "viewport.setGridVisible", [true]);
    await idle(page);
    const tokens = getTheme("praezision").tokens.light;
    const wall = await clientOf(page, [-4, 12, 33]);
    const shot = await shootHost(page);
    const at = shot.at(wall);
    const seen = meanColour(shot.image, at.x, at.y, 1.5 * shot.scale);
    expect(colourDistance(seen, hexToRgb(tokens.viewport)), "the preview is drawn there").toBeGreaterThan(10);
    expect(colourDistance(seen, hexToRgb(tokens.primary)), "translucent: not the plain preview colour").toBeGreaterThan(20);
    // The preview edge is dashed in the preview colour: walking along the top edge (in half-pixel steps, looking one pixel to each side)
    // the colour comes and goes. The edge is 5 px on, 3 px off, so a 130 px edge has about 16 dashes.
    const a = shot.at(await clientOf(page, [-34, -18, 35])), b = shot.at(await clientOf(page, [-4, -18, 35]));
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length;
    let transitions = 0, previous = false, onCount = 0, steps = 0;
    for (let d = 3; d < length - 3; d += 0.5) {
      let best = 999;
      for (const k of [-1, 0, 1]) best = Math.min(best, colourDistance(pixelAt(shot.image, a.x + ux * d - uy * k, a.y + uy * d + ux * k), hexToRgb(tokens.primary)));
      const on = best < 45;
      if (steps > 0 && on !== previous) transitions++;
      if (on) onCount++;
      previous = on;
      steps++;
    }
    expect(transitions, "the edge colour comes and goes: dashes").toBeGreaterThanOrEqual(8);
    expect(onCount / steps, "dashes, not a hairline here and there").toBeGreaterThan(0.3);
    expect(onCount / steps, "gaps between the dashes").toBeLessThan(0.9);
    noErrors(app);
  });

  test("replacing the preview and the arrow at typing speed frees what it replaced: nothing piles up on the GPU", async ({ app }) => {
    const { page } = app;
    await openExtrudeDemo(app, { distance: 10 });
    await idle(page);
    const stats = () => demo<{ geometries: number; textures: number; bufferBytes: number }>(page, "viewport.resourceStats");
    await ex<void>(page, "typeDistances", [[11, 12, 13], 20]);
    await idle(page);
    const before = await stats();
    const values = Array.from({ length: 300 }, (_, i) => 5 + (i % 40) * 0.5);
    await ex<void>(page, "typeDistances", [values, 4]);
    await idle(page);
    const after = await stats();
    test.info().annotations.push({ type: "gpu resources", description: `before ${JSON.stringify(before)}, after 300 replacements ${JSON.stringify(after)}` });
    expect(after.geometries, "the same number of geometries as with one preview").toBeLessThanOrEqual(before.geometries + 1);
    expect(after.textures).toBe(before.textures);
    expect(after.bufferBytes, "the buffers of the replaced previews are gone").toBeLessThan(before.bufferBytes * 1.2 + 1024);
    // The profiles can also be refreshed at will.
    await ex<void>(page, "reapplyProfiles", [200]);
    await idle(page);
    const profiles = await stats();
    expect(profiles.geometries).toBeLessThanOrEqual(after.geometries + 1);
    expect(profiles.bufferBytes).toBeLessThan(after.bufferBytes * 1.2 + 1024);
    noErrors(app);
  });

  test("the arrow: a drag along its axis emits growing distances, ends with the pointer, and never orbits or clicks", async ({ app }) => {
    const { page } = app;
    const fromTheBack: View = { target: [0, 0, 20], azimuth: 2.3, elevation: 0.25, distance: 160 };
    for (const view of [dragView, fromTheBack]) {
      await openExtrudeDemo(app, { distance: 15 });
      await setView(page, view);
      const viewBefore = await getView(page);
      await ex<void>(page, "clearEvents");
      const tip = await ex<{ x: number; y: number }>(page, "handleTip");
      const to = await clientOf(page, [originOfArrow[0], originOfArrow[1], originOfArrow[2] + 30]);
      await page.mouse.move(tip.x, tip.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) {
        await page.mouse.move(tip.x + ((to.x - tip.x) * i) / 8, tip.y + ((to.y - tip.y) * i) / 8);
        await idle(page);
      }
      await page.mouse.up();
      await idle(page);
      const events = await ex<ExtrudeEvent[]>(page, "events");
      expect(events[0], "start carries the distance at the grab").toEqual({ distance: 15, phase: "start" });
      expect(events.at(-1)?.phase).toBe("end");
      const moves = events.filter((e) => e.phase === "move").map((e) => e.distance);
      expect(moves.length, "several moves").toBeGreaterThanOrEqual(4);
      for (let i = 1; i < moves.length; i++) expect(moves[i]!, `move ${i} grows`).toBeGreaterThan(moves[i - 1]!);
      expect(events.at(-1)?.distance).toBeCloseTo(moves.at(-1)!, 9);
      expect(moves.at(-1)!, "the arrow ends where the pointer ended: 30 mm").toBeGreaterThan(29);
      expect(moves.at(-1)!).toBeLessThan(31);
      expect(await ex<number>(page, "distance")).toBeCloseTo(moves.at(-1)!, 9);
      await expect(page.getByTestId("extrude-state")).toHaveText(`extrude distance: ${moves.at(-1)!.toFixed(2)} mm`);
      expect(await getView(page), "the camera did not move").toEqual(viewBefore);
      await expect(selectionText(app), "no click was sent").toHaveText("selection: none");

      // Back through the profile to the other side: the distance goes negative, decreasing all the way.
      await ex<void>(page, "clearEvents");
      const tip2 = await ex<{ x: number; y: number }>(page, "handleTip");
      const below = await clientOf(page, [originOfArrow[0], originOfArrow[1], originOfArrow[2] - 8]);
      await page.mouse.move(tip2.x, tip2.y);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) {
        await page.mouse.move(tip2.x + ((below.x - tip2.x) * i) / 10, tip2.y + ((below.y - tip2.y) * i) / 10);
        await idle(page);
      }
      await page.mouse.up();
      await idle(page);
      const back = (await ex<ExtrudeEvent[]>(page, "events")).filter((e) => e.phase === "move").map((e) => e.distance);
      for (let i = 1; i < back.length; i++) expect(back[i]!).toBeLessThan(back[i - 1]!);
      expect(back.at(-1)!, "-8 mm").toBeGreaterThan(-9);
      expect(back.at(-1)!).toBeLessThan(-7);
      expect(await getView(page)).toEqual(viewBefore);
    }
    noErrors(app);
  });

  test("the arrow: a drag on the shaft works too, a press beside the arrow is no drag, and a removed arrow cannot be grabbed", async ({ app }) => {
    const { page } = app;
    await openExtrudeDemo(app, { distance: 20 });
    await setView(page, dragView);
    await ex<void>(page, "clearEvents");
    const mid = await ex<{ x: number; y: number }>(page, "handleMiddle");
    const farther = await clientOf(page, [originOfArrow[0], originOfArrow[1], originOfArrow[2] + 28]);
    await page.mouse.move(mid.x, mid.y);
    await page.mouse.down();
    await page.mouse.move(mid.x + (farther.x - mid.x) / 2, mid.y + (farther.y - mid.y) / 2, { steps: 3 });
    await page.mouse.move(farther.x, farther.y, { steps: 3 });
    await page.mouse.up();
    await idle(page);
    let events = await ex<ExtrudeEvent[]>(page, "events");
    expect(events[0]?.phase).toBe("start");
    // Grabbed at 10 mm on the shaft and moved to 28 mm: the arrow grew by 18 mm, from its 20 mm to 38.
    const last = events.filter((e) => e.phase === "move").at(-1)!.distance;
    expect(last).toBeGreaterThan(37);
    expect(last).toBeLessThan(39);

    await ex<void>(page, "clearEvents");
    const beside = await clientOf(page, [30, 22, 20]);
    await page.mouse.move(beside.x, beside.y);
    await page.mouse.down();
    await page.mouse.move(beside.x + 40, beside.y - 30, { steps: 4 });
    await page.mouse.up();
    expect(await ex<ExtrudeEvent[]>(page, "events"), "a press away from the arrow sends nothing").toEqual([]);

    await demo<void>(page, "viewport.setExtrudeHandle", [null]);
    await idle(page);
    const tip = await ex<{ x: number; y: number }>(page, "handleTip");
    await page.mouse.move(tip.x, tip.y);
    await page.mouse.down();
    await page.mouse.move(tip.x, tip.y - 30, { steps: 3 });
    await page.mouse.up();
    events = await ex<ExtrudeEvent[]>(page, "events");
    expect(events, "no arrow, no drag").toEqual([]);
    expect(await cursorOf(page)).toBe("");
    noErrors(app);
  });

  for (const mode of ["light", "dark"] as const) {
    test(`the arrow lights up under the pointer: colour, a grab cursor, and back (${mode})`, async ({ app }) => {
      const { page } = app;
      await openExtrudeDemo(app, { distance: 25, mode });
      await setView(page, dragView);
      await idle(page);
      const tokens = getTheme("praezision").tokens[mode];
      const tip = await ex<{ x: number; y: number }>(page, "handleTip");
      const origin = await clientOf(page, originOfArrow);
      const len = Math.hypot(origin.x - tip.x, origin.y - tip.y);
      // A point inside the head: 9 px from the tip towards the arrow's start.
      const inside = { x: tip.x + ((origin.x - tip.x) / len) * 9, y: tip.y + ((origin.y - tip.y) / len) * 9 };
      const empty = await sampleEmptyPoint(app);
      await page.mouse.move(empty.x, empty.y);
      await idle(page);
      const rest = await shootHost(page);
      const r = rest.at(inside);
      expect(colourDistance(meanColour(rest.image, r.x, r.y, 1.5 * rest.scale), hexToRgb(tokens.primary)), "at rest the head has the primary colour").toBeLessThan(14);
      expect(await cursorOf(page)).toBe("");

      await page.mouse.move(tip.x, tip.y);
      await idle(page);
      expect(await cursorOf(page)).toBe("grab");
      const lit = await shootHost(page);
      const l = lit.at(inside);
      expect(colourDistance(meanColour(lit.image, l.x, l.y, 1.5 * lit.scale), hexToRgb(tokens.hover)), "hovered the head has the hover colour").toBeLessThan(14);
      await expect(hoverText(app), "nothing under the arrow is hovered").toHaveText("hover: none");

      await page.mouse.move(empty.x, empty.y);
      await idle(page);
      const back = await shootHost(page);
      expect(colourDistance(meanColour(back.image, r.x, r.y, 1.5 * rest.scale), hexToRgb(tokens.primary))).toBeLessThan(14);
      noErrors(app);
    });
  }

  test("the arrow's head keeps its size on the screen when the view is zoomed", async ({ app }) => {
    const { page } = app;
    await openExtrudeDemo(app, { distance: 25, panel: false });
    // Only the arrow in the picture: no preview, no grid, no origin axes, so every pixel of the arrow's colour near the tip is the arrow.
    await demo<void>(page, "viewport.setPreview", [null]);
    await demo<void>(page, "viewport.setGridVisible", [false]);
    await demo<void>(page, "viewport.setOriginVisible", [false]);
    const tokens = getTheme("praezision").tokens.light;
    const area = async (distance: number): Promise<number> => {
      // The view is centred on the middle of the arrow, so the tip stays inside the picture whatever the size of the window.
      await setView(page, { ...dragView, target: [originOfArrow[0], originOfArrow[1], originOfArrow[2] + 12], distance });
      const tip = await ex<{ x: number; y: number }>(page, "handleTip");
      await page.mouse.move(5, 5);
      await idle(page);
      const shot = await shootHost(page);
      // The pixels of the arrow's colour in a 56 px square around the tip: the head (20 x 16 px) and the first part of the shaft.
      let count = 0;
      for (let dy = -28; dy < 28; dy++) {
        for (let dx = -28; dx < 28; dx++) {
          const p = shot.at({ x: tip.x + dx, y: tip.y + dy });
          if (colourDistance(pixelAt(shot.image, p.x, p.y), hexToRgb(tokens.primary)) < 14) count++;
        }
      }
      return count; // one sample per CSS pixel, so the count is in CSS pixels whatever the device scale
    };
    const near = await area(120), far = await area(420);
    test.info().annotations.push({ type: "arrow pixels around the tip", description: `zoomed in ${near.toFixed(0)}, zoomed out ${far.toFixed(0)}` });
    expect(near, "the head and a part of the shaft are really drawn").toBeGreaterThan(100);
    expect(far / near, "the same size on the screen at any zoom").toBeGreaterThan(0.8);
    expect(far / near).toBeLessThan(1.25);
    noErrors(app);
  });

  test("frame time with two bodies, the preview and the arrow is measured and reported", async ({ app }) => {
    const { page } = app;
    await openExtrudeDemo(app, { distance: 15 });
    await demo<Measurement>(page, "measureOrbit", [30, 3]);
    const m = await demo<Measurement>(page, "measureOrbit", [240, 3]);
    const backend = await backendOf(page);
    test.info().annotations.push({
      type: `extrude orbit frame time (${backend})`,
      description: `${m.frames} frames: mean ${m.meanMs.toFixed(2)} ms, p95 ${m.p95Ms.toFixed(2)} ms, max ${m.maxMs.toFixed(2)} ms, CPU per render ${m.meanCpuMs.toFixed(2)} ms`,
    });
    expect(m.frames).toBeGreaterThan(200);
    expect(m.maxMs).toBeLessThan(5000);
    noErrors(app);
  });

  // Screenshots for the review (only with PARTCRAFT_U3A_SHOTS=1): rest, hover, selection, preview and arrow in light and dark.
  test("screenshots of the states", async ({ app }) => {
    test.skip(process.env.PARTCRAFT_U3A_SHOTS !== "1" || app.target !== "browser", "set PARTCRAFT_U3A_SHOTS=1 to write the screenshots (browser project)");
    const { page } = app;
    const dir = process.env.PARTCRAFT_SHOTS_DIR ?? join(process.cwd(), "_build", "screenshots");
    mkdirSync(dir, { recursive: true });
    for (const [mode, name] of [["light", "hell"], ["dark", "dunkel"]] as const) {
      await openExtrudeDemo(app, { mode, distance: 0, panel: false });
      await setView(page, { target: [-8, 0, 26], azimuth: 0.62, elevation: 0.5, distance: 135 });
      await page.mouse.move(5, 5);
      await demo<void>(page, "viewport.setExtrudeHandle", [null]);
      await idle(page);
      const frame = await ex<{ x: number; y: number }>(page, "profilePoint", [frameRegion]);
      const disc = await ex<{ x: number; y: number }>(page, "profilePoint", [discRegion]);
      const host = page.getByTestId("viewport-host");
      await host.screenshot({ path: join(dir, `u3a-profile-ruhe-${name}.png`) });
      await page.mouse.move(frame.x, frame.y);
      await idle(page);
      await host.screenshot({ path: join(dir, `u3a-profile-hover-${name}.png`) });
      await page.mouse.click(frame.x, frame.y);
      await page.mouse.move(disc.x, disc.y);
      await idle(page);
      await host.screenshot({ path: join(dir, `u3a-profile-auswahl-${name}.png`) });
      await page.mouse.click(5, 5);
      await ex<void>(page, "setDistance", [15]);
      await idle(page);
      await page.mouse.move(5, 5);
      await idle(page);
      await host.screenshot({ path: join(dir, `u3a-vorschau-${name}.png`) });
      const tip = await ex<{ x: number; y: number }>(page, "handleTip");
      await page.mouse.move(tip.x, tip.y);
      await idle(page);
      await host.screenshot({ path: join(dir, `u3a-pfeil-hover-${name}.png`) });
      await page.mouse.move(5, 5);
    }
  });
});

// Screenshots of the origin planes and axes for the review (only with PARTCRAFT_SHOTS=<name>, Electron project): a typical case:
// a new sketch with an existing body and sketch in the view. The names read ebenen-<name>-... and achsen-<name>-... (name: vorher, nachher).
test("screenshots of the origin planes and axes", async ({ app }) => {
  const name = process.env.PARTCRAFT_SHOTS ?? "";
  test.skip(name === "" || app.target !== "electron", "set PARTCRAFT_SHOTS=vorher|nachher to write the screenshots (Electron project)");
  const { page } = app;
  const dir = process.env.PARTCRAFT_SHOTS_DIR ?? join(process.cwd(), "_build", "screenshots");
  mkdirSync(dir, { recursive: true });
  const host = page.getByTestId("viewport-host");
  for (const [mode, label] of [["light", "hell"], ["dark", "dunkel"]] as const) {
    await openDemo(app, { mode, planes: true, panel: false });
    await demo<void>(page, "viewport.setGridVisible", [true]);
    await idle(page);
    await page.mouse.move(5, 5);
    await host.screenshot({ path: join(dir, `ebenen-${name}-${label}.png`) });
    await demo<void>(page, "viewport.setOriginPlanesVisible", [false]);
    await idle(page);
    await host.screenshot({ path: join(dir, `achsen-${name}-${label}.png`) });
    const z = await demo<{ x: number; y: number } | null>(page, "viewport.worldToClient", [[0, 0, 60]]);
    if (z) {
      await page.mouse.move(z.x, z.y);
      await idle(page);
      await host.screenshot({ path: join(dir, `achsen-${name}-hover-${label}.png`) });
      await page.mouse.move(5, 5);
    }
    await demo<void>(page, "viewport.setGridVisible", [false]);
    await idle(page);
    await host.screenshot({ path: join(dir, `achsen-${name}-raster-aus-${label}.png`) });
  }
});

// --- origin planes: a small marker of constant screen size ------------------------------------------------------

test.describe("origin planes at a constant screen size", () => {
  const hoverText = (app: AppUnderTest) => app.page.getByTestId("viewport-hover");
  const topView = (distance: number): View => ({ target: [0, 0, 0], azimuth: 0, elevation: HALF_PI, distance });
  const clientOf = async (page: Page, p: Vec3): Promise<{ x: number; y: number }> => {
    const c = await demo<{ x: number; y: number } | null>(page, "viewport.worldToClient", [p]);
    if (!c) throw new Error(`no screen point for ${p.join(",")}`);
    return c;
  };
  const hostSize = async (app: AppUnderTest): Promise<{ width: number; height: number }> => {
    const box = await app.page.getByTestId("viewport-host").boundingBox();
    if (!box) throw new Error("no 3D view");
    return box;
  };

  /** The bounding box (CSS px) of the pixels that differ between two screenshots of the same view. */
  function changedBox(a: Awaited<ReturnType<typeof shootHost>>, b: Awaited<ReturnType<typeof shootHost>>): { x0: number; y0: number; x1: number; y1: number } | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = 0; y < a.image.height; y++) {
      for (let x = 0; x < a.image.width; x++) {
        if (colourDistance(pixelAt(a.image, x, y), pixelAt(b.image, x, y)) > 2) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
    }
    return x1 < 0 ? null : { x0: x0 / a.scale, y0: y0 / a.scale, x1: x1 / a.scale, y1: y1 / a.scale };
  }

  test("the planes keep their size on the screen, a sixth of the shorter side, at every zoom", async ({ app }) => {
    const { page } = app;
    await openDemo(app, { panel: false });
    await demo<void>(page, "viewport.setBodies", [[]]);
    await demo<void>(page, "viewport.setSketches", [[]]);
    await demo<void>(page, "viewport.setGridVisible", [false]);
    await demo<void>(page, "viewport.setOriginVisible", [false]);
    const host = await hostSize(app);
    const expected = Math.min(host.width, host.height) / 6;
    const widths: number[] = [];
    for (const distance of [40, 300, 2500]) {
      await demo<void>(page, "viewport.setOriginPlanesVisible", [false]);
      await setView(page, topView(distance));
      await page.mouse.move(2, 2);
      const without = await shootHost(page);
      await demo<void>(page, "viewport.setOriginPlanesVisible", [true]);
      await idle(page);
      const withPlanes = await shootHost(page);
      const box = changedBox(without, withPlanes);
      if (!box) throw new Error(`the planes are not drawn at distance ${distance}`);
      widths.push(box.x1 - box.x0);
      expect(box.x1 - box.x0, `width at distance ${distance}`).toBeGreaterThan(expected * 0.85);
      expect(box.x1 - box.x0).toBeLessThan(expected * 1.15);
      expect(box.y1 - box.y0, `height at distance ${distance}`).toBeGreaterThan(expected * 0.85);
      expect(box.y1 - box.y0).toBeLessThan(expected * 1.15);
      // The pick area is the drawn area: the middle is the XY plane, a point twice the edge away is nothing.
      await demo<void>(page, "viewport.setPickKinds", [["plane"]]);
      const centre = await clientOf(page, [0, 0, 0]);
      expect((await demo<{ ref: { plane: string } } | null>(page, "viewport.pick", [centre.x + 3, centre.y + 3]))?.ref.plane).toBe("xy");
      expect(await demo<unknown>(page, "viewport.pick", [centre.x + expected * 0.9, centre.y])).toBeNull();
      await demo<void>(page, "viewport.setPickKinds", [null]);
    }
    test.info().annotations.push({ type: "plane edge on screen (px)", description: `expected ${expected.toFixed(1)}, measured ${widths.map((w) => w.toFixed(1)).join(", ")}` });
    noErrors(app);
  });

  test("they are much smaller than the model in the view: they never cover it", async ({ app }) => {
    const { page } = app;
    await openDemo(app, { panel: false });
    await page.mouse.move(2, 2);
    await demo<void>(page, "viewport.setOriginPlanesVisible", [false]);
    await demo<void>(page, "viewport.fitAll", [false]);
    await idle(page);
    const without = await shootHost(page);
    await demo<void>(page, "viewport.setOriginPlanesVisible", [true]);
    await idle(page);
    const withPlanes = await shootHost(page);
    const box = changedBox(without, withPlanes);
    if (!box) throw new Error("the planes are not drawn");
    const corners = await demo<{ x: number; y: number }[]>(page, "contentCorners");
    const contentWidth = Math.max(...corners.map((c) => c.x)) - Math.min(...corners.map((c) => c.x));
    test.info().annotations.push({ type: "planes against content (px)", description: `planes ${(box.x1 - box.x0).toFixed(0)} wide, content ${contentWidth.toFixed(0)} wide` });
    expect(box.x1 - box.x0, "the planes are a fraction of the content").toBeLessThan(contentWidth * 0.4);
    expect(box.y1 - box.y0).toBeLessThan(contentWidth * 0.4);
    noErrors(app);
  });

  test("content wins where it overlaps a plane: sketch lines and faces keep hover, the plane is hovered only on its own free area", async ({ app }) => {
    const { page } = app;
    await openDemo(app, { planes: true, panel: false });
    await demo<void>(page, "viewport.setPickKinds", [null]);
    // The sketch circle (z = 40, centre -25 0, radius 15) lies under the area of the XY plane when seen from above.
    await setView(page, topView(900));
    const onCircle = await clientOf(page, [-25, 15, 40]);
    await page.mouse.move(onCircle.x, onCircle.y);
    await expect(hoverText(app)).toHaveText("hover: sketch:profile:0");
    // From the right the YZ plane (x = 0) lies in front of the top face of the box: the face still wins.
    await setView(page, { target: [0, 0, 20], azimuth: HALF_PI, elevation: 0.5, distance: 900 });
    // Points on the box top where the pointer ray meets the YZ plane (x = 0, between the eye and the face) inside its area: the plane lies
    // in front of the face there. Wherever a face is under the pointer (looked at with the planes put away), the face is what is picked.
    let checked = 0;
    for (const [x, y] of [[-35, -18], [-30, 8], [-20, -8], [-15, 14], [-25, 2], [-10, -14], [-33, 20], [-12, -20], [-22, 20], [-28, -14], [-8, 4], [-18, 8]] as const) {
      const c = await clientOf(page, [x, y, 20]);
      await demo<void>(page, "viewport.setOriginPlanesVisible", [false]);
      const bare = await demo<{ ref: { kind: string } } | null>(page, "viewport.pick", [c.x, c.y]);
      await demo<void>(page, "viewport.setOriginPlanesVisible", [true]);
      if (bare?.ref.kind !== "face") continue; // a sketch line is there: it wins, as it should
      const onPlane = await demo<{ point: Vec3 } | null>(page, "viewport.pointOnPlane", [c.x, c.y, "yz"]);
      if (!onPlane || Math.max(Math.abs(onPlane.point[1]), Math.abs(onPlane.point[2])) > 44) continue;
      expect((await demo<{ ref: { kind: string } } | null>(page, "viewport.pick", [c.x, c.y]))?.ref.kind, `at ${x}, ${y}`).toBe("face");
      checked++;
    }
    expect(checked, "points where a plane lies in front of a face were looked at").toBeGreaterThanOrEqual(2);
    // Where nothing else is under the pointer the plane is there for itself: look for such a point on the YZ plane above the box.
    let free: { x: number; y: number } | null = null;
    for (const [y, z] of [[-20, 36], [20, 36], [-30, 30], [30, 30], [-10, 42], [10, 42], [0, 30], [-35, 24], [35, 24]] as const) {
      const c = await clientOf(page, [0, y, z]);
      const hit = await demo<{ ref: { kind: string; plane?: string } } | null>(page, "viewport.pick", [c.x, c.y]);
      if (hit?.ref.kind === "plane" && hit.ref.plane === "yz") { free = c; break; }
    }
    if (!free) throw new Error("no free point on the YZ plane");
    await page.mouse.move(free.x, free.y);
    await expect(hoverText(app)).toHaveText("hover: plane:yz");
    await page.mouse.click(free.x, free.y);
    await expect(page.getByTestId("viewport-selection")).toHaveText("selection: plane:yz");
    noErrors(app);
  });

  test("a profile under the plane area is hovered, and with only planes allowed the plane area is what can be chosen", async ({ app }) => {
    const { page } = app;
    await openExtrudeDemo(app, { distance: 0, panel: false });
    await demo<void>(page, "viewport.setOriginPlanesVisible", [true]);
    await demo<void>(page, "viewport.setPickKinds", [null]);
    await setView(page, { target: [0, 0, 20], azimuth: 0, elevation: HALF_PI, distance: 900 });
    const frame = await demo<{ x: number; y: number }>(page, "extrude.profilePoint", ["l1,l2,l3,l4|l5,l6,l7,l8"]);
    await page.mouse.move(frame.x, frame.y);
    await expect(page.getByTestId("viewport-hover")).toHaveText("hover: profile:s-top:l1,l2,l3,l4|l5,l6,l7,l8");
    // "Choose a plane": only planes are allowed. The middle of the view is a plane, a point far from the origin is nothing.
    await demo<void>(page, "viewport.setPickKinds", [["plane"]]);
    const centre = await clientOf(page, [0, 0, 0]);
    await page.mouse.move(centre.x + 3, centre.y + 3);
    await expect(page.getByTestId("viewport-hover")).toHaveText("hover: plane:xy");
    const far = await clientOf(page, [150, 150, 20]);
    await page.mouse.move(far.x, far.y);
    await expect(page.getByTestId("viewport-hover")).toHaveText("hover: none");
    noErrors(app);
  });
});

// --- origin axes: a quiet reference ----------------------------------------------------------------------------------

test.describe("origin axes", () => {
  const axisView: View = { target: [0, 0, 60], azimuth: 0.7, elevation: 0.5, distance: 200 };
  const clientOf = async (page: Page, p: Vec3): Promise<{ x: number; y: number }> => {
    const c = await demo<{ x: number; y: number } | null>(page, "viewport.worldToClient", [p]);
    if (!c) throw new Error(`no screen point for ${p.join(",")}`);
    return c;
  };
  type Shot = Awaited<ReturnType<typeof shootHost>>;
  /** How much the axis ink changes the pixels in a small window around a screen point: the largest colour difference to the shot without axes. */
  const ink = (withAxes: Shot, without: Shot, p: { x: number; y: number }, half = 2): number => {
    const at = withAxes.at(p);
    let best = 0;
    for (let dy = -half; dy <= half; dy++) for (let dx = -half; dx <= half; dx++) best = Math.max(best, colourDistance(pixelAt(withAxes.image, at.x + dx, at.y + dy), pixelAt(without.image, at.x + dx, at.y + dy)));
    return best;
  };
  const inkCount = (withAxes: Shot, without: Shot, p: { x: number; y: number }, half: number): number => {
    const at = withAxes.at(p);
    let n = 0;
    for (let dy = -half; dy <= half; dy++) for (let dx = -half; dx <= half; dx++) if (colourDistance(pixelAt(withAxes.image, at.x + dx, at.y + dy), pixelAt(without.image, at.x + dx, at.y + dy)) > 6) n++;
    return n;
  };

  for (const mode of ["light", "dark"] as const) {
    test(`the axes fade out with the distance from the origin and stay calm at rest (${mode})`, async ({ app }) => {
      const { page } = app;
      await openDemo(app, { mode, panel: false });
      // Nothing in front of the axes: they are looked at on their own.
      await demo<void>(page, "viewport.setBodies", [[]]);
      await demo<void>(page, "viewport.setSketches", [[]]);
      await setView(page, axisView);
      await page.mouse.move(2, 2);
      await demo<void>(page, "viewport.setOriginVisible", [true]);
      await idle(page);
      const withAxes = await shootHost(page);
      await demo<void>(page, "viewport.setOriginVisible", [false]);
      await idle(page);
      const without = await shootHost(page);
      // The Z axis above the box (z = 20 is the top of the box) and the X axis out to the left, past the box (x = -40).
      const zs = [28, 50, 80, 105, 125, 150];
      const zInks: number[] = [];
      for (const z of zs) zInks.push(ink(withAxes, without, await clientOf(page, [0, 0, z])));
      const xs = [-50, -70, -90, -110, -135];
      const xInks: number[] = [];
      for (const x of xs) xInks.push(ink(withAxes, without, await clientOf(page, [x, 0, 0])));
      test.info().annotations.push({ type: `axis ink (${mode})`, description: `Z at ${zs.join(",")}: ${zInks.join(",")}; X at ${xs.join(",")}: ${xInks.join(",")}` });
      // Near the origin the axis is there; at the end of the fade (0.4 x the view distance of 200 = 80 mm) nothing is left.
      expect(zInks[0]!, "Z axis near the origin").toBeGreaterThan(10);
      expect(zInks[zInks.length - 1]!, "Z axis far away: gone").toBeLessThanOrEqual(2);
      expect(zInks[zInks.length - 2]!, "Z axis beyond its fade: gone").toBeLessThanOrEqual(2);
      expect(zInks[1]!, "Z axis is fainter further out").toBeGreaterThan(zInks[3]!);
      expect(xInks[0]!, "X axis near the origin").toBeGreaterThan(8);
      expect(xInks[xInks.length - 1]!, "X axis far away: gone").toBeLessThanOrEqual(2);
      expect(xInks[0]!).toBeGreaterThan(xInks[3]!);
      noErrors(app);
    });
  }

  test("under the pointer an axis gets thicker and takes its full colour; away from it it is calm again", async ({ app }) => {
    const { page } = app;
    await openDemo(app, { mode: "light", panel: false });
    await demo<void>(page, "viewport.setBodies", [[]]);
    await demo<void>(page, "viewport.setSketches", [[]]);
    await setView(page, axisView);
    await demo<void>(page, "viewport.setOriginVisible", [false]);
    await page.mouse.move(2, 2);
    await idle(page);
    const without = await shootHost(page);
    await demo<void>(page, "viewport.setOriginVisible", [true]);
    await idle(page);
    const rest = await shootHost(page);
    const z = await clientOf(page, [0, 0, 40]);
    await page.mouse.move(z.x + 1, z.y);
    await idle(page);
    const hovered = await shootHost(page);
    const full = hexToRgb(getTheme("praezision").tokens.light.axisZ);
    const restInk = inkCount(rest, without, z, 10), hoverInk = inkCount(hovered, without, z, 10);
    test.info().annotations.push({ type: "axis ink pixels around the pointer", description: `rest ${restInk}, hovered ${hoverInk}` });
    expect(hoverInk, "thicker under the pointer").toBeGreaterThan(restInk * 1.4);
    // The colour in the middle of the line: full strength under the pointer, paler at rest (looked at along the line's centre).
    const centreColour = (shot: Shot) => {
      let best: Rgb = [255, 255, 255];
      let bestDistance = 999;
      const at = shot.at(z);
      for (let dx = -3; dx <= 3; dx++) {
        const px = pixelAt(shot.image, at.x + dx, at.y);
        const d = colourDistance(px, full);
        if (d < bestDistance) { bestDistance = d; best = px; }
      }
      return { best, bestDistance };
    };
    // Antialiasing leaves no pixel of a thin line at exactly its colour (more so in the software renderer of the browser image), so the
    // colour under the pointer is held to a distance, and to being clearly nearer to the full colour than the calm line is.
    const hoveredDistance = centreColour(hovered).bestDistance, restDistance = centreColour(rest).bestDistance;
    test.info().annotations.push({ type: "distance of the axis centre to its full colour", description: "hovered " + hoveredDistance + ", at rest " + restDistance });
    expect(hoveredDistance, "full colour under the pointer").toBeLessThan(70);
    expect(restDistance, "paler at rest").toBeGreaterThan(hoveredDistance + 15);
    await page.mouse.move(2, 2);
    await idle(page);
    const calm = await shootHost(page);
    expect(inkCount(calm, without, z, 10), "calm again after the pointer left").toBeLessThanOrEqual(restInk + 2);
    noErrors(app);
  });

  test("the grid toggle hides the axes with the grid, and showing the grid brings both back", async ({ app }) => {
    const { page } = app;
    await openDemo(app, { mode: "light", panel: false });
    await demo<void>(page, "viewport.setBodies", [[]]);
    await demo<void>(page, "viewport.setSketches", [[]]);
    await setView(page, axisView);
    await page.mouse.move(2, 2);
    const zPoint = await clientOf(page, [0, 0, 30]);
    const xPoint = await clientOf(page, [-55, 0, 0]);
    // What the axes add to the picture: the view with the origin shown against the view without it, at the same grid setting.
    const axisInk = async (p: { x: number; y: number }): Promise<number> => {
      await demo<void>(page, "viewport.setOriginVisible", [true]);
      await idle(page);
      const withAxes = await shootHost(page);
      await demo<void>(page, "viewport.setOriginVisible", [false]);
      await idle(page);
      const without = await shootHost(page);
      await demo<void>(page, "viewport.setOriginVisible", [true]);
      const at = withAxes.at(p);
      let best = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) best = Math.max(best, colourDistance(pixelAt(withAxes.image, at.x + dx, at.y + dy), pixelAt(without.image, at.x + dx, at.y + dy)));
      return best;
    };
    expect(await axisInk(zPoint), "Z axis drawn").toBeGreaterThan(8);
    expect(await axisInk(xPoint), "X axis drawn").toBeGreaterThan(6);
    await demo<void>(page, "viewport.setGridVisible", [false]);
    expect(await axisInk(zPoint), "no Z axis without the grid").toBeLessThanOrEqual(2);
    expect(await axisInk(xPoint), "no X axis without the grid").toBeLessThanOrEqual(2);
    await demo<void>(page, "viewport.setGridVisible", [true]);
    expect(await axisInk(zPoint), "Z axis back with the grid").toBeGreaterThan(8);
    expect(await axisInk(xPoint), "X axis back with the grid").toBeGreaterThan(6);
    noErrors(app);
  });
});
