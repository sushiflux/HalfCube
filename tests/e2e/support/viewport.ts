// Helpers of the 3D view specs: open the demo page, talk to it through window.__viewportDemo (see app/src/dev/viewport-demo.tsx)
// and look at the pixels it drew.
import type { Page } from "@playwright/test";
import type { AppUnderTest } from "./fixtures.ts";
import { decodePng, type Image } from "./png.ts";

export type Vec3 = [number, number, number];

export interface View {
  target: Vec3;
  azimuth: number;
  elevation: number;
  distance: number;
}

/** What the demo reports after moving the pointer over a sketch (window.__viewportDemo.measureSketchHover). */
export interface SketchHoverMeasurement {
  moves: number;
  curves: number;
  pickMeanMs: number;
  pickMaxMs: number;
  frameMeanMs: number;
  frameP95Ms: number;
  frameMaxMs: number;
  cpuMeanMs: number;
  hits: number;
}

export type Ref =
  | { kind: "plane"; plane: "xy" | "xz" | "yz" }
  | { kind: "face"; bodyId: string; faceId: number }
  | { kind: "edge"; bodyId: string; edgeId: number }
  | { kind: "sketch"; sketchId: string; entityId: number }
  | { kind: "profile"; sketchId: string; regionId: string };

/** What the demo reports after a run of mouse-wheel notches (window.__viewportDemo.measureWheel). */
export interface WheelMeasurement {
  notches: number;
  rafFrames: number;
  rafMeanMs: number;
  rafP95Ms: number;
  rafMaxMs: number;
  rafOver25: number;
  drawnFrames: number;
  cpuMeanMs: number;
  cpuMaxMs: number;
  distanceBefore: number;
  distanceAfter: number;
}

export interface Measurement {
  frames: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
  meanCpuMs: number;
}

/**
 * Calls a method (or reads a property) of the demo page handle, window.__viewportDemo, by its dotted path, for example
 * "viewport.getView" or "measureOrbit". The result must be serialisable. (No string evaluation: the security policy of the
 * page forbids it, like in the product.)
 */
export function demo<T>(page: Page, path: string, args: unknown[] = []): Promise<T> {
  return page.evaluate(
    ([p, a]) => {
      let owner: unknown = undefined;
      let value: unknown = (window as unknown as { __viewportDemo: unknown }).__viewportDemo;
      for (const part of String(p).split(".")) {
        owner = value;
        value = (value as Record<string, unknown>)[part];
      }
      return typeof value === "function" ? (value as (...x: unknown[]) => unknown).apply(owner, a) : value;
    },
    [path, args] as const,
  ) as Promise<T>;
}

export interface DemoOptions {
  lang?: "de" | "en";
  renderer?: "auto" | "webgl2";
  planes?: boolean;
  preset?: "mouse" | "touchpad";
  labels?: "views" | "xyz";
  theme?: string;
  mode?: "light" | "dark";
  /** false hides the demo's own control panel (the 3D view then shows nothing but the scene, the navigator and the info box). */
  panel?: boolean;
}

export async function openDemo(app: AppUnderTest, options: DemoOptions = {}): Promise<void> {
  const q = new URLSearchParams({ demo: "viewport", lang: options.lang ?? "en" });
  if (options.renderer) q.set("renderer", options.renderer);
  if (options.planes) q.set("planes", "1");
  if (options.preset) q.set("preset", options.preset);
  if (options.labels) q.set("labels", options.labels);
  if (options.theme) q.set("theme", options.theme);
  if (options.mode) q.set("mode", options.mode);
  if (options.panel === false) q.set("panel", "0");
  await app.open(`?${q.toString()}`);
  await app.page.waitForFunction(() => (window as unknown as { __viewportDemo?: unknown }).__viewportDemo !== undefined, undefined, { timeout: 60_000 });
  await idle(app.page);
}

export const idle = (page: Page): Promise<void> => demo<void>(page, "viewport.whenIdle");
export const getView = (page: Page): Promise<View> => demo<View>(page, "viewport.getView");
export const setView = async (page: Page, view: View): Promise<void> => {
  await demo<void>(page, "viewport.setView", [view, false]);
  await idle(page);
};
export const renderCount = (page: Page): Promise<number> => demo<number>(page, "viewport.renderCount");
export const clientPointOf = (page: Page, ref: Ref): Promise<{ x: number; y: number } | null> => demo(page, "clientPointOf", [ref]);

