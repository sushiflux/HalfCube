// Mouse and touchpad navigation presets: which input turns, moves or zooms the view. Pure functions, no DOM.
//
//   mouse     middle button drag = pan, Shift + middle button drag = orbit, wheel = zoom towards the cursor
//   touchpad  two-finger scroll = orbit, Shift + two-finger scroll = pan, pinch (arrives as Ctrl + wheel) = zoom
// Both presets also have Alt + left drag = orbit and Alt + Shift + left drag = pan, for a mouse without a middle button.
// The plain left button is never a navigation input: it picks, and later it sketches.

export type NavigationPreset = "mouse" | "touchpad";
export const navigationPresets: readonly NavigationPreset[] = ["mouse", "touchpad"];
export type NavigationAction = "orbit" | "pan" | "zoom";

export interface Modifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

/** What a pointer drag with this button does, or null when it is not a navigation drag. */
export function classifyPointerDrag(_preset: NavigationPreset, button: number, mods: Modifiers): "orbit" | "pan" | null {
  if (button === 1) return mods.shift ? "orbit" : "pan";
  if (button === 0 && mods.alt) return mods.shift ? "pan" : "orbit";
  return null;
}

/** What a wheel event does. A pinch on a touchpad arrives as a wheel event with Ctrl pressed. */
export function classifyWheel(preset: NavigationPreset, mods: Modifiers): NavigationAction {
  if (mods.ctrl) return "zoom";
  if (preset === "mouse") return "zoom";
  return mods.shift ? "pan" : "orbit";
}

/** Wheel deltas arrive in pixels, lines or pages depending on the device; this makes them pixels. */
export function wheelDeltaInPixels(delta: number, deltaMode: number, pagePx: number): number {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * pagePx;
  return delta;
}

const MIN_WHEEL_FACTOR = 0.8;
const MAX_WHEEL_FACTOR = 1.25;

/** Which way the mouse wheel zooms: "down-out" = wheel down zooms out (default), "down-in" = wheel down zooms in. */
export type WheelZoomDirection = "down-out" | "down-in";
export const wheelZoomDirections: readonly WheelZoomDirection[] = ["down-out", "down-in"];

/**
 * The distance factor of one wheel event (< 1 zooms in). By default a scroll down (positive delta) zooms out; with direction
 * "down-in" it zooms in. A pinch (Ctrl + wheel) always keeps its own direction: it is not a mouse wheel. A pinch sends many
 * small events, so it uses a larger gain; one event never changes the distance by more than a quarter.
 */
export function wheelZoomFactor(deltaPx: number, pinch: boolean, direction: WheelZoomDirection = "down-out"): number {
  const gain = pinch ? 0.008 : 0.0015;
  const sign = !pinch && direction === "down-in" ? -1 : 1;
  return Math.min(MAX_WHEEL_FACTOR, Math.max(MIN_WHEEL_FACTOR, Math.exp(sign * deltaPx * gain)));
}

/** Time constant of the wheel zoom easing, ms: about 95 % of a notch is done after three of them (120 ms). */
export const ZOOM_EASE_TAU_MS = 40;
/** A frame that took longer than this counts as this long (a tab in the background must not make the view jump). */
const MAX_EASE_STEP_MS = 50;

/**
 * One frame of the wheel zoom easing. `pendingLn` is the natural logarithm of the distance factor that still has to be applied
 * (notches add their own logarithm to it, so quick notches accumulate). Returns how much of it to apply in this frame of `dtMs`
 * and what is left. The decay is exponential, so the result does not depend on the frame rate: two frames of 8 ms apply the
 * same as one of 16 ms. A remainder too small to see is applied at once, so the easing ends.
 */
export function zoomEaseStep(pendingLn: number, dtMs: number, tauMs = ZOOM_EASE_TAU_MS): { apply: number; remaining: number } {
  if (pendingLn === 0) return { apply: 0, remaining: 0 };
  const dt = Math.min(MAX_EASE_STEP_MS, Math.max(0, dtMs));
  const apply = pendingLn * (1 - Math.exp(-dt / tauMs));
  const remaining = pendingLn - apply;
  if (Math.abs(remaining) < 1e-4) return { apply: pendingLn, remaining: 0 };
  return { apply, remaining };
}
