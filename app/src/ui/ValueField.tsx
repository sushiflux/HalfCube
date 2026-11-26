import type { InputHTMLAttributes, Ref } from "react";
import type { FieldLook } from "../prefs/settings.ts";
import { cx } from "./cx.ts";

export interface ValueFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "size" | "aria-label" | "className"> {
  value: string;
  /** Called with the new text on every keystroke; without it the field only shows its value. */
  onChange?: (text: string) => void;
  /** The unit behind the value, small and muted ("mm", "°"). */
  unit: string;
  /** A sign before the value ("Ø"); it is no part of the text the user types. */
  prefix?: string;
  /** The accessible name. Required: the field has no visible label, the unit and its place say what it is. */
  label: string;
  /** "dimension": calm text on a dimension line (default look); "tag": a filled label (settings dialog). */
  look?: FieldLook;
  /** This field takes the keyboard next (or has it): the focus look, even while the browser focus is elsewhere. */
  active?: boolean;
  /** The text does not read as a value: red, together with aria-invalid and the message next to the field. */
  invalid?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  /** Placement (margins); the size and the look are fixed. */
  className?: string;
}

/** The size of a field in CSS px; fixed, so nothing resizes while digits or states change. */
export const FIELD_SIZE: Record<FieldLook, { w: number; h: number }> = {
  dimension: { w: 112, h: 26 },
  tag: { w: 100, h: 28 },
};

const FRAME_BASE = "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border-solid";
// The state that has the keyboard: 1.5 px; the calm "can be typed into" frame is weaker: 1 px.
const FRAME = `${FRAME_BASE} after:border-[1.5px]`;
const FRAME_THIN = `${FRAME_BASE} after:border`;

const TONE_LINE = {
  // Text on the dimension line: the view's own colour behind it hides the line under the digits. The field that has the
  // keyboard is a light tint of the primary colour inside a 1.5 px frame of the primary colour all round, a wrong value the
  // same in the error colour. The frame is the ::after, laid over the field (pointer-events off), so the field keeps its
  // exact size and nothing moves; the border snaps to whole device pixels, so it stays crisp at any display scaling.
  quiet: "bg-viewport text-fg",
  // Editable but without the keyboard (the other field while Tab moves between them): a plain surface and a thin neutral frame
  // (muted, 3:1 against the view in every theme), no accent colour, so the active field stays the only coloured one.
  editable: `bg-surface text-fg shadow-card ${FRAME_THIN} after:border-muted`,
  active: `bg-field-tint text-fg shadow-card ${FRAME} after:border-primary`,
  invalid: `bg-field-tint-error text-error shadow-card ${FRAME} after:border-error`,
} as const;

const TONE_TAG = {
  // The fill says the state: grey (follows the pointer), the primary colour (active), red (wrong). The text colours are
  // pairs the themes already guarantee at 4.5:1 or better (surface on muted, on-primary on primary, surface on error);
  // the selection is the same pair turned round.
  quiet: "bg-muted text-surface selection:bg-surface selection:text-muted",
  active: "bg-primary text-on-primary selection:bg-on-primary selection:text-primary",
  invalid: "bg-error text-surface selection:bg-surface selection:text-error",
} as const;

/**
 * One value at the geometry: Geist with tabular digits, the unit small and muted, no box around a box. Look "dimension" is
 * calm text (the line it sits on is drawn by the sketch layer), look "tag" a filled label. The tone follows the state:
 * active (it has or takes the keyboard), editable (it can be typed into but does not have the keyboard now), invalid, or
 * quiet (read-only text, no onChange: no frame, no tint). The text selection has its own colour, never the browser's.
 */
export function ValueField({ value, onChange, unit, prefix, label, look = "dimension", active = false, invalid = false, inputRef, className, ...rest }: ValueFieldProps) {
  const tone = invalid ? "invalid" : active ? "active" : onChange ? "editable" : "quiet";
  const size = FIELD_SIZE[look];
  return (
    <label
      data-look={look}
      data-tone={tone}
      data-active={active || undefined}
      style={{ width: size.w, height: size.h }}
      className={cx(
        "relative flex min-w-0 items-center overflow-hidden whitespace-nowrap tabular-nums",
        look === "dimension" ? cx("rounded-sm px-2 text-[14px] font-medium", TONE_LINE[tone]) : cx("rounded-ctl px-2.5 text-[13.5px] font-semibold shadow-card", TONE_TAG[tone === "editable" ? "quiet" : tone]),
        className,
      )}
    >
      {prefix ? (
        <span aria-hidden="true" className={cx("mr-1 flex-none font-medium", look === "dimension" && "text-muted")}>
          {prefix}
        </span>
      ) : null}
      <input
        ref={inputRef}
        value={value}
        readOnly={onChange === undefined}
        aria-label={label}
        aria-invalid={invalid ? true : undefined}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange?.(event.currentTarget.value)}
        className={cx(
          "min-w-0 flex-1 bg-transparent p-0 text-right font-[inherit] text-inherit outline-none",
          // The selection is the solid frame colour with its own text colour (t10/t21 pairs): a tint of it would hardly differ
          // from the field's own tint.
          look === "dimension" ? cx("caret-primary", invalid ? "selection:bg-error selection:text-surface" : "selection:bg-primary selection:text-on-primary") : "caret-current",
        )}
        {...rest}
      />
      <span aria-hidden="true" className={cx("ml-1 flex-none text-[11px] font-medium", look === "dimension" && "text-muted")}>
        {unit}
      </span>
    </label>
  );
}
