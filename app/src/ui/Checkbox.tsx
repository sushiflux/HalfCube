import type { InputHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx.ts";
import { IconCheck } from "./icons.tsx";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  /** The label in the muted colour (default, forms) or in the text colour with weight 500 (rows of a panel). */
  tone?: "muted" | "text";
  /** A row icon between the box and the label. */
  icon?: ReactNode;
}

/** A real checkbox (keyboard, screen readers) drawn with the theme tokens. */
export function Checkbox({ checked, onChange, label, tone = "muted", icon, className, ...rest }: CheckboxProps) {
  return (
    <label className={cx("relative inline-flex cursor-pointer items-center gap-2.5 text-[13px] select-none", tone === "text" ? "font-medium text-fg" : "text-muted", className)}>
      <input
        type="checkbox"
        // The real input is invisible and lies exactly over the drawn box, so it is the element under the
        // pointer there (clicks and tools hit the input itself). The label text stays a plain label click
        // that forwards to the input. The box is an in-flow sibling and paints below the positioned input;
        // the check icon is positioned too but ignores the pointer.
        className="peer absolute top-1/2 left-0 m-0 size-[18px] -translate-y-1/2 cursor-pointer appearance-none opacity-0"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        {...rest}
      />
      <span className="grid size-[18px] flex-none place-items-center rounded-ctl border border-line-strong bg-surface peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary" />
      <IconCheck
        size={14}
        className="pointer-events-none absolute top-1/2 left-[2px] hidden -translate-y-1/2 text-on-primary peer-checked:inline-block"
      />
      {icon ? <span className="flex-none text-[16px] text-muted">{icon}</span> : null}
      <span>{label}</span>
    </label>
  );
}
