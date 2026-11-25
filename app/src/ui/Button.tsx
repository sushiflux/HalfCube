import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cx } from "./cx.ts";

/**
 * Button roles, used identically on every surface:
 * - primary: the main action of a view or group (only one filled button per group)
 * - create: makes something new
 * - destructive: deletes or discards
 * - neutral: everything else (outlined)
 * - quiet: frameless text button for list actions and toolbars
 */
export type ButtonVariant = "primary" | "create" | "destructive" | "neutral" | "quiet";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "md" | "lg";
  icon?: ReactNode;
  /** The spinner goes over the invisible label, so the button never changes size. */
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

const variants: Record<ButtonVariant, string> = {
  primary: "border-primary bg-primary text-on-primary font-semibold",
  create: "border-create bg-create text-on-create font-semibold",
  destructive: "border-destructive bg-destructive text-on-destructive font-semibold",
  neutral: "border-line-strong bg-transparent text-fg font-medium hover:bg-surface-2",
  quiet: "border-transparent bg-transparent text-muted font-medium hover:text-fg",
};

const filled = new Set<ButtonVariant>(["primary", "create", "destructive"]);

export function Button({
  variant = "neutral",
  size = "md",
  icon,
  loading = false,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-variant={variant}
      className={cx(
        "relative inline-flex cursor-pointer items-center justify-center gap-2 rounded-ctl border whitespace-nowrap select-none",
        "disabled:cursor-not-allowed disabled:opacity-45",
        size === "lg" ? "h-[38px] px-4 text-sm" : "h-9 px-3.5 text-[13.5px]",
        variants[variant],
        filled.has(variant) && "hover:brightness-95 dark:hover:brightness-110",
        className,
      )}
      {...rest}
    >
      <span className={cx("inline-flex items-center gap-2", loading && "invisible")}>
        {icon ? <span className="inline-flex text-base">{icon}</span> : null}
        {children}
      </span>
      {loading ? (
        <span className="absolute inset-0 grid place-items-center" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="16" height="16">
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity=".3" strokeWidth="2" />
            <path
              d="M8 2a6 6 0 0 1 6 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              style={{ transformOrigin: "50% 50%", animation: "pc-spin 0.9s linear infinite" }}
            />
          </svg>
        </span>
      ) : null}
    </button>
  );
}

/** Frameless icon button; the hit target is 40 px even though the icon is small. */
export function IconButton({
  label,
  className,
  children,
  type = "button",
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & { label: string }) {
  return (
    <button
      type={type}
      aria-label={label}
      className={cx(
        "inline-grid size-10 cursor-pointer place-items-center rounded-ctl text-lg text-muted hover:text-fg disabled:opacity-45",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
