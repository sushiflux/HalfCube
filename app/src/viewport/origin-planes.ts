// The three origin planes (XY, XZ, YZ) shown while the user chooses a sketch plane. They are a small marker around the origin, not
// a floor under the model: their size on the screen is constant (a fraction of the view's shorter side), whatever the content is
// and however far the view is zoomed. The world size follows from the zoom and the depth of the origin. Pure functions, tested in Node.
import { cameraBasis, worldPerPixel, type Lens, type ViewState } from "./camera.ts";
import { dot, sub } from "./math.ts";

/** One edge of an origin plane is this share of the view's shorter side (content-sized planes were far too large). */
export const PLANE_EDGE_FRACTION = 1 / 6;

/** The edge of an origin plane on the screen, CSS pixels. */
export const planeEdgePx = (lens: Lens): number => Math.min(lens.width, lens.height) * PLANE_EDGE_FRACTION;

/**
 * Half of an origin plane's edge in mm. The plane's centre is the world origin: the size is what one edge of `planeEdgePx` pixels is
 * worth at the origin's depth in front of the camera (a plane that is not seen square-on looks a little smaller or larger, as every
 * plane does). An origin behind the camera or right at its plane has no depth to measure: the zoom distance stands in for it.
 */
export function originPlaneHalf(view: ViewState, lens: Lens): number {
  const basis = cameraBasis(view);
  const depth = dot(sub([0, 0, 0], basis.eye), basis.forward);
  const usable = depth > view.distance * 0.05 ? depth : view.distance;
  return (planeEdgePx(lens) * worldPerPixel(lens, usable)) / 2;
}
