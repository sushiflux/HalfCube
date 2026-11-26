// Shows a failure of a user action in our own dialog: a headline with the error code that stays visible and the full,
// copyable description behind the arrow (skill ui-regeln, "How an error is shown"). Never the browser's alert.
import { useCallback, type ReactNode } from "react";
import { useT } from "../../i18n/runtime.ts";
import { useConfirm } from "../../ui/Confirm.tsx";
import { ErrorNotice } from "../../ui/ErrorNotice.tsx";
import type { ErrorBlock } from "../../ui/errorText.ts";

export interface Failure {
  /** What failed, specific. */
  title: string;
  code: string;
  /** Sentences that explain what it means for the user. */
  text?: string;
  /** The error the failure came from; its text goes under the technical details. */
  error?: unknown;
}

export function failureBlocks(failure: Failure): ErrorBlock[] {
  const blocks: ErrorBlock[] = [];
  if (failure.text) blocks.push({ kind: "text", text: failure.text });
  if (failure.error !== undefined) {
    const e = failure.error;
    blocks.push({ kind: "code", text: e instanceof Error ? `${e.name}: ${e.message}` : typeof e === "string" ? e : JSON.stringify(e) });
  }
  return blocks;
}

/** Returns a function that opens the failure dialog; it resolves when the user has closed it. */
export function useReportFailure(): (failure: Failure | readonly Failure[]) => Promise<void> {
  const confirm = useConfirm();
  const t = useT();
  return useCallback(
    async (failure) => {
      const list = Array.isArray(failure) ? (failure as readonly Failure[]) : [failure as Failure];
      const [first] = list;
      if (!first) return;
      const message: ReactNode = (
        <div className="flex flex-col gap-2" data-testid="failure-dialog">
          {list.map((f, i) => (
            <ErrorNotice key={i} headline={f.title} code={f.code} details={failureBlocks(f)} defaultOpen={list.length === 1} />
          ))}
        </div>
      );
      await confirm({ title: list.length === 1 ? first.title : t("main.status.problemsTitle"), message, confirmLabel: t("common.close"), hideCancel: true });
    },
    [confirm, t],
  );
}
