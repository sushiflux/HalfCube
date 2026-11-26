// The words of a failure in the extrude dialog: a headline that says what failed and why, the error code, and the technical lines
// for the copy button. Complete sentences, never cut (skill ui-regeln). Pure: text in, text out.
import type { PartcraftDocument } from "../../document/types.ts";
import type { Translate } from "../../i18n/core.ts";
import { elementWord, problemText } from "../../model/index.ts";
import type { ErrorBlock } from "../../ui/errorText.ts";
import { describeDocumentId } from "../sketch/describe.ts";
import type { CommandFailure } from "./extrude-command.ts";

export interface FailureText {
  title: string;
  code: string;
  blocks: ErrorBlock[];
}

/** The document the failure belongs to and the number format: with them the problem names steps and shapes ("Skizze1", "Rechteck 1"). */
export interface FailureContext {
  doc: PartcraftDocument;
  decimalComma: boolean;
}

/** What an id is called in the texts: the name of the step or shape in the document, or (without a document) its kind. Never the id. */
function namer(t: Translate, context?: FailureContext): (id: string) => string {
  return context ? (id) => describeDocumentId(t, context.doc, id, context.decimalComma) : (id) => elementWord(t, id);
}

/** The engine's own sentence says the same words as the headline: its ids (k3, d16) become names. */
function engineLine(t: Translate, message: string, context?: FailureContext): string {
  const name = namer(t, context);
  return t("sketch.reject.engineMessage", { message: message.replace(/\b[plckdfs]\d+\b/g, (id) => name(id)) });
}

function problemHeadline(t: Translate, problem: Parameters<typeof problemText>[1], context?: FailureContext): string {
  try {
    return problemText(t, problem, namer(t, context));
  } catch {
    // A code this version does not know: the engine's own text is better than nothing.
    return problem.message;
  }
}

export function failureText(t: Translate, failure: CommandFailure, context?: FailureContext): FailureText {
  switch (failure.kind) {
    case "preview":
    case "rejected": {
      const rejected = failure.kind === "rejected";
      const { problem } = failure;
      return {
        title: `${t(rejected ? "main.extrude.commitFailedTitle" : "main.extrude.previewFailedTitle")}: ${problemHeadline(t, problem, context)}`,
        code: `PC-EXTRUDE-${problem.code.toUpperCase()}`,
        blocks: [
          { kind: "text", text: t(rejected ? "main.extrude.commitFailedLead" : "main.extrude.previewFailedLead") },
          { kind: "code", text: engineLine(t, problem.message, context) },
        ],
      };
    }
    case "engine":
      return {
        title: t("main.extrude.engineTitle"),
        code: "PC-EXTRUDE-ENGINE",
        blocks: [
          { kind: "text", text: t("main.extrude.engineText") },
          { kind: "code", text: `${failure.error.name}: ${failure.error.message}` },
        ],
      };
    case "invalid":
      return {
        title: t("main.extrude.invalidTitle"),
        code: "PC-EXTRUDE-INVALID",
        blocks: [{ kind: "code", text: failure.message }],
      };
  }
}
