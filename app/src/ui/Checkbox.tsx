import type { InputHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx.ts";
import { IconCheck } from "./icons.tsx";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
}

/** A real checkbox (keyboard, screen readers) drawn with the theme tokens. */
export function Checkbox({ checked, onChange, label, className, ...rest }: CheckboxProps) {
  return (
    <label className={cx("relative inline-flex cursor-pointer items-center gap-2.5 text-[13px] text-muted select-none", className)}>
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        {...rest}
      />
      <span className="grid size-[18px] flex-none place-items-center rounded-ctl border border-line-strong bg-surface peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary" />
      <IconCheck
        size={14}
        className="pointer-events-none absolute top-1/2 left-[2px] hidden -translate-y-1/2 text-on-primary peer-checked:inline-block"
      />
      <span>{label}</span>
    </label>
  );
}
