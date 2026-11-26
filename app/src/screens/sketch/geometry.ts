// Small plane geometry for the sketch tools: points are [u, v] pairs in mm. Only what the rubber band, the typed values
// and the dimension placement need; the sketch itself is solved by the engine, never here.
export type P = readonly [number, number];

export const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
export const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];
export const scale = (a: P, k: number): P => [a[0] * k, a[1] * k];
export const dot = (a: P, b: P): number => a[0] * b[0] + a[1] * b[1];
export const length = (a: P): number => Math.hypot(a[0], a[1]);
export const distance = (a: P, b: P): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const mid = (a: P, b: P): P => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
/** Counter-clockwise angle of a vector against +u, in degrees, in (-180, 180]. */
export const angleDeg = (a: P): number => (Math.atan2(a[1], a[0]) * 180) / Math.PI;
/** The point at `lengthMm` from `from` in the direction `deg` (against +u). */
export const polar = (from: P, lengthMm: number, deg: number): P => {
  const r = (deg * Math.PI) / 180;
  return [from[0] + lengthMm * Math.cos(r), from[1] + lengthMm * Math.sin(r)];
};
/** Left-hand normal of a vector (unit length; [0, 0] for a zero vector). */
export const normal = (a: P): P => {
  const l = length(a);
  return l === 0 ? [0, 0] : [-a[1] / l, a[0] / l];
};

/** A value with at most 3 decimals for labels and inputs, German or English decimal separator. */
export function formatNumber(value: number, decimalComma: boolean): string {
  const text = String(Number(value.toFixed(3)));
  return decimalComma ? text.replace(".", ",") : text;
}

/**
 * A value that follows the pointer: at most 2 decimals with trailing zeros dropped ("26,82", "30"), so the digits do not
 * jitter. Never "-0".
 */
export function formatLive(value: number, decimalComma: boolean): string {
  const text = String(Number(value.toFixed(2)));
  return decimalComma ? text.replace(".", ",") : text;
}

/** Angle between two direction vectors, counter-clockwise from a to b, in degrees [0, 360). */
export function angleBetweenDeg(a: P, b: P): number {
  const d = angleDeg(b) - angleDeg(a);
  return ((d % 360) + 360) % 360;
}
