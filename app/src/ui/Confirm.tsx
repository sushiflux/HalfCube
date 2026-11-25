import { createContext, useCallback, useContext, useId, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n/runtime.ts";
import { Button } from "./Button.tsx";
import { Dialog } from "./Dialog.tsx";

export interface ConfirmOptions {
  title: string;
  /** What happens, what it means: what gets deleted, what stays, whether it can be undone. */
  message: ReactNode;
  /** Name the action ("Löschen"), never a bare "OK". Defaults to "Confirm". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** destructive gets the destructive colour, the alertdialog role and focus on Cancel. */
  tone?: "primary" | "create" | "destructive";
  /** Info boxes have one button only. */
  hideCancel?: boolean;
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface Pending {
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
}

/** Mount once near the root. Questions are shown one after the other. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [queue, setQueue] = useState<Pending[]>([]);
  const [closing, setClosing] = useState<Pending | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const messageId = useId();

  const confirm = useCallback<ConfirmFn>(
    (options) => new Promise<boolean>((resolve) => setQueue((q) => [...q, { options, resolve }])),
    [],
  );

  const current = queue[0] ?? null;
  const shown = current ?? closing;

  const answer = (value: boolean) => {
    if (!current) return;
    current.resolve(value);
    setClosing(current);
    setQueue((q) => q.slice(1));
  };

  const options = shown?.options;
  const destructive = options?.tone === "destructive";
  const hideCancel = options?.hideCancel === true;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={current !== null}
        onClose={() => answer(false)}
        title={options?.title ?? ""}
        role={destructive ? "alertdialog" : "dialog"}
        size="sm"
        describedById={messageId}
        initialFocus={destructive && !hideCancel ? cancelRef : confirmRef}
        footer={
          <>
            {hideCancel ? null : (
              <Button ref={cancelRef} onClick={() => answer(false)}>
                {options?.cancelLabel ?? t("common.cancel")}
              </Button>
            )}
            <Button
              ref={confirmRef}
              variant={options?.tone ?? "primary"}
              onClick={() => answer(true)}
            >
              {options?.confirmLabel ?? t("dialog.defaultConfirm")}
            </Button>
          </>
        }
      >
        <div id={messageId}>{options?.message}</div>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

/** `const confirm = useConfirm(); if (await confirm({...})) ...`: our own dialog, never the browser's. */
export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm needs a <ConfirmProvider> above it.");
  return confirm;
}
