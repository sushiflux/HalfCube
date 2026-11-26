// Layout of the ground grid: which spacing it has, where the quad that carries it sits, and how far it reaches. Pure functions
// (no three.js, no DOM), tested in Node. The lines themselves are drawn by a shader (three-grid.ts) that evaluates them per pixel,
// so the grid has no edge: it covers the whole plane and only fades out far away, where lines would be too dense to draw cleanly.
import { cameraBasis, pixelsPerWorld, tanHalfFov, type Lens, type ViewState } from "./camera.ts";
import { dot, scale, sub, type Vec3 } from "./math.ts";
import type { Frame3 } from "./sketch/frame.ts";

/** The grid fades out completely at this many times the larger one of the zoom distance and the eye's height above the plane. */
export const REACH_FACTOR = 60;
/** The fade by distance starts at this fraction of the reach. */
export const REACH_FADE_START = 0.5;
/** Lines of one level that are at least this many pixels apart are drawn fully ... */
export const DENSE_FULL_PX = 12;
/** ... and lines closer than this are not drawn at all (in between they fade). */
export const DENSE_NONE_PX = 4;

/** The most levels of lines the grid draws at the same time (see gridLevels: never more than four are needed). */
export const MAX_GRID_LEVELS = 5;
/** A level of lines starts to appear when its lines are this many pixels apart ... */
export const LEVEL_FADE_IN_START_PX = 10;
/** ... and is fully there at this spacing, a comfortable distance between two lines. */
export const LEVEL_FADE_IN_FULL_PX = 36;
/** Lines closer than this look like fine lines (the minor line style) ... */
export const LEVEL_MINOR_PX = 48;
/** ... and lines at least this far apart look like coarse lines (the major style); in between the look blends. */
export const LEVEL_MAJOR_PX = 200;

/** Distance between two lines of level n, mm: ... 0.1, 0.5, 1, 5, 10, 50, 100 ... (the factor alternates 5 and 2). */
export function levelSpacing(n: number): number {
  const decade = Math.floor(n / 2);
  const base = decade >= 0 ? Math.pow(10, decade) : 1 / Math.pow(10, -decade);
  return n % 2 === 0 ? base : 5 * base;
}

export interface GridLevel {
  /** Distance between two lines of this level, mm. Every line of a coarser level is also a line of this one. */
  spacing: number;
  /** 0 when the level's lines are too close on the screen to show, 1 when they are far enough apart; continuous in between. */
  opacity: number;
  /** 0 = look of a fine line, 1 = look of a coarse line; continuous. */
  major: number;
  /**
   * How many lines of this level lie between two lines of the next coarser level that is drawn (2 or 5), 0 for the coarsest drawn
   * level. The lines of the coarser level are drawn by that level alone: this one leaves out every n-th line, so a line is never
   * drawn twice on top of itself and does not change when a level joins or leaves.
   */
  coarser: number;
}

/**
 * The levels of lines for a zoom: from the finest level whose lines are still a few pixels apart up to the first level whose lines
 * look fully coarse (the levels beyond it have the same look and their lines already belong to it). Finest level first. Each level
 * fades in with its screen spacing and its look moves from fine to coarse with it, so zooming in subdivides every cell into finer
 * ones without a switch, and zooming out merges them again. The input is the pixels per mm at the zoom distance (pixelsPerWorld of
 * the view's distance to its target): the levels depend on the zoom alone, never on what the camera sees of the plane.
 */
export function gridLevels(pxPerMm: number): GridLevel[] {
  const ppm = Math.max(1e-12, pxPerMm);
  // The first level that has any opacity: its lines are more than LEVEL_FADE_IN_START_PX apart. Two levels per decade.
  let n = Math.floor(2 * Math.log10(LEVEL_FADE_IN_START_PX / ppm)) - 2;
  while (levelSpacing(n) * ppm <= LEVEL_FADE_IN_START_PX) n++;
  const levels: GridLevel[] = [];
  for (; levels.length < MAX_GRID_LEVELS; n++) {
    const spacing = levelSpacing(n);
    const px = spacing * ppm;
    levels.push({ spacing, opacity: smooth(clamp01((px - LEVEL_FADE_IN_START_PX) / (LEVEL_FADE_IN_FULL_PX - LEVEL_FADE_IN_START_PX))), major: smooth(clamp01((px - LEVEL_MINOR_PX) / (LEVEL_MAJOR_PX - LEVEL_MINOR_PX))), coarser: 0 });
    if (px >= LEVEL_MAJOR_PX) break;
  }
  for (let i = 0; i + 1 < levels.length; i++) levels[i]!.coarser = Math.round(levels[i + 1]!.spacing / levels[i]!.spacing);
  return levels;
}

export interface GridLayout {
  /** The levels of lines, finest first (see gridLevels). Derived from the zoom distance (the view's distance to its target) only. */
  levels: GridLevel[];
  /** The coarsest spacing: the quad's middle is a multiple of it, so it is a multiple of every level's spacing. */
  snap: number;
  /** Middle of the quad in the plane's own coordinates. */
  centerU: number;
  centerV: number;
  /** Half the side of the quad, mm. */
  half: number;
  /** Distance from the eye beyond which nothing of the grid is drawn, mm. */
  reach: number;
}

/**
 * The grid of a plane for a view. The levels come from the zoom distance alone (`view.distance`), never from what the camera sees
 * of the plane. `frame` is the plane (null = the XY plane through the origin). The quad is centred under the eye, snapped to a
 * multiple of the coarsest spacing so it moves in whole steps while the pattern itself stays put in the world.
 */
