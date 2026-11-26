// Shows a refused sketch edit in our own dialog: a headline with the error code, the complete text behind the arrow and the
// copy button (skill ui-regeln). For a dimension that contradicts the sketch the dialog offers "Als Referenzmaß anlegen" or
// "Abbrechen"; everything else is an information box with one button.
import { useCallback } from "react";
import { useI18n } from "../../i18n/runtime.ts";
import { useConfirm } from "../../ui/Confirm.tsx";
import { ErrorNotice } from "../../ui/ErrorNotice.tsx";
import { rejectText } from "./reject-model.ts";
import type { RejectChoice, Rejection } from "./session.ts";

export function useSketchReject(): (rejection: Rejection) => Promise<RejectChoice> {
  const confirm = useConfirm();
  const { t, language } = useI18n();
  return useCallback(
    async (rejection) => {
      const text = rejectText(t, rejection, language === "de");
      const message = (
        <div data-testid="sketch-reject-dialog" data-code={text.code}>
          <ErrorNotice headline={text.title} code={text.code} details={text.blocks} defaultOpen />
        </div>
      );
      if (text.offerReference) {
        const reference = await confirm({
          title: text.title,
          message,
          confirmLabel: t("sketch.reject.asReference"),
          cancelLabel: t("common.cancel"),
        });
        return reference ? "reference" : "cancel";
      }
      await confirm({ title: text.title, message, confirmLabel: t("common.close"), hideCancel: true });
      return "cancel";
    },
    [confirm, t, language],
  );
}
