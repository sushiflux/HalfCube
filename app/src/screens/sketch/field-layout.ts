// Where the floating value fields of a drawing tool go. Pure geometry, nothing here knows React or the layer.
//   - The default look "Maßlinie": what a value measures is drawn as the dimension it will become, and the value sits on
//     its line. liveRectangle, liveLine and liveCircle describe those dimensions for the layer, with a fixed distance from the
//     edge in pixels that never depends on other dimensions.
//   - The look "Etikett": every field sits beside its geometry (outside it, never on top of it), inside the view, and two
//     fields do not cover each other (placeFields), with a leader line to the geometry.
//   - Both: the message under a field (messageSpot).
import type { LiveDimension } from "../../viewport/sketch/types.ts";
import type { P } from "./geometry.ts";

export interface Size {
  w: number;
  h: number;
}

export interface FieldWish {
  /** Screen position of the point the field is attached to. */
  x: number;
  y: number;
  /** Screen direction pointing away from the geometry (any length; zero length means "up"). */
  dx: number;
  dy: number;
  /** The direction may be turned around: take the upper side, or the right one for a horizontal direction. */
  either: boolean;
}

export interface FieldSpot {
  /** Centre of the field. */
  x: number;
  y: number;
}

/** A unit vector from a screen direction; `either` picks the upper or right way. Zero length gives "up". */
export function outward(dx: number, dy: number, either: boolean): { dx: number; dy: number } {
  const l = Math.hypot(dx, dy);
  if (!(l > 1e-9)) return { dx: 0, dy: -1 };
  let ux = dx / l;
  let uy = dy / l;
  if (either && (uy > 1e-6 || (Math.abs(uy) <= 1e-6 && ux < 0))) {
    ux = -ux;
    uy = -uy;
  }
  return { dx: ux, dy: uy };
}

const overlaps = (a: FieldSpot, b: FieldSpot, field: Size): boolean => Math.abs(a.x - b.x) < field.w && Math.abs(a.y - b.y) < field.h;

/** Keeps a field's centre so the whole field lies inside the view; a view smaller than the field centres it. */
export function clampSpot(spot: FieldSpot, view: Size, field: Size, margin: number): FieldSpot {
  const clamp = (v: number, size: number, room: number): number => {
    const lo = size / 2 + margin;
    const hi = room - size / 2 - margin;
    return hi < lo ? room / 2 : Math.min(hi, Math.max(lo, v));
  };
  return { x: clamp(spot.x, field.w, view.w), y: clamp(spot.y, field.h, view.h) };
}

/**
 * The centres of the fields, in the order given. A field sits beyond its point so that its edge keeps `gap` from the point
 * (the room a box needs along a direction is half its width times |dx| plus half its height times |dy|); it is then pulled
 * into the view, and pushed further along its direction while it covers an earlier field.
 */
export function placeFields(wishes: readonly FieldWish[], view: Size, field: Size, gap = 10, margin = 6): FieldSpot[] {
  const placed: FieldSpot[] = [];
  for (const wish of wishes) {
    const d = outward(wish.dx, wish.dy, wish.either);
    const reach = (field.w / 2) * Math.abs(d.dx) + (field.h / 2) * Math.abs(d.dy) + gap;
    let spot = clampSpot({ x: wish.x + d.dx * reach, y: wish.y + d.dy * reach }, view, field, margin);
    for (let i = 0; i < 12 && placed.some((p) => overlaps(p, spot, field)); i++) {
      spot = clampSpot({ x: spot.x + d.dx * 8, y: spot.y + d.dy * 8 }, view, field, margin);
    }
    // Pushed against the edge of the view and still covering another field: step aside across the direction, to the
    // side that is free.
    if (placed.some((p) => overlaps(p, spot, field))) {
      const room = Math.abs(d.dy) * field.w + Math.abs(d.dx) * field.h + 4;
      const aside = [1, -1]
        .map((side) => clampSpot({ x: spot.x - d.dy * room * side, y: spot.y + d.dx * room * side }, view, field, margin))
        .find((s) => !placed.some((p) => overlaps(p, s, field)));
      if (aside) spot = aside;
    }
    placed.push(spot);
  }
  return placed;
}

