import { describe, expect, it } from "vitest";
import { catalogues, formatMessage, lookup } from "../../../app/src/i18n/core.ts";
import {
  evaluateField,
  isValid,
  maxLength,
  minLength,
  numberRule,
  parseNumber,
  pattern,
  repeatOf,
  required,
  visibleServerError,
  type Rule,
  type RuleIssue,
} from "../../../app/src/ui/rules.ts";

const calm = { dirty: false, submitAttempted: false };
const typed = { dirty: true, submitAttempted: false };
const submitted = { dirty: true, submitAttempted: true };

const text = (issue: RuleIssue | undefined, lang: "de" | "en" = "de"): string | undefined =>
  issue ? formatMessage(lookup(catalogues[lang], issue.key), issue.params) : undefined;

describe("live validation: when a problem shows", () => {
  const rules: Rule[] = [required(), minLength(8)];

  it("keeps an untouched empty field calm", () => {
    expect(evaluateField({ value: "", rules, ...calm })).toBeUndefined();
  });

  it("shows 'required' after typing and emptying again", () => {
    expect(text(evaluateField({ value: "", rules, ...typed }))).toBe("Pflichtfeld: bitte einen Wert eingeben.");
  });

  it("shows the rule with the current state on every keystroke", () => {
    expect(text(evaluateField({ value: "abcde", rules, ...typed }))).toBe("Zu kurz: 5 von mindestens 8 Zeichen.");
    expect(text(evaluateField({ value: "abcde", rules, ...typed }), "en")).toBe("Too short: 5 of at least 8 characters.");
    expect(text(evaluateField({ value: "abcdefg", rules, ...typed }))).toBe("Zu kurz: 7 von mindestens 8 Zeichen.");
  });

  it("disappears the moment the value is fine", () => {
    expect(evaluateField({ value: "abcdefgh", rules, ...typed })).toBeUndefined();
  });

  it("a submit attempt marks an untouched empty field", () => {
    expect(evaluateField({ value: "", rules, dirty: false, submitAttempted: true })?.key).toBe("rules.required");
  });

  it("an optional empty field is fine even after a submit attempt", () => {
    expect(evaluateField({ value: "", rules: [minLength(8)], ...submitted })).toBeUndefined();
  });

  it("reports the first failing rule only", () => {
    expect(evaluateField({ value: "", rules: [required(), minLength(3)], ...typed })?.key).toBe("rules.required");
  });
});

describe("rules", () => {
  it("maxLength states the current length", () => {
    expect(text(evaluateField({ value: "x".repeat(25), rules: [maxLength(20)], ...typed }))).toBe(
      "Zu lang: 25 von höchstens 20 Zeichen.",
    );
  });

  it("pattern names the expected format", () => {
    const rule = pattern(/^[a-z]+$/, "nur Kleinbuchstaben");
    expect(text(evaluateField({ value: "ab1", rules: [rule], ...typed }))).toBe("Ungültiges Format: nur Kleinbuchstaben");
    expect(evaluateField({ value: "ab", rules: [rule], ...typed })).toBeUndefined();
  });

  it("parses numbers with a decimal comma or point", () => {
    expect(parseNumber("12,5")).toBe(12.5);
    expect(parseNumber(" -3.25 ")).toBe(-3.25);
    expect(parseNumber(".5")).toBe(0.5);
    expect(parseNumber("1,2,3")).toBeUndefined();
    expect(parseNumber("abc")).toBeUndefined();
    expect(parseNumber("")).toBeUndefined();
  });

  it("numberRule checks the range", () => {
    const rule = numberRule({ min: 0, max: 10 });
    expect(evaluateField({ value: "5", rules: [rule], ...typed })).toBeUndefined();
    expect(evaluateField({ value: "x", rules: [rule], ...typed })?.key).toBe("rules.notANumber");
    expect(text(evaluateField({ value: "11", rules: [rule], ...typed }))).toBe(
      "Außerhalb des Bereichs: 11 liegt nicht zwischen 0 und 10.",
    );
  });

  it("every rule that can fail has a message in both languages and reserves room for its worst case", () => {
    const rules = [required(), minLength(8), maxLength(20), pattern(/x/, "x"), numberRule({ min: 1, max: 9 }), repeatOf(() => "a")];
    for (const rule of rules) {
      expect(rule.reserve).toBeDefined();
      for (const lang of ["de", "en"] as const) {
        const reserved = rule.reserve ? text(rule.reserve, lang) : undefined;
        expect(reserved).toBeTruthy();
        expect(reserved).not.toContain("{");
      }
    }
  });
});

describe("repeat fields", () => {
  let first = "secret123";
  const rules = [repeatOf(() => first)];

  it("stays calm while the repeat can still become the match", () => {
    expect(evaluateField({ value: "sec", rules, ...typed })).toBeUndefined();
    expect(evaluateField({ value: "secret123", rules, ...typed })).toBeUndefined();
  });

  it("flags as soon as the repeat can no longer become the match", () => {
    expect(evaluateField({ value: "sex", rules, ...typed })?.key).toBe("rules.mismatch");
    expect(evaluateField({ value: "secret1234", rules, ...typed })?.key).toBe("rules.mismatch");
  });

  it("a submit attempt requires equality, an unfinished repeat counts as a mismatch then", () => {
    expect(evaluateField({ value: "sec", rules, ...submitted })?.key).toBe("rules.mismatch");
    expect(evaluateField({ value: "", rules, ...submitted })?.key).toBe("rules.mismatch");
    expect(evaluateField({ value: "secret123", rules, ...submitted })).toBeUndefined();
  });

  it("re-checks when the first field changes", () => {
    expect(evaluateField({ value: "secret", rules, ...typed })).toBeUndefined();
    first = "other";
    expect(evaluateField({ value: "secret", rules, ...typed })?.key).toBe("rules.mismatch");
  });
});

describe("never send what the form shows as red", () => {
  it("isValid applies the rules as a submit would", () => {
    const rules = [required(), minLength(8)];
    expect(isValid("", rules)).toBe(false);
    expect(isValid("abc", rules)).toBe(false);
    expect(isValid("abcdefgh", rules)).toBe(true);
    expect(isValid("", [repeatOf(() => "a")])).toBe(false);
  });
});

describe("server answers", () => {
  it("are shown only while the field still holds the value they were about", () => {
    const state = { message: "Name bereits vergeben", forValue: "anna" };
    expect(visibleServerError(state, "anna")).toBe("Name bereits vergeben");
    expect(visibleServerError(state, "anna2")).toBeUndefined();
    expect(visibleServerError(state, "ann")).toBeUndefined();
    expect(visibleServerError(undefined, "anna")).toBeUndefined();
  });
});
