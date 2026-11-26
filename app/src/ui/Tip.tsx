import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import "./tip.css";

/**
 * Our own tooltip (never the browser's title attribute): a short text under the control, shown on hover and keyboard focus
 * after a short delay. It is drawn by CSS from `data-tip`, takes no layout space and wraps instead of being cut. The control
 * inside still carries its own aria-label; this is only the visible hint.
 */
export function Tip({
  label,
  children,
  align = "center",
  side = "bottom",
  className,
}: {
  label: string;
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom";
  className?: string;
}) {
  return (
    <span className={cx("pc-tip", className)} data-tip={label} data-align={align} data-side={side}>
      {children}
    </span>
  );
}