// ------------------------------------------------------------------------------------------------ Maßlinie

/** Distance of a live dimension line from its edge, px: along a horizontal edge, a vertical edge (the text stands beside it) and a slanted line. */
export const LIVE_OFFSET_HORIZONTAL_PX = 32;
export const LIVE_OFFSET_VERTICAL_PX = 72;
export const LIVE_OFFSET_SLANTED_PX = 34;
/** The radius of the live angle arc: 70 % of the line's length on the screen, within these limits, px. */
const ARC_MIN_PX = 30;
const ARC_MAX_PX = 90;

/** The width along the edge through the start, the height along the edge through the opposite corner; both outside the rectangle. */
export function liveRectangle(start: P, to: P): { width: LiveDimension; height: LiveDimension } {
  const du = to[0] - start[0];
  const dv = to[1] - start[1];
  return {
    width: { shape: "linear", a: [start[0], start[1]], b: [to[0], start[1]], n: [0, dv >= 0 ? -1 : 1], offsetPx: LIVE_OFFSET_HORIZONTAL_PX },
    height: { shape: "linear", a: [to[0], start[1]], b: [to[0], to[1]], n: [du >= 0 ? 1 : -1, 0], offsetPx: LIVE_OFFSET_VERTICAL_PX },
  };
}

/** The unit normal of a vector that points up (or right for a horizontal one): the side the length of a line is shown on. */
export function upperNormal(v: P): [number, number] {
  const l = Math.hypot(v[0], v[1]);
  if (!(l > 1e-9)) return [0, 1];
  const n: [number, number] = [0 - v[1] / l, v[0] / l]; // "0 -" keeps a zero from becoming -0
  return n[1] < -1e-6 || (Math.abs(n[1]) <= 1e-6 && n[0] < 0) ? [0 - n[0], 0 - n[1]] : n;
}

/** The length of a line beside it, and its angle against the horizontal as an arc at the start point. */
export function liveLine(start: P, to: P, pxPerMm: number): { length: LiveDimension; angle: LiveDimension } {
  const v: P = [to[0] - start[0], to[1] - start[1]];
  const len = Math.hypot(v[0], v[1]);
  return {
    length: { shape: "linear", a: [start[0], start[1]], b: [to[0], to[1]], n: upperNormal(v), offsetPx: LIVE_OFFSET_SLANTED_PX },
    angle: {
      shape: "angle",
      vertex: [start[0], start[1]],
      start: 0,
      sweep: len > 1e-9 ? Math.atan2(v[1], v[0]) : 0,
      radiusPx: Math.min(ARC_MAX_PX, Math.max(ARC_MIN_PX, len * pxPerMm * 0.7)),
      reach: [0, len],
    },
  };
}

/** The diameter of a circle, measured along the direction the pointer lies in (to the right while it is on the centre). */
export function liveCircle(centre: P, diameter: number, towards: P): LiveDimension {
  const l = Math.hypot(towards[0], towards[1]);
  return { shape: "diameter", c: [centre[0], centre[1]], r: diameter / 2, dir: l > 1e-9 ? [towards[0] / l, towards[1] / l] : [1, 0] };
}

// ------------------------------------------------------------------------------------------------ messages

/**
 * Where the message of a field goes: left-aligned with the field and pulled into the view, under it, or over it when there
 * is no room below. `field` is the size of the field, `message` the width and the room the message may need.
 */
export function messageSpot(spot: FieldSpot, field: Size, view: Size, message: Size, gap = 4): { left: number; top?: number; bottom?: number } {
  const left = Math.max(6, Math.min(spot.x - field.w / 2, view.w - message.w - 6));
  const below = spot.y + field.h / 2 + gap + message.h <= view.h || spot.y - field.h / 2 - gap - message.h < 0;
  return below ? { left, top: spot.y + field.h / 2 + gap } : { left, bottom: view.h - (spot.y - field.h / 2 - gap) };
}
