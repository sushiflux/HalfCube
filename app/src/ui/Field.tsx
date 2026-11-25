import { useId, useState, type HTMLInputTypeAttribute } from "react";
import { useT } from "../i18n/runtime.ts";
import { cx } from "./cx.ts";
import { IconAlert, IconInfo } from "./icons.tsx";
import { evaluateField, visibleServerError, type Rule, type RuleIssue, type ServerErrorState } from "./rules.ts";

export interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rules?: readonly Rule[];
  /** Set by the form after a submit attempt: then every problem is marked, also in untouched empty fields. */
  submitAttempted?: boolean;
  /** The server's answer about this field. It disappears the moment the field is edited. */
  serverError?: string | undefined;
  /** Neutral help text under the field while there is no problem. */
  hint?: string;
  type?: HTMLInputTypeAttribute;
  name?: string;
  placeholder?: string;
  autoComplete?: string;
  inputMode?: "text" | "numeric" | "decimal" | "email" | "search" | "tel" | "url";
  disabled?: boolean;
  className?: string;
}

/**
 * The one form field: label, input, and a message line that reacts on every keystroke. The room for the longest
 * possible message is reserved, so a message never moves anything. A problem shows as aria-invalid plus text plus an
 * icon, never as colour alone.
 */
export function Field({
  label,
  value,
  onChange,
  rules = [],
  submitAttempted = false,
  serverError,
  hint,
  type = "text",
  name,
  placeholder,
  autoComplete,
  inputMode,
  disabled,
  className,
}: FieldProps) {
  const t = useT();
  const id = useId();
  const messageId = `${id}-msg`;
  const [dirty, setDirty] = useState(false);

  // Remember the value a server answer was about; the answer is shown only while the value is unchanged.
  const [seen, setSeen] = useState<{ message: string | undefined; state: ServerErrorState | undefined }>({
    message: undefined,
    state: undefined,
  });
  let serverState = seen.state;
  if (serverError !== seen.message) {
    serverState = serverError === undefined ? undefined : { message: serverError, forValue: value };
    setSeen({ message: serverError, state: serverState });
  }

  const issue: RuleIssue | undefined = evaluateField({ value, rules, dirty, submitAttempted });
  const text = issue ? t(issue.key, issue.params) : visibleServerError(serverState, value);
  const invalid = text !== undefined;

  const shown = text ?? hint;
  // Invisible candidates: the slot is as tall as the longest message that can appear in it.
  const ghosts = [
    ...rules.flatMap((rule) => (rule.reserve ? [t(rule.reserve.key, rule.reserve.params)] : [])),
    ...(hint ? [hint] : []),
  ];

  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        disabled={disabled}
        spellCheck={false}
        aria-invalid={invalid}
        aria-describedby={shown ? messageId : undefined}
        onChange={(event) => {
          setDirty(true);
          onChange(event.currentTarget.value);
        }}
        className={cx(
          "h-9 w-full rounded-ctl border bg-surface px-3 text-sm text-fg placeholder:text-muted disabled:opacity-45",
          invalid ? "border-destructive" : "border-line-strong",
        )}
      />
      <div className="grid min-h-[18px] text-[12.5px] leading-[18px]">
        {ghosts.map((ghost, index) => (
          <span key={index} aria-hidden="true" className="invisible col-start-1 row-start-1 select-none">
            {ghost}
          </span>
        ))}
        {shown ? (
          <span
            id={messageId}
            role={invalid ? "alert" : undefined}
            className={cx(
              "col-start-1 row-start-1 flex items-start gap-1.5",
              invalid ? "text-destructive" : "text-muted",
            )}
          >
            <span className="mt-[2px] inline-flex text-sm">{invalid ? <IconAlert /> : <IconInfo />}</span>
            <span>{shown}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
