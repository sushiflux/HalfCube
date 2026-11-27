// The real generated data (app/src/about/third-party.generated.ts) as the About view uses it: the facts the view relies on.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildItems, kernelVersion, lgplItems, lgplLibraries, searchItems } from "../../../app/src/about/catalogue.ts";
import { isLicenceTextPath } from "../../../app/src/about/licence-text.ts";
import { thirdParty } from "../../../app/src/about/licences-data.ts";

const publicRoot = join(import.meta.dirname, "../../../app/public");

describe("the generated third-party data", () => {
  it("has unique ids the address can carry and a usable text path", () => {
    const ids = thirdParty.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const problems = thirdParty.flatMap((e) => [
      ...(/^[a-z0-9][a-z0-9._-]{0,63}$/.test(e.id) ? [] : [`${e.id}: id is not a plain id`]),
      ...(e.textFile === null || isLicenceTextPath(e.textFile) ? [] : [`${e.id}: unusable text path ${e.textFile}`]),
    ]);
    expect(problems).toEqual([]);
  });

  it("ships the project's own two texts and every text file the data names", () => {
    expect(existsSync(join(publicRoot, "licenses/halfcube-license.txt"))).toBe(true);
    expect(existsSync(join(publicRoot, "licenses/halfcube-notice.txt"))).toBe(true);
    expect(readFileSync(join(publicRoot, "licenses/halfcube-license.txt"), "utf8")).toContain("PolyForm Shield License 1.0.0");
    const missing = thirdParty.filter((e) => e.textFile !== null && !existsSync(join(publicRoot, e.textFile))).map((e) => `${e.id}: ${e.textFile}`);
    expect(missing).toEqual([]);
  });

  it("lists the desktop shell components", () => {
    const items = buildItems(thirdParty, "x");
    expect(items.some((i) => i.id === "electron")).toBe(true);
    expect(items.some((i) => i.id === "chromium")).toBe(true);
  });

  it("gives the kernel version and exactly the two LGPL components, with the notices the Info tab shows", () => {
    const items = buildItems(thirdParty, "x");
    expect(kernelVersion(items)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lgplItems(items).map((i) => i.id)).toEqual(["occt", "planegcs"]);
    const line = lgplLibraries(items, "and");
    expect(line).toContain("Open CASCADE Technology (© ");
    expect(line).toMatch(/OPEN CASCADE SAS\) and planegcs \(© /);
    expect(line).not.toMatch(/@/);
  });

  it("finds the entries by what a person types", () => {
    const items = buildItems(thirdParty, "x");
    expect(searchItems(items, "cascade", "en").map((i) => i.id)).toContain("occt");
    expect(searchItems(items, "chromium", "de").map((i) => i.id)).toContain("chromium");
  });
});
