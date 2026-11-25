import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { branding, parseBranding } from "../../app/src/branding.ts";
import { repoRoot } from "../../config/build-info.ts";

describe("parseBranding", () => {
  it("accepts name and slug", () => {
    expect(parseBranding({ name: " Example ", slug: "example-app" })).toEqual({ name: "Example", slug: "example-app" });
  });

  it.each([null, "text", 42, {}, { name: "", slug: "x" }, { name: "X" }, { name: 1, slug: "x" }])("rejects %j", (bad) => {
    expect(() => parseBranding(bad)).toThrow(/branding\.json/);
  });

  it.each(["Upper", "with space", "-lead", "trail-", "double--hyphen", ""])("rejects the slug %j", (slug) => {
    expect(() => parseBranding({ name: "X", slug })).toThrow(/slug/);
  });
});

describe("branding.json of the repository", () => {
  it("loads and is valid", () => {
    expect(branding.name).not.toBe("");
    expect(branding.slug).toMatch(/^[a-z0-9-]+$/);
  });

  it("matches the package name (the one place that cannot read branding.json)", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { name: string };
    expect(pkg.name).toBe(branding.slug);
  });
});
