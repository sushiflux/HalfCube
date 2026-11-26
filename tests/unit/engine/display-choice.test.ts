import { describe, expect, it } from "vitest";
import { chooseDisplay, parseDisplayTarget, sameRect, windowRectOn, type DisplayInfo } from "../../../desktop/src/display-choice.ts";

/** A display from its position and size in device-independent pixels and its scale factor; the work area is 40 px shorter. */
function display(id: number, x: number, y: number, width: number, height: number, scaleFactor = 1): DisplayInfo {
  return { id, bounds: { x, y, width, height }, workArea: { x, y, width, height: height - 40 }, scaleFactor };
}

// Three 4K screens: primary 150 % (2560x1440), landscape 150 % to its right, portrait 200 % (1080x1920) to the left.
const primary = display(1, 0, 0, 2560, 1440, 1.5);
const landscape = display(2, 2560, 0, 2560, 1440, 1.5);
const portrait = display(3, -1080, 0, 1080, 1920, 2);

describe("parseDisplayTarget", () => {
  it("accepts primary and secondary, treats unset and empty as not set, rejects anything else", () => {
    expect(parseDisplayTarget("primary")).toBe("primary");
    expect(parseDisplayTarget("secondary")).toBe("secondary");
    expect(parseDisplayTarget(undefined)).toBeUndefined();
    expect(parseDisplayTarget("")).toBeUndefined();
    expect(parseDisplayTarget("third")).toBeNull();
    expect(parseDisplayTarget("Secondary")).toBeNull();
  });
});

describe("chooseDisplay", () => {
  it("secondary: a landscape display wins over a portrait one, whatever the order", () => {
    expect(chooseDisplay([primary, portrait, landscape], 1, "secondary")?.id).toBe(2);
    expect(chooseDisplay([portrait, landscape, primary], 1, "secondary")?.id).toBe(2);
  });

  it("secondary: only a portrait display besides the primary one is still taken", () => {
    expect(chooseDisplay([primary, portrait], 1, "secondary")?.id).toBe(3);
  });

  it("secondary: among landscape displays the largest physical area wins", () => {
    const small = display(4, 2560, 0, 1920, 1080, 1);
    const bigScaled = display(5, 4480, 0, 1920, 1080, 2); // 3840x2160 physical, more than the 1920x1080 one
    expect(chooseDisplay([primary, small, bigScaled], 1, "secondary")?.id).toBe(5);
    expect(chooseDisplay([primary, bigScaled, small], 1, "secondary")?.id).toBe(5);
  });

  it("secondary: equal landscape displays pick the one nearest to the primary, then the lowest id", () => {
    const near = display(7, 2560, 0, 2560, 1440, 1.5);
    const far = display(6, 5120, 0, 2560, 1440, 1.5);
    expect(chooseDisplay([primary, far, near], 1, "secondary")?.id).toBe(7);
    const twinA = display(8, 2560, 1440, 2560, 1440, 1.5);
    const twinB = display(9, 2560, -1440, 2560, 1440, 1.5); // same distance to the primary as twinA
    expect(chooseDisplay([primary, twinB, twinA], 1, "secondary")?.id).toBe(8);
  });

  it("secondary: the primary display is never chosen when another exists, wherever it sits in the list", () => {
    const biggerPrimary = display(1, 0, 0, 3840, 2160, 1);
    expect(chooseDisplay([biggerPrimary, landscape], 1, "secondary")?.id).toBe(2);
    expect(chooseDisplay([landscape, biggerPrimary], 1, "secondary")?.id).toBe(2);
  });

  it("secondary with a single display falls back to the primary one", () => {
    expect(chooseDisplay([primary], 1, "secondary")?.id).toBe(1);
  });

  it("primary: always the primary display, even when others exist", () => {
    expect(chooseDisplay([landscape, primary, portrait], 1, "primary")?.id).toBe(1);
  });

  it("an unknown primary id falls back to the first display; an empty list gives nothing", () => {
    expect(chooseDisplay([landscape, portrait], 99, "primary")?.id).toBe(2);
    expect(chooseDisplay([], 1, "secondary")).toBeUndefined();
  });
});

describe("windowRectOn", () => {
  it("keeps the wanted size when it fits and centres it in the work area", () => {
    const r = windowRectOn(landscape, { width: 1440, height: 900 });
    expect(r).toEqual({ x: 2560 + (2560 - 1440) / 2, y: (1400 - 900) / 2, width: 1440, height: 900 });
  });

  it("shrinks to the work area minus a 6 % margin per side when it does not fit", () => {
    const small = display(4, 1920, 100, 1280, 800, 1); // work area 1280x760
    const r = windowRectOn(small, { width: 1440, height: 900 });
    expect(r.width).toBe(1280 - 2 * 77);
    expect(r.height).toBe(760 - 2 * 46);
    expect(r.x).toBe(1920 + 77);
    expect(r.y).toBe(100 + 46);
  });

  it("stays inside a work area that does not start at the origin", () => {
    const r = windowRectOn(portrait, { width: 1440, height: 900 });
    expect(r.x).toBeGreaterThanOrEqual(portrait.workArea.x);
    expect(r.x + r.width).toBeLessThanOrEqual(portrait.workArea.x + portrait.workArea.width);
    expect(r.y + r.height).toBeLessThanOrEqual(portrait.workArea.y + portrait.workArea.height);
  });
});

describe("sameRect", () => {
  it("allows a rounding difference of 2 pixels and nothing more", () => {
    const a = { x: 10, y: 10, width: 100, height: 100 };
    expect(sameRect(a, { x: 12, y: 8, width: 102, height: 98 })).toBe(true);
    expect(sameRect(a, { x: 13, y: 10, width: 100, height: 100 })).toBe(false);
  });
});
