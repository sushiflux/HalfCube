// The values of the extrude dialog and how they become the parameters of the model layer. Pure functions, no React.
//
// The field shows the distance as a plain number of millimetres (the unit is drawn behind it) and is always positive; the
// opposite direction is its own switch. Stored in the document, the sign carries the direction for "one side" (positive = along
// the sketch normal). "Symmetric" is the total thickness and has no direction, so it is stored positive; the switch keeps
// its value while symmetric is chosen, so going back to one side restores the direction the user had.
import { parseQuantity, type QuantityParse } from "../../document/quantity.ts";
import type { Quantity } from "../../document/types.ts";
import type { ExtrudeExtent, ExtrudeParams } from "../../model/index.ts";

export interface ExtrudeForm {
  /** What the user typed or what the last value is shown as ("12,5", "6", or "4 cm" while typing). */
  text: string;
  /** Extrude against the sketch normal (one side only). */
  reversed: boolean;
  extent: ExtrudeExtent;
}

/** The text of the field for a distance in mm: up to 6 decimals, no trailing zeros, the decimal comma in German. */
export function distanceText(mm: number, decimalComma: boolean): string {
  const text = Number(Math.abs(mm).toFixed(6)).toString();
  return decimalComma ? text.replace(".", ",") : text;
}

export function formFromParams(params: Pick<ExtrudeParams, "extent" | "distance">, decimalComma: boolean): ExtrudeForm {
  return {
    text: distanceText(params.distance.value, decimalComma),
    reversed: params.extent === "oneSide" && params.distance.value < 0,
    extent: params.extent,
  };
}

/** The typed text as a length; zero and negative values are not valid (the direction has its own switch). */
export function checkDistance(text: string): QuantityParse {
  return parseQuantity(text, "length", { sign: "positive" });
}

/** The distance for the model layer: the typed value with the sign the direction needs. */
export function signedDistance(form: Pick<ExtrudeForm, "reversed" | "extent">, mm: Quantity): Quantity {
  const negative = form.extent === "oneSide" && form.reversed;
  return { value: negative ? -mm.value : mm.value, unit: "mm" };
}

/** What the viewport's handle reports (a signed distance along the normal) as form changes. */
export function formFromHandle(form: ExtrudeForm, signed: number, decimalComma: boolean): ExtrudeForm {
  const magnitude = Math.abs(signed);
  // In "symmetric" the handle changes the total thickness only; its sign is meaningless there.
  const reversed = form.extent === "oneSide" ? signed < 0 : form.reversed;
  return { ...form, text: distanceText(magnitude, decimalComma), reversed };
}