export interface HostShot {
  image: Image;
  /** Device pixels per CSS pixel of the screenshot. */
  scale: number;
  /** The view's position on the page, CSS pixels. */
  box: { x: number; y: number; width: number; height: number };
  /** A client point (CSS pixels) in the image's pixels. */
  at(point: { x: number; y: number }): { x: number; y: number };
}

/** Screenshot of the 3D view (the canvas area with the overlays on it), decoded. */
export async function shootHost(page: Page): Promise<HostShot> {
  const host = page.getByTestId("viewport-host");
  const box = await host.boundingBox();
  if (!box) throw new Error("The 3D view is not on the page.");
  const image = decodePng(await host.screenshot({ animations: "disabled" }));
  const scale = image.width / box.width;
  return { image, scale, box, at: (p) => ({ x: (p.x - box.x) * scale, y: (p.y - box.y) * scale }) };
}

/** True when the element at this page point is the 3D view's canvas (nothing overlaps it). */
export function isOverCanvas(page: Page, point: { x: number; y: number }): Promise<boolean> {
  return page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.hasAttribute("data-viewport-canvas") ?? false, point);
}

export const backendOf = async (page: Page): Promise<"WebGPU" | "WebGL2"> => {
  const b = await page.getByTestId("viewport-backend").getAttribute("data-backend");
  if (b !== "WebGPU" && b !== "WebGL2") throw new Error(`The 3D view reports no backend: "${b}".`);
  return b;
};

export interface SketchDemoOptions extends DemoOptions {
  /** gallery: every state with dimensions and a tool preview; states: calibration lines and points; stress: 200 curves. */
  scene?: "gallery" | "states" | "stress";
  plane?: "xy" | "xz" | "yz";
  highlight?: "band" | "fill";
  colour?: "green" | "blue";
}

/** Opens the demo in sketch mode (the sketch layer with its own sample sketches; the demo's own controls are hidden). */
export async function openSketchDemo(app: AppUnderTest, options: SketchDemoOptions = {}): Promise<void> {
  const q = new URLSearchParams({ demo: "viewport", sketch: "1", panel: "0", lang: options.lang ?? "en" });
  for (const key of ["renderer", "scene", "plane", "highlight", "colour", "theme", "mode"] as const) {
    const v = options[key];
    if (v) q.set(key, v);
  }
  await app.open(`?${q.toString()}`);
  await app.page.waitForFunction(() => (window as unknown as { __viewportDemo?: { sketchLayer?: unknown } }).__viewportDemo?.sketchLayer !== undefined, undefined, { timeout: 60_000 });
  await app.page.evaluate(() => (window as unknown as { __viewportDemo: { viewport: { setGridVisible(v: boolean): void } } }).__viewportDemo.viewport.setGridVisible(true));
  await idle(app.page);
}

/** Client coordinates of the sketch point (u, v). */
export const sketchPoint = (page: Page, u: number, v: number): Promise<{ x: number; y: number }> => demo(page, "sketchPoint", [u, v]);

/** Test hooks of the extrude demo (see ExtrudeDemoHandle in app/src/dev/viewport-demo.tsx). */
export interface ExtrudeEvent {
  distance: number;
  phase: "start" | "move" | "end";
}

export interface ExtrudeDemoOptions extends DemoOptions {
  /** Start value of the arrow, mm. */
  distance?: number;
}

/** Opens the demo in extrude mode: two pickable profiles, the drag arrow and the preview body that follows its distance. */
export async function openExtrudeDemo(app: AppUnderTest, options: ExtrudeDemoOptions = {}): Promise<void> {
  const q = new URLSearchParams({ demo: "viewport", extrude: "1", lang: options.lang ?? "en" });
  for (const key of ["renderer", "theme", "mode"] as const) {
    const v = options[key];
    if (v) q.set(key, v);
  }
  if (options.distance !== undefined) q.set("distance", String(options.distance));
  if (options.panel === false) q.set("panel", "0");
  await app.open(`?${q.toString()}`);
  await app.page.waitForFunction(() => (window as unknown as { __viewportDemo?: { extrude?: unknown } }).__viewportDemo?.extrude !== undefined, undefined, { timeout: 60_000 });
  await idle(app.page);
}

/** The profiles of the sample: the frame with a hole, and the disc. */
export const frameRegion = "l1,l2,l3,l4|l5,l6,l7,l8";
export const discRegion = "c9";
