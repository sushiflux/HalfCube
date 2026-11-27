// The thin minor lines of the ground grid must be unbroken along their whole length, also in a tilted view, zoomed in, and at
// the device pixel ratios of real monitors (1, 1.75 = a 175 % display, 2). The bug this guards against: the grid's alpha blend
// also wrote the canvas alpha, so under every line pixel the canvas became translucent and the page behind it showed through. The
// soft edge of a thin line then all but vanished and the line broke into dots and dashes, strongest at shallow angles. Runs in the
// Electron program, on the default backend (WebGPU where there is one) and on the WebGL2 fallback.
import { DEFAULT_FOV_Y, pixelsPerWorld } from "../../../app/src/viewport/camera.ts";
import { gridLevels } from "../../../app/src/viewport/grid-math.ts";
import { getTheme } from "../../../app/src/theme/themes.ts";
import type { CDPSession, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures.ts";
import { decodePng, hexToRgb } from "../support/png.ts";
import { measureLine, MIN_RATIO } from "../support/line-ink.ts";
import { backendOf, demo, openDemo, setView, type HostShot, type View } from "../support/viewport.ts";

const light = getTheme("praezision").tokens.light;

const views: [string, View][] = [
  ["zoomed in, gently tilted", { target: [0, 0, 0], azimuth: 0.1, elevation: 0.35, distance: 120 }],
  ["tilted at a shallow angle", { target: [0, 0, 0], azimuth: 0.25, elevation: 0.2, distance: 300 }],
];

for (const renderer of ["auto", "webgl2"] as const) {
  for (const ratio of [1, 1.75, 2]) {
    test(`a minor line of a tilted grid has no gaps along its length (device pixel ratio ${ratio}, ${renderer === "auto" ? "default backend" : "WebGL2"})`, async ({ app }) => {
      test.setTimeout(120_000);
      const { page } = app;
      // The ratio is set before the page loads: the 3D view takes it at start. Cleared again in the end: the Electron window is shared.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: ratio, mobile: false });
      try {
        await openDemo(app, { panel: false, renderer });
        if (renderer === "webgl2") expect(await backendOf(page)).toBe("WebGL2");
        expect(await page.evaluate(() => window.devicePixelRatio), "the emulated device pixel ratio").toBeCloseTo(ratio, 5);
        // Nothing but the grid and the axes.
        await demo<void>(page, "viewport.setBodies", [[]]);
        await demo<void>(page, "viewport.setSketches", [[]]);
        await demo<void>(page, "viewport.setPreview", [null]);
        const background = hexToRgb(light.viewport);

        for (const [viewName, view] of views) {
          await setView(page, view);
          const shot = await shootHostInDevicePixels(page, cdp);
          expect(shot.scale, "the screenshot is in device pixels of the emulated ratio").toBeCloseTo(ratio, 1);
          const lens = { fovY: DEFAULT_FOV_Y, width: shot.box.width, height: shot.box.height };
          // The finest level that is fully there and has coarser lines in it: its lines at odd multiples belong to it alone.
          const level = gridLevels(pixelsPerWorld(lens, view.distance)).find((l) => l.opacity >= 0.99 && l.coarser > 0);
          if (!level) throw new Error("The view shows no minor level.");

          // Two lines on the near side of the view, odd multiples that no coarser level draws (a far line fades with the distance, which is no gap).
          for (const k of [-3, -7]) {
            const c = k * level.spacing;
            // Where the line (the grid line y = c, parallel to X) and the lines that cross it (x = j * spacing) are on the page.
            const probe = await page.evaluate(
              ([cc, spacing, extent]) => {
                const viewport = (window as unknown as { __viewportDemo: { viewport: { worldToClient(p: [number, number, number]): { x: number; y: number } | null } } }).__viewportDemo.viewport;
                const crossings: number[] = [];
                for (let j = -Math.ceil(extent! / spacing!); j <= Math.ceil(extent! / spacing!); j++) {
                  const p = viewport.worldToClient([j * spacing!, cc!, 0]);
                  if (p) crossings.push(p.x);
                }
                return { a: viewport.worldToClient([-extent!, cc!, 0]), b: viewport.worldToClient([extent!, cc!, 0]), crossings };
              },
              [c, level.spacing, 2 * view.distance],
            );
            if (!probe.a || !probe.b) throw new Error(`The line y = ${c} is not in front of the camera.`);
            const slope = (probe.b.y - probe.a.y) / (probe.b.x - probe.a.x);
            expect(Math.abs(slope), "a line the column measurement can follow").toBeLessThan(0.2);

            const m = measureLine(shot, probe.a, probe.b, probe.crossings, background);
            test.info().annotations.push({
              type: `${viewName}, y = ${c} mm, ratio ${ratio}`,
              description: `median ink ${m.median.toFixed(0)}, worst column ${(m.worst * 100).toFixed(0)} % of its neighbours, ${m.gaps} gap columns of ${m.inks.length}`,
            });
            expect(m.inks.length, `columns measured on ${viewName}, y = ${c}`).toBeGreaterThan(150 * ratio);
            // A visible line: the broken one reached about a quarter of this.
            expect(m.median, `the minor line is there (${viewName}, y = ${c})`).toBeGreaterThan(120);
            expect(m.gaps, `columns below ${MIN_RATIO * 100} % of their neighbours in the minor line y = ${c} (${viewName}); worst ${(m.worst * 100).toFixed(0)} %`).toBe(0);
          }
        }
        expect(app.errors, "no console errors").toEqual([]);
      } finally {
        await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
        await cdp.detach().catch(() => undefined);
      }
    });
  }
}

/**
 * The 3D view as the page shows it, in device pixels of the emulated ratio. Playwright's own screenshot would scale the picture
 * to the ratio it knows (the real display's), which resamples the lines and hides what is measured.
 */
async function shootHostInDevicePixels(page: Page, cdp: CDPSession): Promise<Pick<HostShot, "image" | "scale" | "box">> {
  const box = await page.getByTestId("viewport-host").boundingBox();
  if (!box) throw new Error("The 3D view is not on the page.");
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 } });
  const image = decodePng(Buffer.from(data, "base64"));
  return { image, scale: image.width / box.width, box };
}
