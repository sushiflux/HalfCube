import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx.ts";
import { Tip } from "./Tip.tsx";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  testId?: string;
  /** Shown but not choosable (a choice that comes in a later version); `hint` says why, as its tooltip text. */
  disabled?: boolean;
  hint?: string;
}

export interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  /** Names the group for screen readers. */
  label: string;
  /** A vertical list when the options do not fit in one row; the accent line then sits on the left edge. */
  orientation?: "horizontal" | "vertical";
  className?: string;
  /** Marks the group as tabs of a tab bar instead of a choice (role tablist / tab). */
  tabs?: boolean;
  /** "sm": the compact bar of floating dialogs (28 px high, 12 px text). */
  size?: "md" | "sm";
}

/**
 * One connected thin segmented bar. The active segment carries a thin straight accent line: on its bottom edge in a row, on
 * its left edge in a vertical list. A radio group (arrow keys move and choose); with `tabs` a tab list.
 */
export function Segmented<T extends string>({ value, onChange, options, label, orientation = "horizontal", className, tabs = false, size = "md" }: SegmentedProps<T>) {
  const vertical = orientation === "vertical";
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const groupId = useId();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = vertical ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
    const forward = event.key === keys[1];
    if (!forward && event.key !== keys[0]) return;
    event.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    // The next option that can be chosen (disabled ones are skipped).
    let next: SegmentedOption<T> | undefined;
    for (let step = 1; step <= options.length; step++) {
      const candidate = options[(i + (forward ? step : options.length - step)) % options.length];
      if (candidate && !candidate.disabled) {
        next = candidate;
        break;
      }
    }
    if (!next || next.value === value) return;
    onChange(next.value);
    refs.current[options.indexOf(next)]?.focus();
  };

  return (
    <div
      role={tabs ? "tablist" : "radiogroup"}
      aria-label={label}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      onKeyDown={onKeyDown}
      className={cx(
        "inline-flex overflow-hidden rounded-ctl border border-line-strong bg-surface",
        vertical ? "flex-col" : "flex-row",
        className,
      )}
    >
      {options.map((option, index) => {
        const active = option.value === value;
        const button = (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            id={`${groupId}-${option.value}`}
            type="button"
            role={tabs ? "tab" : "radio"}
            aria-checked={tabs ? undefined : active}
            aria-selected={tabs ? active : undefined}
            tabIndex={active ? 0 : -1}
            data-testid={option.testId}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cx(
              "relative inline-flex cursor-pointer items-center whitespace-nowrap outline-offset-[-3px]",
              size === "sm" ? "h-7 gap-1.5 px-2 text-[12px]" : "h-9 gap-2 px-3.5 text-[13.5px]",
              vertical ? "justify-start" : "justify-center",
              index > 0 && (vertical ? "border-t border-line" : "border-l border-line"),
              active ? "bg-primary-soft font-semibold text-fg" : "font-medium text-muted hover:bg-surface-2 hover:text-fg",
              option.disabled && "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted",
            )}
          >
            {option.label}
            {active ? (
              <span
                aria-hidden="true"
                className={cx("absolute bg-primary", vertical ? "top-0 bottom-0 left-0 w-[3px]" : "right-0 bottom-0 left-0 h-[3px]")}
              />
            ) : null}
          </button>
        );
        // A disabled choice says why in our own tooltip (never the browser's title).
        return option.disabled && option.hint ? (
          <Tip key={option.value} label={option.hint} className="self-stretch">
            {button}
          </Tip>
        ) : (
          button
        );
      })}
    </div>
  );
}
