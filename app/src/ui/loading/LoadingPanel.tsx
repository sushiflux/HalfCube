import { useId, useRef } from "react";
import { useT } from "../../i18n/runtime.ts";
import { Button } from "../Button.tsx";
import { Logo } from "../Brand.tsx";
import { cx } from "../cx.ts";
import { ErrorNotice } from "../ErrorNotice.tsx";
import { StepIcon } from "../icons.tsx";
import { ScrollArea } from "../ScrollArea.tsx";
import { useFocusTrap } from "../useFocusTrap.ts";
import { actionButtons } from "./LoadingScreen.tsx";
import "./loading.css";
import { overallProgress } from "./progress.ts";
import type { LoadingProgress } from "./types.ts";

export interface LoadingPanelProps {
  progress: LoadingProgress;
  /** Set when the operation can be cancelled: the Cancel button appears. Without it there is no button. */
  onCancel?: () => void;
  onAction?: (id: string) => void;
}

/**
 * The same design as the loading screen, as a panel over the work area (open project, file import, engine restart).
 * Mount it inside a `relative` container: it covers that container with a veil and blocks the area behind it while
 * the operation runs. A failure replaces the step list in place, in full and copyable.
 */
export function LoadingPanel({ progress, onCancel, onAction }: LoadingPanelProps) {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const { steps, error, title, subtitle, note } = progress;
  const fraction = overallProgress(progress);
  useFocusTrap(panel, true, cancel);

  return (
    <div className="hc-veil" data-testid="loading-panel">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-busy={!error}
        tabIndex={-1}
        className="hc-panel outline-none"
        onKeyDown={(event) => {
          if (event.key === "Escape" && onCancel && !error) {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <div className="hc-panel-top" style={{ width: `${(fraction * 100).toFixed(2)}%` }} />
        <div className="flex items-center gap-3.5 px-5 pt-[18px] pb-3.5">
          <Logo size={34} source="medium" />
          <div className="min-w-0">
            <div id={titleId} className="text-base leading-[1.3] font-semibold break-words">
              {title}
            </div>
            {subtitle ? (
              <ScrollArea className="mt-[3px]" viewportClassName="max-h-[4.6em] pr-2 text-[12.5px] leading-[1.45] break-words text-muted">
                {subtitle}
              </ScrollArea>
            ) : null}
          </div>
        </div>

        <div className="relative min-h-[236px] px-5 pb-[18px]">
          {error ? (
            <ErrorNotice
              headline={error.headline}
              code={error.code}
              details={error.details}
              actions={actionButtons(error.actions, onAction)}
              detailsMaxHeight="min(32vh, 200px)"
            />
          ) : (
            <>
              <ul className="m-0 list-none p-0" role="status">
                {steps.map((step) => {
                  const strong = step.state === "active" || step.state === "failed";
                  return (
                    <li
                      key={step.id}
                      data-step-state={step.state}
                      className={cx(
                        "grid h-8 grid-cols-[26px_1fr_auto] items-center text-sm",
                        step.state === "pending" ? "text-muted" : "text-fg",
                        strong && "font-semibold",
                      )}
                    >
                      <StepIcon state={step.state} />
                      <span className="min-w-0 break-words">{step.label}</span>
                      <span className="mono pl-3 text-[12.5px] font-normal text-muted">{step.detail ?? ""}</span>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-3.5 flex min-h-9 items-center justify-between gap-3">
                <span className="text-[12.5px] text-muted">{note ?? ""}</span>
                {onCancel ? (
                  <Button ref={cancel} onClick={onCancel}>
                    {t("common.cancel")}
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
