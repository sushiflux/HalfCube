import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx.ts";
import { useFocusTrap } from "./useFocusTrap.ts";

/** Open modals, topmost last: only the topmost one reacts to Esc and keeps the focus. */
const stack: symbol[] = [];

export interface ModalProps {
  open: boolean;
  /** Esc and a click on the backdrop. */
  onClose: () => void;
  closeOnBackdrop?: boolean;
  role?: "dialog" | "alertdialog";
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  initialFocus?: RefObject<HTMLElement | null>;
  /** How far from the top edge the panel stands: "compact" for a tall panel that has to fit the smallest window (the About view). */
  top?: "default" | "compact";
  /** Class names of the panel wrapper (width, height). */
  className?: string;
  children: ReactNode;
}

/**
 * Overlay with a focus trap, Esc and backdrop handling, the page behind made inert. The panel is anchored near the
 * top (not centred), so a changing height never makes it jump. Used by Dialog and by the welcome screen.
 */
export function Modal({
  open,
  onClose,
  closeOnBackdrop = true,
  role = "dialog",
  initialFocus,
  top = "default",
  className,
  children,
  ...aria
}: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const id = useRef(Symbol("modal"));
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const me = id.current;
    stack.push(me);
    const root = document.getElementById("root");
    root?.setAttribute("inert", "");
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && stack[stack.length - 1] === me) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      stack.splice(stack.indexOf(me), 1);
      if (stack.length === 0) root?.removeAttribute("inert");
    };
  }, [open]);

  // Only the topmost modal traps focus; the ones below wait.
  useFocusTrap(panel, open, initialFocus);

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          key="modal"
          className={cx("fixed inset-0 z-[100] flex items-start justify-center overflow-hidden", top === "compact" ? "pt-[min(5vh,40px)]" : "pt-[min(12vh,120px)]")}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
        >
          <div
            className="absolute inset-0 bg-veil"
            data-modal-backdrop
            onPointerDown={() => {
              if (closeOnBackdrop && stack[stack.length - 1] === id.current) onClose();
            }}
          />
          <motion.div
            ref={panel}
            role={role}
            aria-modal="true"
            tabIndex={-1}
            className={cx("relative max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)] outline-none", className)}
            initial={{ opacity: 0, y: 10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.99 }}
            transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.9 }}
            {...aria}
          >
            {children}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
