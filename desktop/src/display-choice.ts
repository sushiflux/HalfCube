// Picks the display a window is placed on and computes the window rectangle there. Pure functions without any Electron
// import, so they are unit-tested directly (tests/unit/engine/display-choice.test.ts). Used only when the environment
// variable HALFCUBE_WINDOW_DISPLAY is set (see main.ts); without it the operating system decides where windows open.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The parts of Electron's `Display` this module needs (all in device-independent pixels, scale factor separate). */
export interface DisplayInfo {
  id: number;
  bounds: Rect;
  workArea: Rect;
  scaleFactor: number;
}

export type DisplayTarget = "primary" | "secondary";

/** Parses the value of HALFCUBE_WINDOW_DISPLAY: `undefined` when unset, `null` when the value is not allowed. */
export function parseDisplayTarget(raw: string | undefined): DisplayTarget | undefined | null {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "primary" || raw === "secondary") return raw;
  return null;
}

const isLandscape = (d: DisplayInfo) => d.bounds.width >= d.bounds.height;
// Physical pixels: a 4K screen at 200 % and one at 150 % are the same size in reality.
const physicalArea = (d: DisplayInfo) => d.bounds.width * d.scaleFactor * (d.bounds.height * d.scaleFactor);
const centre = (d: DisplayInfo) => ({ x: d.bounds.x + d.bounds.width / 2, y: d.bounds.y + d.bounds.height / 2 });

/**
 * "primary": the primary display. "secondary": among the displays that are not the primary one, landscape ones first,
 * then the largest area, then the one whose centre is nearest to the primary display's centre, then the lowest id.
 * With only one display (or no primary among the given ones and nothing else), the primary display is the fallback.
 * Returns undefined only when the list is empty.
 */
export function chooseDisplay(displays: readonly DisplayInfo[], primaryId: number, target: DisplayTarget): DisplayInfo | undefined {
  const primary = displays.find((d) => d.id === primaryId) ?? displays[0];
  if (!primary || target === "primary") return primary;
  const others = displays.filter((d) => d.id !== primary.id);
  if (others.length === 0) return primary;
  const origin = centre(primary);
  const distance = (d: DisplayInfo) => Math.abs(centre(d).x - origin.x) + Math.abs(centre(d).y - origin.y);
  return [...others].sort(
    (a, b) =>
      Number(!isLandscape(a)) - Number(!isLandscape(b)) ||
      physicalArea(b) - physicalArea(a) ||
      distance(a) - distance(b) ||
      a.id - b.id,
  )[0];
}

/**
 * The window rectangle centred in the display's work area: the wanted size when it fits, otherwise the work area minus
 * a margin of 6 % per side. The result is always inside the work area.
 */
export function windowRectOn(display: DisplayInfo, wanted: { width: number; height: number }): Rect {
  const area = display.workArea;
  const marginX = Math.round(area.width * 0.06);
  const marginY = Math.round(area.height * 0.06);
  const width = Math.min(wanted.width, Math.max(1, area.width - 2 * marginX));
  const height = Math.min(wanted.height, Math.max(1, area.height - 2 * marginY));
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };
}

/** True when both rectangles are the same within `tolerance` pixels per value (Windows rounds across scale factors). */
export function sameRect(a: Rect, b: Rect, tolerance = 2): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}
