import { useId, type ReactNode, type RefObject } from "react";
import { useT } from "../i18n/runtime.ts";
import { IconButton } from "./Button.tsx";
import { cx } from "./cx.ts";
import { IconClose } from "./icons.tsx";
import { Modal } from "./Modal.tsx";
import { ScrollArea } from "./ScrollArea.tsx";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Buttons, right-aligned. The main action of the dialog is the only filled one. */
  footer?: ReactNode;
  /** Shows a close button in the header. Dialogs that ask a question leave it out and use their buttons. */
  showClose?: boolean;
  role?: "dialog" | "alertdialog";
  size?: "sm" | "md" | "wide" | "lg";
  initialFocus?: RefObject<HTMLElement | null>;
  closeOnBackdrop?: boolean;
  /** Text the dialog is about, for screen readers (alertdialog). */
  describedById?: string;
}

const widths = { sm: "w-[420px]", md: "w-[520px]", wide: "w-[600px]", lg: "w-[680px]" } as const;

/** The one dialog of the app: own overlay, title, scrolling body, footer. Never window.confirm/alert/prompt. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  showClose = false,
  role = "dialog",
  size = "md",
  initialFocus,
  closeOnBackdrop = true,
  describedById,
}: DialogProps) {
  const t = useT();
  const titleId = useId();
  return (
    <Modal
      open={open}
      onClose={onClose}
      role={role}
      aria-labelledby={titleId}
      aria-describedby={describedById}
      initialFocus={initialFocus}
      closeOnBackdrop={closeOnBackdrop}
      className={cx("flex flex-col rounded-card border border-line bg-surface text-fg shadow-dialog", widths[size])}
    >
      <div className="flex items-start gap-3 px-5 pt-4 pb-1">
        <h2 id={titleId} className="min-w-0 flex-1 pt-1 text-base leading-snug font-semibold">
          {title}
        </h2>
        {showClose ? (
          <IconButton label={t("common.close")} onClick={onClose} className="-mt-1 -mr-2">
            <IconClose />
          </IconButton>
        ) : null}
      </div>
      <ScrollArea className="px-5 py-2" viewportClassName="max-h-[min(60vh,480px)] text-sm leading-relaxed">
        {children}
      </ScrollArea>
      {footer ? <div className="flex flex-wrap items-center justify-end gap-2 px-5 pt-3 pb-4">{footer}</div> : <div className="h-3" />}
    </Modal>
  );
}
