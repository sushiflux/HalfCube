// The words of a refused sketch edit: what the user did, why the engine refused, which constraints are involved, and the
// technical lines for the copy button. Complete sentences, never cut (skill ui-regeln). Pure: text in, text out.
import { formatQuantity } from "../../document/index.ts";
import type { Translate } from "../../i18n/core.ts";
import { problemText } from "../../model/index.ts";
import type { ErrorBlock } from "../../ui/errorText.ts";
import { describeElement, dimensionKindLabel, knowsConstraint } from "./describe.ts";
import type { Rejection } from "./session.ts";

export interface RejectText {
  title: string;
  code: string;
  blocks: ErrorBlock[];
  /** The dialog offers "Als Referenzmaß anlegen" next to "Abbrechen". */
  offerReference: boolean;
}

export function rejectText(t: Translate, rejection: Rejection, decimalComma: boolean): RejectText {
  const { action, outcome, view } = rejection;
  if (outcome.reason === "engine") {
    return {
      title: t("sketch.reject.engineTitle"),
      code: "PC-SKETCH-ENGINE",
      blocks: [
        { kind: "text", text: t("sketch.reject.engineText") },
        { kind: "code", text: `${outcome.error.name}: ${outcome.error.message}` },
      ],
      offerReference: false,
    };
  }
  if (outcome.reason === "invalid") {
    return {
      title: t("sketch.reject.invalidTitle"),
      code: "PC-SKETCH-INVALID",
      blocks: [{ kind: "text", text: t("sketch.reject.invalidText", { message: outcome.message }) }],
      offerReference: false,
    };
  }
  const { problem } = outcome;
  const dimension = action.kind === "dimension" ? action.dimension : null;
  const name = dimension
    ? `${dimensionKindLabel(t, dimension.dimKind)}${dimension.value ? ` ${formatQuantity(dimension.value, decimalComma)}` : ""}`
    : "";
  // A constraint or dimension the sketch does not know is the proposed one itself (the engine named it while solving): say so in words.
  // Every other element is named like in the sketch (Rechteck 1, d3 · 40 mm), never by its id.
  const describe = (id: string): string => {
    if (!knowsConstraint(view, id)) {
      if (dimension && id.startsWith("d")) return t("sketch.reject.thisDimension", { name });
      if (!dimension && action.kind === "constraint" && id.startsWith("k")) return t("sketch.reject.thisConstraint");
    }
    return describeElement(t, view, id, decimalComma);
  };
  // The engine's own sentence names ids too (k3, d16): the technical lines say the same words as the rest of the dialog.
  const engineText = problem.message.replace(/\b[plckdfs]\d+\b/g, describe);
  let headline: string;
  try {
    headline = problemText(t, problem, describe);
  } catch {
    headline = problem.message;
  }
  const blocks: ErrorBlock[] = [
    { kind: "text", text: dimension ? t("sketch.reject.dimensionLead", { name }) : t(`sketch.reject.${action.kind}Lead`) },
    { kind: "text", text: headline },
  ];
  if (dimension) blocks.push({ kind: "text", text: t("sketch.reject.dimensionChoice") });
  const technical: string[] = [t("sketch.reject.engineMessage", { message: engineText })];
  if (outcome.conflicting.length > 0) technical.push(t("sketch.reject.conflicting", { list: outcome.conflicting.map(describe).join("; ") }));
  if (outcome.redundant.length > 0) technical.push(t("sketch.reject.redundant", { list: outcome.redundant.map(describe).join("; ") }));
  blocks.push({ kind: "code", text: technical.join("\n") });
  return {
    title: dimension ? t("sketch.reject.dimensionTitle") : t(`sketch.reject.${action.kind}Title`),
    code: `PC-${problem.code.toUpperCase().replaceAll("_", "-")}`,
    blocks,
    offerReference: dimension !== null,
  };
}
