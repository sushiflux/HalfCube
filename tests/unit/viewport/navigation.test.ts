import { describe, expect, it } from "vitest";
import { classifyPointerDrag, classifyWheel, wheelDeltaInPixels, wheelZoomFactor, ZOOM_EASE_TAU_MS, zoomEaseStep } from "../../../app/src/viewport/navigation.ts";

const none = { shift: false, ctrl: false, alt: false };

describe("pointer drags", () => {
  it("middle button pans, Shift + middle button orbits (both presets)", () => {
    for (const preset of ["mouse", "touchpad"] as const) {
      expect(classifyPointerDrag(preset, 1, none)).toBe("pan");
      expect(classifyPointerDrag(preset, 1, { ...none, shift: true })).toBe("orbit");
    }
  });

  it("Alt + left button orbits, Alt + Shift + left button pans; the plain left button navigates nothing", () => {
    expect(classifyPointerDrag("mouse", 0, { ...none, alt: true })).toBe("orbit");
    expect(classifyPointerDrag("mouse", 0, { ...none, alt: true, shift: true })).toBe("pan");
    expect(classifyPointerDrag("mouse", 0, none)).toBeNull();
    expect(classifyPointerDrag("mouse", 0, { ...none, shift: true })).toBeNull();
  });

  it("the right button is left alone (it will open the marking menu)", () => {
    expect(classifyPointerDrag("mouse", 2, none)).toBeNull();
  });
});

describe("wheel", () => {
  it("the mouse wheel zooms", () => {
    expect(classifyWheel("mouse", none)).toBe("zoom");
    expect(classifyWheel("mouse", { ...none, shift: true })).toBe("zoom");
  });

  it("on a touchpad two-finger scroll orbits, Shift pans and a pinch (Ctrl + wheel) zooms", () => {
    expect(classifyWheel("touchpad", none)).toBe("orbit");
    expect(classifyWheel("touchpad", { ...none, shift: true })).toBe("pan");
    expect(classifyWheel("touchpad", { ...none, ctrl: true })).toBe("zoom");
    expect(classifyWheel("mouse", { ...none, ctrl: true })).toBe("zoom");
  });

  it("normalises line and page deltas to pixels", () => {
    expect(wheelDeltaInPixels(3, 0, 800)).toBe(3);
    expect(wheelDeltaInPixels(3, 1, 800)).toBe(48);
    expect(wheelDeltaInPixels(1, 2, 800)).toBe(800);
  });

  it("scrolling down zooms out, up zooms in, and one event never changes the distance by more than a quarter", () => {
    expect(wheelZoomFactor(100, false)).toBeGreaterThan(1);
    expect(wheelZoomFactor(-100, false)).toBeLessThan(1);
    expect(wheelZoomFactor(100000, false)).toBe(1.25);
    expect(wheelZoomFactor(-100000, true)).toBe(0.8);
    expect(wheelZoomFactor(0, false)).toBe(1);
  });

  it("zooming in and out by the same amount cancels (before clamping)", () => {
    expect(wheelZoomFactor(40, false) * wheelZoomFactor(-40, false)).toBeCloseTo(1, 12);
  });

  it("the direction setting turns the mouse wheel around and leaves a pinch alone", () => {
    expect(wheelZoomFactor(100, false, "down-out")).toBe(wheelZoomFactor(100, false));
    expect(wheelZoomFactor(100, false, "down-in")).toBeLessThan(1);
    expect(wheelZoomFactor(-100, false, "down-in")).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, false, "down-in")).toBeCloseTo(1 / wheelZoomFactor(100, false, "down-out"), 12);
    expect(wheelZoomFactor(100000, false, "down-in")).toBe(0.8);
    expect(wheelZoomFactor(-100000, false, "down-in")).toBe(1.25);
    // Ctrl + wheel is how a touchpad pinch arrives: it keeps its own direction in both settings.
    expect(wheelZoomFactor(10, true, "down-in")).toBe(wheelZoomFactor(10, true, "down-out"));
    expect(wheelZoomFactor(10, true, "down-in")).toBeGreaterThan(1);
  });
});

describe("wheel zoom easing", () => {
  /** Runs the easing to its end at a fixed frame time and returns what was applied per frame. */
  function run(pending: number, frameMs: number): number[] {
    const applied: number[] = [];
    let left = pending;
    for (let i = 0; i < 1000 && left !== 0; i++) {
      const step = zoomEaseStep(left, frameMs);
      applied.push(step.apply);
      left = step.remaining;
    }
    return applied;
  }

  it("applies everything that was asked for, never more", () => {
    for (const pending of [0.15, -0.22, 1.5]) {
      for (const frameMs of [4, 8.33, 16.7, 33]) {
        const applied = run(pending, frameMs);
        expect(applied.reduce((a, b) => a + b, 0)).toBeCloseTo(pending, 12);
        expect(applied.every((a) => Math.sign(a) === Math.sign(pending))).toBe(true);
      }
    }
  });

  it("is mostly done after about 120 ms and has finished by 200 ms, at any frame rate", () => {
    for (const frameMs of [4.17, 8.33, 16.7]) {
      let left = 0.2;
      let t = 0;
      let t95 = -1;
      while (left !== 0 && t < 1000) {
        left = zoomEaseStep(left, frameMs).remaining;
        t += frameMs;
        if (t95 < 0 && Math.abs(left) <= 0.2 * 0.05) t95 = t;
      }
      expect(t95).toBeGreaterThan(90);
      expect(t95).toBeLessThan(150);
      expect(t).toBeLessThan(400);
    }
  });

  it("does not depend on the frame rate: two short frames equal one long frame", () => {
    const one = zoomEaseStep(0.2, 16);
    const a = zoomEaseStep(0.2, 8);
    const b = zoomEaseStep(a.remaining, 8);
    expect(a.apply + b.apply).toBeCloseTo(one.apply, 12);
    expect(b.remaining).toBeCloseTo(one.remaining, 12);
  });

  it("moves in every frame and starts with a fraction, not a jump", () => {
    const first = zoomEaseStep(Math.log(1.25), 8.33);
    expect(first.apply).toBeGreaterThan(0);
    expect(first.apply).toBeLessThan(Math.log(1.25) * 0.25);
    expect(first.remaining).toBeCloseTo(Math.log(1.25) - first.apply, 12);
  });

  it("notches that arrive while it runs add up", () => {
    // Two notches 50 ms apart end at the same place as the logarithms added, and a third one on top keeps going the same way.
    let left = Math.log(1.16);
    let total = 0;
    for (let ms = 0; ms < 50; ms += 10) {
      const step = zoomEaseStep(left, 10);
      total += step.apply;
      left = step.remaining;
    }
    left += Math.log(1.16);
    while (left !== 0) {
      const step = zoomEaseStep(left, 10);
      total += step.apply;
      left = step.remaining;
    }
    expect(Math.exp(total)).toBeCloseTo(1.16 * 1.16, 10);
  });

  it("a frame that took very long (a hidden tab) counts as at most 50 ms", () => {
    expect(zoomEaseStep(0.2, 5000)).toEqual(zoomEaseStep(0.2, 50));
    expect(zoomEaseStep(0.2, -10).apply).toBe(0);
    expect(zoomEaseStep(0, 16)).toEqual({ apply: 0, remaining: 0 });
    expect(ZOOM_EASE_TAU_MS).toBeGreaterThan(0);
  });

  it("ends: a remainder too small to see is applied at once", () => {
    const step = zoomEaseStep(5e-5, 1);
    expect(step).toEqual({ apply: 5e-5, remaining: 0 });
  });
});
