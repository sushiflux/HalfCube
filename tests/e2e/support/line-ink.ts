// Measures how continuous a nearly horizontal line is in a screenshot of the 3D view (used by viewport-grid-lines.spec.ts).
import { pixelAt } from "./png.ts";
import type { HostShot } from "./viewport.ts";

/** Rows above and below the line's centre that are added up per column, device pixels. */
export const HALF_WINDOW = 4;
/** Columns around a crossing line that are left out (the crossing adds ink: it would hide a dip next to it), device pixels. */
export const CROSSING_RADIUS = 16;
/** A column's ink is compared with the median of this many retained columns on each side. */
export const NEIGHBOURS = 24;
/** The darkest a column may be against its neighbours. The broken grid reached 0.2 to 0.3 here, the continuous one stays above 0.6. */
export const MIN_RATIO = 0.55;

export interface LineMeasurement {
  /** Ink of the line's cross-section per column (sum of the colour deviation from the view colour over the window), retained columns. */
  inks: number[];
  /** The lowest ratio of a column's ink to the median of its neighbours. */
  worst: number;
  /** Columns that fall below MIN_RATIO of their neighbours. */
  gaps: number;
  median: number;
}

/**
 * Follows a nearly horizontal line across a screenshot and adds up, for every device pixel column, the colour deviation from the
 * view colour in a window of rows around the line's centre. A continuous line has about the same sum in every column (the soft
 * edge shares the ink between two rows, whatever the sub-pixel position); a line that breaks up has columns with next to nothing.
 */
export function measureLine(
  shot: Pick<HostShot, "image" | "scale" | "box">,
  a: { x: number; y: number },
  b: { x: number; y: number },
  crossings: number[],
  background: readonly [number, number, number],
): LineMeasurement {
  const slope = (b.y - a.y) / (b.x - a.x);
  const { image, scale, box } = shot;
  const crossingColumns = crossings.map((x) => (x - box.x) * scale);
  const inks: number[] = [];
  // Away from the edges of the view (the navigator and the info box sit at the corners).
  for (let column = Math.ceil(0.06 * image.width); column < 0.94 * image.width; column++) {
    if (crossingColumns.some((x) => Math.abs(x - column - 0.5) < CROSSING_RADIUS)) continue;
    const pageX = box.x + (column + 0.5) / scale;
    const centreRow = (a.y + slope * (pageX - a.x) - box.y) * scale;
    if (centreRow < HALF_WINDOW + 1 || centreRow > image.height - HALF_WINDOW - 1) continue;
    let ink = 0;
    for (let row = Math.round(centreRow) - HALF_WINDOW; row <= Math.round(centreRow) + HALF_WINDOW; row++) {
      const p = pixelAt(image, column, row);
      ink += Math.abs(p[0] - background[0]) + Math.abs(p[1] - background[1]) + Math.abs(p[2] - background[2]);
    }
    inks.push(ink);
  }
  const middle = (values: number[]): number => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)] ?? 0;
  let worst = Infinity;
  let gaps = 0;
  inks.forEach((ink, i) => {
    const neighbours = middle(inks.slice(Math.max(0, i - NEIGHBOURS), Math.min(inks.length, i + NEIGHBOURS + 1)));
    const ratio = ink / Math.max(1, neighbours);
    worst = Math.min(worst, ratio);
    if (ratio < MIN_RATIO) gaps++;
  });
  return { inks, worst, gaps, median: middle(inks) };
}
