// The notice that a newer update could not be downloaded while an older one stays ready (phases "ready" and "on-exit" with
// `newerDownloadFailed`): which version failed, with the error code, "Details" (the complete, copyable error) and "Erneut versuchen".
// It is a rare technical failure, so no room is reserved for it: in the update slot the card grows by this one row at its bottom edge
// (everything inside the card keeps its place), in the update window the row is inserted above the buttons.
import { useT } from "../i18n/runtime.ts";
import { Button } from "../ui/Button.tsx";
import { openUpdateError, startDownload } from "./actions.ts";
import { TriangleBadge } from "./InfoButton.tsx";
import type { NewerDownloadFailure } from "./types.ts";

export function NewerHint({ failure, className }: { failure: NewerDownloadFailure | null; className?: string }) {
  const t = useT();
  if (failure === null) return null;
  return (
    <div className={`flex items-center gap-2.5 ${className ?? ""}`} data-testid="newer-hint" role="status">
      <TriangleBadge className="size-4 flex-none [--halo:var(--c-surface)]" />
      <span className="min-w-0 flex-1 text-[12px] leading-[1.35]" data-testid="newer-hint-text" data-error-code={failure.error.code}>
        {t("updates.newer.text", { version: failure.offer.display })} <span className="mono whitespace-nowrap text-muted">({failure.error.code})</span>
      </span>
      <Button size="sm" onClick={openUpdateError} className="bg-surface!" data-testid="newer-hint-details">
        {t("updates.showDetails")}
      </Button>
      <Button size="sm" onClick={startDownload} className="bg-surface!" data-testid="newer-hint-retry">
        {t("updates.retry")}
      </Button>
    </div>
  );
}
