// Validation rules for form fields: the one rules module. A rule returns an issue (a catalogue key plus parameters)
// instead of a finished sentence, so the message follows the UI language and can state the current state
// ("Zu kurz: 5 von mindestens 8 Zeichen.").
//
// Rules come from the server as one source later; the client is never stricter than the server. These are the
// building blocks both sides describe their rules with.
import type { MessageKey, MessageParams } from "../i18n/types.ts";

export interface RuleIssue {
  key: MessageKey;
  params?: MessageParams;
}

export interface RuleContext {
  /** A submit was attempted: states that are merely unfinished while typing count as errors now. */
  final: boolean;
}

export interface Rule {
  id: string;
  /** Returns the problem, or undefined when the value is fine. */
  check(value: string, context: RuleContext): RuleIssue | undefined;
  /** Rules skip an empty value (an optional field is fine when empty) unless they say otherwise. */
  appliesToEmpty?: boolean;
  /** The worst-case message of this rule, used to reserve room for it so nothing moves when it appears. */
  reserve?: RuleIssue;
}

/** The field must not be empty. Shown after typing and emptying, or after a submit attempt. */
export function required(): Rule {
  return {
    id: "required",
    appliesToEmpty: true,
    check: (value) => (value.trim() === "" ? { key: "rules.required" } : undefined),
    reserve: { key: "rules.required" },
  };
}

export function minLength(min: number): Rule {
  return {
    id: "minLength",
    check: (value) =>
      value.length < min ? { key: "rules.tooShort", params: { current: value.length, min } } : undefined,
    reserve: { key: "rules.tooShort", params: { current: Math.max(0, min - 1), min } },
  };
}

export function maxLength(max: number): Rule {
  return {
    id: "maxLength",
    check: (value) =>
      value.length > max ? { key: "rules.tooLong", params: { current: value.length, max } } : undefined,
    reserve: { key: "rules.tooLong", params: { current: max + 99, max } },
  };
}

/** `expected` is a short description of the format, shown after "Ungültiges Format:". */
export function pattern(regex: RegExp, expected: string): Rule {
  return {
    id: "pattern",
    check: (value) => (regex.test(value) ? undefined : { key: "rules.invalidFormat", params: { expected } }),
    reserve: { key: "rules.invalidFormat", params: { expected } },
  };
}

/** Accepts "12,5" and "12.5". Returns the number for other code via parseNumber. */
export function parseNumber(value: string): number | undefined {
  const normalized = value.trim().replace(",", ".");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(normalized)) return undefined;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : undefined;
}

export function numberRule(range?: { min?: number; max?: number }): Rule {
  const min = range?.min ?? -Infinity;
  const max = range?.max ?? Infinity;
  return {
    id: "number",
    check(value) {
      const n = parseNumber(value);
      if (n === undefined) return { key: "rules.notANumber" };
      if (n < min || n > max) {
        return { key: "rules.outOfRange", params: { value: value.trim(), min: String(min), max: String(max) } };
      }
      return undefined;
    },
    reserve: { key: "rules.outOfRange", params: { value: "000000", min: String(min), max: String(max) } },
  };
}

/**
 * A repeat field. It is flagged as soon as it can no longer become the match (the other value does not start with
 * what was typed); while it is still a correct beginning it stays calm. After a submit attempt it has to be equal.
 * Reading the other value through a function re-checks this field whenever the first one changes.
 */
export function repeatOf(other: () => string): Rule {
  return {
    id: "repeat",
    appliesToEmpty: true,
    check(value, { final }) {
      const first = other();
      if (value === "") return final && first !== "" ? { key: "rules.mismatch" } : undefined;
      if (final) return value === first ? undefined : { key: "rules.mismatch" };
      return first.startsWith(value) ? undefined : { key: "rules.mismatch" };
    },
    reserve: { key: "rules.mismatch" },
  };
}

export interface FieldStateInput {
  value: string;
  rules: readonly Rule[];
  /** The user has typed in the field at least once (also true after typing and emptying it again). */
  dirty: boolean;
  /** The form was submitted at least once: every problem in every field is marked. */
  submitAttempted: boolean;
}

/**
 * The problem to show for a field right now, or undefined. Live: every keystroke counts, no waiting for blur.
 * An untouched empty field stays calm.
 */
export function evaluateField({ value, rules, dirty, submitAttempted }: FieldStateInput): RuleIssue | undefined {
  const empty = value === "";
  if (empty && !dirty && !submitAttempted) return undefined;
  const context: RuleContext = { final: submitAttempted };
  for (const rule of rules) {
    if (empty && !rule.appliesToEmpty) continue;
    const issue = rule.check(value, context);
    if (issue) return issue;
  }
  return undefined;
}

/** True when the value passes every rule as a submit would see it. Never send what the form shows as red. */
export function isValid(value: string, rules: readonly Rule[]): boolean {
  return evaluateField({ value, rules, dirty: true, submitAttempted: true }) === undefined;
}

export interface ServerErrorState {
  message: string;
  /** The field value at the moment the answer arrived. */
  forValue: string;
}

/** A server answer about a field is shown only while the field still holds the value it was about. */
export function visibleServerError(state: ServerErrorState | undefined, value: string): string | undefined {
  return state && state.forValue === value ? state.message : undefined;
}
