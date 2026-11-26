// User-facing texts of the model layer, built from the engine's problem codes (the engine writes English technical
// text only; the UI shows the translated text and the engine text under "technical details").
import type { Problem } from "../engine/generated/protocol.ts";
import type { Translate } from "../i18n/core.ts";
import type { QuantityKind, QuantityParse } from "../document/quantity.ts";
import type { FeatureNames } from "./partcraft-model.ts";

export function featureNames(t: Translate): FeatureNames & { root: string } {
  return {
    root: t("model.names.root"),
    sketch: (n) => t("model.names.sketch", { n }),
    extrude: (n) => t("model.names.extrude", { n }),
    body: (n) => t("model.names.body", { n }),
  };
}

const round = (v: number): string => String(Number(v.toFixed(3)));

/**
 * The word for what an internal id stands for, by its kind letter ("Linie", "Kreis", "Schritt"); the fixed references of a sketch
 * (@origin, @axisU, @axisV) by their names. An id is never shown to the user: where nothing better is known (no numbered shape, no
 * document at hand) this word is what a text says.
 */
export function elementWord(t: Translate, id: string): string {
  const key =
    id === "@origin" ? "origin" : id === "@axisU" ? "axisU" : id === "@axisV" ? "axisV"
    : id.startsWith("p") ? "point" : id.startsWith("l") ? "line" : id.startsWith("c") ? "circle"
    : id.startsWith("k") ? "constraint" : id.startsWith("d") ? "dimension" : id.startsWith("f") ? "step" : "unknown";
  return t(`sketch.element.${key}`);
}

/**
 * The translated headline of a problem. describe turns an id into what the user sees (e.g. "Senkrecht" or "Breite 20 mm"); without
 * it every id is named by its kind ("Linie, Kreis"), never shown.
 */
export function problemText(t: Translate, problem: Problem, describe: (id: string) => string = (id) => elementWord(t, id)): string {
  const refs = (problem.refs ?? []).map(describe).join(", ");
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(problem.values ?? {})) values[k] = round(v);
  return t(`model.problem.${problem.code}`, { refs, ...values });
}

/** The translated text for a value that could not be read. */
export function quantityErrorText(t: Translate, parse: Extract<QuantityParse, { ok: false }>, kind: QuantityKind): string {
  const params = { text: parse.text, unit: parse.unit ?? "" };
  if (parse.error === "wrongUnit") return t(kind === "length" ? "model.quantity.wrongUnitLength" : "model.quantity.wrongUnitAngle", params);
  return t(`model.quantity.${parse.error}`, params);
}
