import { describe, expect, it } from "vitest";
import { checkDistance, distanceText, formFromHandle, formFromParams, signedDistance, type ExtrudeForm } from "../../../app/src/screens/main/extrude-form.ts";

const form = (patch: Partial<ExtrudeForm> = {}): ExtrudeForm => ({ text: "10", reversed: false, extent: "oneSide", ...patch });

describe("distanceText", () => {
  it("writes the number without the unit, up to 6 decimals, with the decimal comma in German", () => {
    expect(distanceText(12.5, false)).toBe("12.5");
    expect(distanceText(12.5, true)).toBe("12,5");
    expect(distanceText(10, true)).toBe("10");
    expect(distanceText(0.1 + 0.2, false)).toBe("0.3");
    expect(distanceText(1 / 3, false)).toBe("0.333333");
  });
  it("shows the magnitude: the direction is the switch's business", () => {
    expect(distanceText(-6, false)).toBe("6");
  });
});

describe("formFromParams", () => {
  it("reads a negative one-side distance as the opposite direction", () => {
    expect(formFromParams({ extent: "oneSide", distance: { value: -6.5, unit: "mm" } }, true)).toEqual({ text: "6,5", reversed: true, extent: "oneSide" });
  });
  it("symmetric has no direction, whatever the sign was", () => {
    expect(formFromParams({ extent: "symmetric", distance: { value: -6, unit: "mm" } }, false).reversed).toBe(false);
  });
});

describe("checkDistance (live validation of the field)", () => {
  it("accepts a number with an optional length unit and the decimal comma", () => {
    expect(checkDistance("12,5")).toEqual({ ok: true, value: { value: 12.5, unit: "mm" } });
    expect(checkDistance("4 cm")).toEqual({ ok: true, value: { value: 40, unit: "mm" } });
  });
  it("names what is wrong: nothing typed, not a number, a unit of the wrong kind, zero or negative, too large", () => {
    expect(checkDistance("")).toMatchObject({ ok: false, error: "empty" });
    expect(checkDistance("abc")).toMatchObject({ ok: false, error: "notANumber" });
    expect(checkDistance("30°")).toMatchObject({ ok: false, error: "wrongUnit" });
    expect(checkDistance("0")).toMatchObject({ ok: false, error: "notPositive" });
    expect(checkDistance("-5")).toMatchObject({ ok: false, error: "notPositive" });
    expect(checkDistance("1000000")).toMatchObject({ ok: false, error: "tooLarge" });
  });
});

describe("signedDistance", () => {
  const mm = { value: 8, unit: "mm" as const };
  it("one side: positive along the sketch normal, negative against it", () => {
    expect(signedDistance(form(), mm).value).toBe(8);
    expect(signedDistance(form({ reversed: true }), mm).value).toBe(-8);
  });
  it("symmetric is the total thickness, always positive", () => {
    expect(signedDistance(form({ extent: "symmetric", reversed: true }), mm).value).toBe(8);
  });
});

describe("formFromHandle", () => {
  it("one side: the arrow's sign is the direction, its length the distance", () => {
    expect(formFromHandle(form(), -12.25, false)).toMatchObject({ text: "12.25", reversed: true });
    expect(formFromHandle(form({ reversed: true }), 3, true)).toMatchObject({ text: "3", reversed: false });
  });
  it("symmetric: only the thickness changes", () => {
    expect(formFromHandle(form({ extent: "symmetric", reversed: true }), -4, false)).toMatchObject({ text: "4", reversed: true, extent: "symmetric" });
  });
});
