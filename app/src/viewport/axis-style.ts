// The origin axes (X red, Y green, Z blue) as a quiet reference: thin and pale at rest, fading out with the distance from the origin
// (so they do not run across the whole screen), thicker and in full colour under the pointer, and hidden together with the grid.
// Pure functions (no three.js, no DOM), tested in Node. The colours and weights are the theme's (and later the user's) line settings
// for axisX / axisY / axisZ: the rest look is derived from them, so a changed colour or weight carries over.
import { cameraBasis, type Lens, type ViewState } from "./camera.ts";
import { buildSegments } from "./geometry.ts";
import type { Vec3 } from "./math.ts";
import { nearestSegment } from "./picking.ts";
import type { LineStyle } from "./style.ts";

/** At rest an axis is drawn this share as wide as its line weight and this opaque. */
export const AXIS_REST_WIDTH_FACTOR = 0.7;
export const AXIS_REST_OPACITY = 0.65;
/** Under the pointer it is this much wider than its line weight, and fully opaque. */
export const AXIS_HOVER_WIDTH_FACTOR = 1.5;
/** The axis is solid out to this distance from the origin and gone at the other one, as multiples of the zoom distance of the view. */
export const AXIS_FADE_START = 0.1;
export const AXIS_FADE_END = 0.4;
/** Pixels around an axis in which the pointer counts as on it. */
export const AXIS_PICK_PX = 6;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The distances (mm from the origin) where the fade starts and ends for a view at `viewDistance`. */
export const axisFadeRange = (viewDistance: number): { start: number; end: number } => ({ start: viewDistance * AXIS_FADE_START, end: viewDistance * AXIS_FADE_END });

/** 1 near the origin, 0 far away, smooth in between. */
export function axisFade(distanceFromOrigin: number, viewDistance: number): number {
  const { start, end } = axisFadeRange(viewDistance);
  return 1 - smoothstep(start, end, Math.abs(distanceFromOrigin));
}

/** Under the pointer the fade is steeper in the other direction: the part that is still mostly solid comes out in full colour. */
export const AXIS_HOVER_FADE_BOOST = 1.6;

/**
 * Width (CSS px) and opacity of an axis line from its line style, at rest or under the pointer, and the factor the fade is multiplied by
 * (1 at rest; under the pointer it is raised so that the part that can be hovered shows in full colour: min(1, fade * boost)).
 */
export function axisLook(line: LineStyle, hovered: boolean): { width: number; opacity: number; fadeBoost: number } {
  return hovered
    ? { width: line.width * AXIS_HOVER_WIDTH_FACTOR, opacity: 1, fadeBoost: AXIS_HOVER_FADE_BOOST }
    : { width: line.width * AXIS_REST_WIDTH_FACTOR, opacity: AXIS_REST_OPACITY, fadeBoost: 1 };
}

/** The part of an axis that can be hovered: where it is still at least this solid. */
export const AXIS_HOVER_MIN_FADE = 0.3;

/** The axes show only with the grid ("Raster ausblenden" hides both) and never in a sketch plane (the sketch layer draws its own). */
export const axesShown = (gridVisible: boolean, originVisible: boolean, inSketchPlane: boolean): boolean => gridVisible && originVisible && !inSketchPlane;

export type AxisIndex = 0 | 1 | 2;
export const axisDirections: readonly Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

export interface AxisHit {
  axis: AxisIndex;
  /** Depth of the nearest point of the axis to the pointer, mm in front of the camera. */
  depth: number;
  distancePx: number;
  /** The nearest point of the axis, world. */
  point: Vec3;
}

/** The axis nearest to the pointer within `tolerancePx` (X, Y and Z run to the end of their fade, where nothing of them is seen any more), or null. */
export function nearestAxis(view: ViewState, lens: Lens, x: number, y: number, tolerancePx = AXIS_PICK_PX): AxisHit | null {
  const reach = axisFadeRange(view.distance).end;
  const buffers = buildSegments(axisDirections.map((d, i) => ({ owner: i, points: [[-d[0] * reach, -d[1] * reach, -d[2] * reach], [d[0] * reach, d[1] * reach, d[2] * reach]] as Vec3[] })));
  const hit = nearestSegment(view, lens, buffers, x, y, tolerancePx, cameraBasis(view));
  return hit ? { axis: hit.owner as AxisIndex, depth: hit.depth, distancePx: hit.distancePx, point: hit.point } : null;
}