export function gridLayout(view: ViewState, lens: Lens, frame: Frame3 | null): GridLayout {
  const levels = gridLevels(pixelsPerWorld(lens, view.distance));
  const snap = levels[levels.length - 1]!.spacing;
  const eye = cameraBasis(view).eye;
  let eu = eye[0], ev = eye[1], height = eye[2];
  if (frame) {
    const rel = sub(eye, frame.origin);
    eu = dot(rel, frame.u);
    ev = dot(rel, frame.v);
    height = dot(rel, frame.normal);
  }
  const reach = REACH_FACTOR * Math.max(view.distance, Math.abs(height));
  // A point of the plane within `reach` of the eye is within `reach` of the eye's foot point; the snap moves the centre by less
  // than one snap step, so this half size always covers it.
  const half = reach + 2 * snap;
  return { levels, snap, centerU: Math.round(eu / snap) * snap, centerV: Math.round(ev / snap) * snap, half, reach };
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smooth = (x: number): number => x * x * (3 - 2 * x);

/**
 * How visible the lines of one level are, from their distance on the screen (px between two neighbours): 1 when they are far apart
 * enough to be drawn cleanly, 0 when they would be a flicker. The shader computes the same with the pixel footprint of the plane.
 */
export function densityFade(spacingPx: number): number {
  if (!(spacingPx > DENSE_NONE_PX)) return 0;
  if (spacingPx >= DENSE_FULL_PX) return 1;
  return smooth((spacingPx - DENSE_NONE_PX) / (DENSE_FULL_PX - DENSE_NONE_PX));
}

/**
 * How much of a pixel a line covers when the line's centre is `distancePx` away from the pixel's centre (measured across the
 * line, in device pixels) and the line is `widthPx` wide. The line is the box of its width smeared over one pixel, so a row of
 * pixels spaced one apart always adds up to exactly the line's width, wherever the line falls between them: the line stays
 * unbroken at every slope and sub-pixel position. A line thinner than one pixel is drawn one pixel wide and paler by the same
 * ratio, which keeps its total ink and avoids dropouts. The shader (three-grid.ts) evaluates the same formula.
 */
export function lineCoverage(distancePx: number, widthPx: number): number {
  const drawn = Math.max(widthPx, 1);
  return clamp01(drawn * 0.5 + 0.5 - distancePx) * (widthPx / drawn);
}

/** 1 near the eye, falling to 0 at the reach: a safety net so the far end of the quad never shows. */
export function reachFade(distance: number, reach: number): number {
  if (!(reach > 0)) return 0;
  const t = (distance / reach - REACH_FADE_START) / (1 - REACH_FADE_START);
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  return 1 - smooth(t);
}

/** The camera in the plane's own frame (u, v, normal), for the shader that works out what one pixel covers on the plane. */
export interface GridCamera {
  /** The eye: its u and v relative to the quad's middle, and its height above the plane (signed). */
  eye: Vec3;
  /** The viewing direction (unit). */
  forward: Vec3;
  /** How the ray direction changes from one device pixel to the next, to the right and upward. */
  stepX: Vec3;
  stepY: Vec3;
}

/**
 * The camera of `view` seen from the plane `frame` (null = XY) with the quad centred at (layout.centerU, layout.centerV).
 * `pixelRatio` is device pixels per CSS pixel: line widths and the fade are measured in device pixels.
 */
export function gridCamera(view: ViewState, lens: Lens, frame: Frame3 | null, layout: Pick<GridLayout, "centerU" | "centerV">, pixelRatio: number): GridCamera {
  const b = cameraBasis(view);
  const inFrame = (v: Vec3): Vec3 => (frame ? [dot(v, frame.u), dot(v, frame.v), dot(v, frame.normal)] : v);
  const rel = frame ? sub(b.eye, frame.origin) : b.eye;
  const eye = inFrame(rel);
  const tanY = tanHalfFov(lens);
  const tanX = tanY * (lens.width / Math.max(1, lens.height));
  const stepX = scale(inFrame(b.right), (2 * tanX) / Math.max(1, lens.width * pixelRatio));
  const stepY = scale(inFrame(b.up), (2 * tanY) / Math.max(1, lens.height * pixelRatio));
  return { eye: [eye[0] - layout.centerU, eye[1] - layout.centerV, eye[2]], forward: inFrame(b.forward), stepX, stepY };
}

/**
 * What one device pixel covers on the plane, in mm along u and v, at the plane point (u, v) given relative to the quad's middle.
 * The ray through that point has direction q = point - eye; its depth along the view is t = q . forward, and the point moves
 * with the pixel by t * (step - q * step.n / q.n) (the plane is n = 0). The shader (three-grid.ts) evaluates the same formula.
 * Infinite when the eye lies in the plane (the plane is seen edge-on).
 */
export function pixelFootprint(camera: GridCamera, u: number, v: number): [number, number] {
  const q: Vec3 = [u - camera.eye[0], v - camera.eye[1], -camera.eye[2]];
  if (Math.abs(q[2]) < 1e-12) return [Infinity, Infinity];
  const t = dot(q, camera.forward);
  const along = (step: Vec3): Vec3 => [t * (step[0] - (q[0] * step[2]) / q[2]), t * (step[1] - (q[1] * step[2]) / q[2]), 0];
  const dx = along(camera.stepX);
  const dy = along(camera.stepY);
  return [Math.hypot(dx[0], dy[0]), Math.hypot(dx[1], dy[1])];
}
