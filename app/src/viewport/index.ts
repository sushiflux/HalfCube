// The 3D view as a self-contained module. The rest of the app uses only this file: the Viewport interface, the data types
// the scene is described with, and createViewport. three.js is loaded on demand, behind the interface.
import type { Viewport, ViewportOptions } from "./types.ts";

export type { AxisKey, StandardViewName, ViewState } from "./camera.ts";
export type { Modifiers, NavigationPreset, WheelZoomDirection } from "./navigation.ts";
export { navigationPresets, wheelZoomDirections } from "./navigation.ts";
export type { LineKind, LineStyle, ViewportStyle } from "./style.ts";
export { lineKinds, styleFromTheme } from "./style.ts";
export * from "./types.ts";

/** Creates the viewport inside the host element (a canvas is added to it). Rejects when neither WebGPU nor WebGL2 works. */
export async function createViewport(host: HTMLElement, options: ViewportOptions): Promise<Viewport> {
  const { createThreeViewport } = await import("./three-viewport.ts");
  return createThreeViewport(host, options);
}
export * from "./sketch/types.ts";
