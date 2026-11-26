// Reads values the user types (dimension input, extrude distance) and stores them the way the document does:
// lengths in mm, angles in degrees. "40", "40 mm", "4 cm", "1.5 in", "30°", "30 deg" and German decimal commas
// ("12,5") are accepted. The error codes are translated by the UI (i18n keys quantity.error.*).
import type { Quantity } from "./types.ts";

export type QuantityKind = "length" | "angle";

export type QuantityErrorCode =
  | "empty" // nothing typed
  | "notANumber" // no number at the start, or a malformed one ("1.2.3", "1,2.5")
  | "unknownUnit" // a unit Partcraft does not know ("40 yd")
  | "wrongUnit" // a known unit of the other kind ("30 mm" for an angle)
  | "notPositive" // zero or negative where only positive values make sense (lengths of lines, diameters)
  | "zero" // zero where only the sign is free (extrude distance)
  | "tooLarge"; // beyond the range the kernel handles sensibly

export type QuantityParse =
  | { ok: true; value: Quantity }
  | { ok: false; error: QuantityErrorCode; text: string; unit?: string };

export interface ParseOptions {
  /** "positive": > 0 (lengths, diameters). "nonZero": any sign but not 0 (extrude distance). Default: any value. */
  sign?: "positive" | "nonZero" | "any";
}

/** Factors to mm. */
const LENGTH_UNITS: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, '"': 25.4 };
/** Factors to degrees. */
const ANGLE_UNITS: Record<string, number> = { "°": 1, deg: 1, rad: 180 / Math.PI };

/** Largest absolute length (mm) and angle (deg) accepted: 100 m and ten turns. */
const MAX_LENGTH_MM = 100_000;
const MAX_ANGLE_DEG = 3600;

const NUMBER = /^([+-]?)(\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE]([+-]?\d+))?/;

/**
 * Parses a typed value. Without a unit the document unit is meant (mm or deg). The result is rounded to 12
 * significant digits so that "4 cm" is exactly 40 and "1.5 in" exactly 38.1.
 */
export function parseQuantity(input: string, kind: QuantityKind, options: ParseOptions = {}): QuantityParse {
  const text = input.trim();
  if (text === "") return { ok: false, error: "empty", text: input };
  const m = NUMBER.exec(text);
  if (!m) return { ok: false, error: "notANumber", text: input };
  const [whole, sign = "", digits = "", exponent] = m;
  const number = Number(`${sign}${digits.replace(",", ".")}${exponent !== undefined ? `e${exponent}` : ""}`);
  if (!Number.isFinite(number)) return { ok: false, error: "notANumber", text: input };

  const rest = text.slice(whole.length).trim().toLowerCase();
  // A second separator right after the number ("1.2.3", "1,2.5") is a malformed number, not a unit.
  if (/^[.,\d]/.test(rest)) return { ok: false, error: "notANumber", text: input };
  const own = kind === "length" ? LENGTH_UNITS : ANGLE_UNITS;
  const other = kind === "length" ? ANGLE_UNITS : LENGTH_UNITS;
  let factor = 1;
  if (rest !== "") {
    const f = own[rest];
    if (f === undefined) {
      return { ok: false, error: other[rest] !== undefined ? "wrongUnit" : "unknownUnit", text: input, unit: rest };
    }
    factor = f;
  }
  const value = Number((number * factor).toPrecision(12));
  const limit = kind === "length" ? MAX_LENGTH_MM : MAX_ANGLE_DEG;
  if (Math.abs(value) > limit) return { ok: false, error: "tooLarge", text: input };
  const rule = options.sign ?? "any";
  if (rule === "positive" && !(value > 0)) return { ok: false, error: "notPositive", text: input };
  if (rule === "nonZero" && value === 0) return { ok: false, error: "zero", text: input };
  return { ok: true, value: { value: value === 0 ? 0 : value, unit: kind === "length" ? "mm" : "deg" } };
}

/** Text for an input field: up to 6 decimals, no trailing zeros, the unit after a space ("12.5 mm", "30°"). */
export function formatQuantity(q: Quantity, decimalComma = false): string {
  const n = Number(q.value.toFixed(6)).toString();
  const shown = decimalComma ? n.replace(".", ",") : n;
  return q.unit === "deg" ? `${shown}°` : `${shown} mm`;
}

export const mm = (value: number): Quantity => ({ value, unit: "mm" });
export const deg = (value: number): Quantity => ({ value, unit: "deg" });
