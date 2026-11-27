import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import { formatTimestamp } from "../i18n/core.ts";
import { useI18n } from "../i18n/runtime.ts";
import { getDesktopBridge } from "../platform.ts";
import { currentVersion } from "../version.ts";
import { CopyButton } from "./CopyButton.tsx";
import { cx } from "./cx.ts";
import { buildErrorText, metaLine, type ErrorBlock } from "./errorText.ts";
import { IconChevronRight, StepIcon } from "./icons.tsx";
import { ScrollArea } from "./ScrollArea.tsx";

const noDetails: readonly ErrorBlock[] = [];

export interface ErrorNoticeProps {
  /** What failed, specific: "Engine konnte nicht gestartet werden: halfcube-engine.exe fehlt". */
  headline: string;
  /** Error code, shown with the headline and never folded away. */
  code: string;
  /** The detailed description, folded behind the arrow. */
  details?: readonly ErrorBlock[];
  /** Extra buttons next to Copy: retry, reload, quit ... */
  actions?: ReactNode;
  defaultOpen?: boolean;
  /** When it happened; defaults to the moment the notice first appears. */
  occurredAt?: Date;
  className?: string;
  /** Height limit of the details box in CSS length units; the box scrolls with an overlay thumb beyond that. */
  detailsMaxHeight?: string;
}

/**
 * How an error is shown: a headline with the error code that stays visible and an arrow that unfolds the details.
 * Neither is ever cut off. "Copy" copies the complete text (message, details, code, app version, time), also while
 * folded. Layout is rigid: the copy confirmation and the arrow label take their room from the start.
 */
export function ErrorNotice({
  headline,
  code,
  details = noDetails,
  actions,
  defaultOpen = false,
  occurredAt,
  className,
  detailsMaxHeight = "min(32vh, 220px)",
}: ErrorNoticeProps) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  const [firstShown] = useState(() => new Date());
  const detailsId = useId();

  const report = useMemo(() => {
    // Always the desktop program; a page without the bridge (unit tests, the bare dev server) is named as Windows.
    const environment = t("error.environmentDesktop", { os: getDesktopBridge()?.os ?? "win32" });
    return {
      headline,
      code,
      blocks: details,
      version: currentVersion().display,
      environment,
      time: formatTimestamp(occurredAt ?? firstShown, language),
    };
  }, [headline, code, details, t, language, occurredAt, firstShown]);

  const getText = useCallback(() => buildErrorText(report), [report]);

  return (
    <div
      role="alert"
      data-error-code={code}
      className={cx(
        "selectable relative overflow-hidden rounded-card border border-line bg-surface py-4 pr-[18px] pl-[21px] text-left text-fg shadow-card",
        className,
      )}
    >
      {/* Accent line: thin, straight, flush on the left edge over the full height. */}
      <span className="absolute top-0 bottom-0 left-0 w-[3px] bg-destructive" aria-hidden="true" />
      <div className="flex items-start gap-2.5">
        <StepIcon state="failed" className="mt-[2px]" />
        <div className="min-w-0 text-[15px] leading-[1.4] font-semibold break-words">
          {headline} <span className="mono text-[13px] font-medium whitespace-nowrap text-muted">({code})</span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 pl-[26px]">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((o) => !o)}
          className="mr-auto inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-sm pr-1.5 text-[13.5px] font-semibold text-primary"
        >
          <IconChevronRight
            size={14}
            className={cx("transition-transform duration-150", open && "rotate-90")}
          />
          {/* Both labels take room in the same cell, so the width stays the same. */}
          <span className="inline-grid">
            <span className={cx("col-start-1 row-start-1", open && "invisible")} aria-hidden={open}>
              {t("common.showDetails")}
            </span>
            <span className={cx("col-start-1 row-start-1", !open && "invisible")} aria-hidden={!open}>
              {t("common.hideDetails")}
            </span>
          </span>
        </button>
        <CopyButton getText={getText} />
        {actions}
      </div>

      {open ? (
        <div id={detailsId} className="mt-3 ml-[26px] rounded-ctl bg-surface-2">
          <ScrollArea viewportClassName="px-3.5 py-2.5 text-[13px] leading-normal" style={{ maxHeight: detailsMaxHeight }}>
            {details.map((block, index) =>
              block.kind === "code" ? (
                <p key={index} className="mono mb-[7px] text-[12.5px] break-all whitespace-pre-wrap">
                  {block.text}
                </p>
              ) : (
                <p key={index} className="mb-[7px]">
                  {block.text}
                </p>
              ),
            )}
            <p className="mono text-xs break-words text-muted">{metaLine(report)}</p>
          </ScrollArea>
        </div>
      ) : null}
    </div>
  );
}
