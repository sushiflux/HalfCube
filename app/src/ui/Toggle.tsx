import { useId, type ReactNode } from "react";
import { cx } from "./cx.ts";

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

/**
 * On/off switch with the dedicated tokens --c-toggle-on (green) and --c-toggle-off (red). The thumb also carries a
 * symbol (check or dash), so the state never depends on colour alone.
 */
export function Toggle({ checked, onChange, label, disabled, className, "aria-label": ariaLabel }: ToggleProps) {
  const labelId = useId();
  return (
    <span className={cx("inline-flex items-center gap-3", className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={label ? labelId : undefined}
        aria-label={label ? undefined : ariaLabel}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          "relative h-[22px] w-10 flex-none cursor-pointer rounded-ctl transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45",
          checked ? "bg-toggle-on" : "bg-toggle-off",
        )}
      >
        <span
          className={cx(
            "absolute top-[3px] left-[3px] grid size-4 place-items-center rounded-sm bg-surface transition-transform duration-150",
            checked ? "translate-x-[18px] text-toggle-on" : "translate-x-0 text-toggle-off",
          )}
        >
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
            {checked ? (
              <path d="M2.2 6.3l2.5 2.5 5-5.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <path d="M2.6 6h6.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            )}
          </svg>
        </span>
      </button>
      {label ? (
        <span id={labelId} className="text-sm font-medium">
          {label}
        </span>
      ) : null}
    </span>
  );
}
