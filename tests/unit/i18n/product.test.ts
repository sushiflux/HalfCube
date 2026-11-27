// The product name in the message catalogues: written as {product} in de.ts and en.ts, filled in from branding/branding.json when
// the catalogues load, so every message reads the same as before and the name is not repeated in 68 strings.
import { describe, expect, it } from "vitest";
import { branding } from "../../../app/src/branding.ts";
import { bindProduct, catalogues, makeState, PRODUCT_PLACEHOLDER } from "../../../app/src/i18n/core.ts";
import { de } from "../../../app/src/i18n/de.ts";
import { en } from "../../../app/src/i18n/en.ts";

function strings(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (typeof node === "object" && node !== null) for (const value of Object.values(node)) strings(value, out);
  return out;
}

describe("{product} in the catalogues", () => {
  it("is used in the sources and no message of the loaded catalogues still carries the placeholder", () => {
    for (const source of [de, en]) expect(strings(source).filter((s) => s.includes(PRODUCT_PLACEHOLDER)).length).toBeGreaterThan(20);
    for (const language of ["de", "en"] as const) {
      expect(strings(catalogues[language]).filter((s) => s.includes(PRODUCT_PLACEHOLDER))).toEqual([]);
    }
  });

  it("gives the visible texts with the name from branding.json, in both languages", () => {
    expect(makeState("de").t("about.title")).toBe(`Über ${branding.name}`);
    expect(makeState("en").t("about.title")).toBe(`About ${branding.name}`);
    expect(makeState("de").t("updates.slotUpToDate")).toBe(`${branding.name} ist aktuell`);
  });

  it("does not collide with the {name} parameter some messages take", () => {
    const text = makeState("de").t("updates.restart.message", { name: "Gehäuse", steps: "3 Schritte" });
    expect(text).toContain(`${branding.name} kann Entwürfe noch nicht speichern`);
    expect(text).toContain("„Gehäuse“");
  });

  it("replaces every occurrence, also in nested objects and arrays, and leaves other braces alone", () => {
    expect(bindProduct({ a: "{product} und {product}", b: { c: ["x {product}", "{keep}"] } }, "Name")).toEqual({ a: "Name und Name", b: { c: ["x Name", "{keep}"] } });
    expect(bindProduct("{product}$&", "A$B")).toBe("A$B$&");
  });
});
