import { describe, expect, it } from "vitest";
import {
  buildItems,
  compactCopyright,
  findItem,
  groupItems,
  holderOfCopyrightLine,
  kernelVersion,
  lgplItems,
  lgplLibraries,
  LICENCE_ITEM,
  listLicence,
  NOTICE_ITEM,
  pickText,
  searchItems,
  shortName,
} from "../../../app/src/about/catalogue.ts";
import { catalogues } from "../../../app/src/i18n/core.ts";
import { fixture } from "./fixture.ts";

const desktop = buildItems(fixture, "desktop", "2026.11.6.12.24867");
const browser = buildItems(fixture, "browser", "2026.11.6.12.24867");

describe("buildItems: platform filter", () => {
  it("lists the project's own texts first, then the data in its order", () => {
    expect(desktop.map((i) => i.id)).toEqual(["partcraft", "notice", "occt", "planegcs", "react", "electron", "chromium"]);
  });

  it("leaves out entries without 'browser' in the browser version, so no desktop-only entry shows up there", () => {
    expect(browser.map((i) => i.id)).toEqual(["partcraft", "notice", "occt", "planegcs", "react"]);
    expect(browser.some((i) => i.group === "shell")).toBe(false);
  });

  it("carries the running version on the Partcraft entry and points to the project's two texts", () => {
    const own = findItem(desktop, LICENCE_ITEM);
    expect(own?.version).toBe("2026.11.6.12.24867");
    expect(own?.textFile).toBe("licenses/partcraft-license.txt");
    expect(findItem(desktop, NOTICE_ITEM)?.textFile).toBe("licenses/partcraft-notice.txt");
  });
});

describe("groupItems", () => {
  it("uses the fixed order self, engine, ui, shell and leaves out a group without items", () => {
    expect(groupItems(desktop).map((g) => g.group)).toEqual(["self", "engine", "ui", "shell"]);
    expect(groupItems(browser).map((g) => g.group)).toEqual(["self", "engine", "ui"]);
    expect(groupItems([])).toEqual([]);
  });

  it("keeps the items of a group in their order", () => {
    expect(groupItems(desktop).find((g) => g.group === "engine")?.items.map((i) => i.id)).toEqual(["occt", "planegcs"]);
  });
});

describe("searchItems", () => {
  it("returns everything for an empty query", () => {
    expect(searchItems(desktop, "  ", "en")).toHaveLength(desktop.length);
  });

  it("finds by name, licence, copyright and purpose, without caring about case", () => {
    expect(searchItems(desktop, "cascade", "en").map((i) => i.id)).toEqual(["occt"]);
    expect(searchItems(desktop, "MIT", "en").map((i) => i.id)).toEqual(["react", "electron"]);
    expect(searchItems(desktop, "poulios", "en").map((i) => i.id)).toEqual(["planegcs"]);
    expect(searchItems(desktop, "solver", "en").map((i) => i.id)).toEqual(["planegcs"]);
  });

  it("needs every word to match, in any order", () => {
    expect(searchItems(desktop, "kernel geometry", "en").map((i) => i.id)).toEqual(["occt"]);
    expect(searchItems(desktop, "kernel solver", "en")).toEqual([]);
  });

  it("searches the texts of the active language", () => {
    expect(searchItems(desktop, "löser", "de").map((i) => i.id)).toEqual(["planegcs"]);
    expect(searchItems(desktop, "löser", "en")).toEqual([]);
  });

  it("never returns an entry the platform filter removed", () => {
    expect(searchItems(browser, "electron", "en")).toEqual([]);
  });
});

describe("text helpers", () => {
  it("picks the language of a localized text and passes plain strings through", () => {
    expect(pickText({ de: "a", en: "b" }, "en")).toBe("b");
    expect(pickText("x", "de")).toBe("x");
    expect(pickText(undefined, "de")).toBe("");
  });

  it("shows the friendly licence name in the list when there is one", () => {
    expect(listLicence(findItem(desktop, "occt")!, "en")).toBe("LGPL-2.1 with OCCT exception");
    expect(listLicence(findItem(desktop, "occt")!, "de")).toBe("LGPL-2.1 mit OCCT-Ausnahme");
    expect(listLicence(findItem(desktop, "react")!, "en")).toBe("MIT");
    expect(listLicence(findItem(desktop, NOTICE_ITEM)!, "de")).toBe(catalogues.de.about.self.noticeList);
    expect(listLicence(findItem(desktop, NOTICE_ITEM)!, "en")).toBe(catalogues.en.about.self.noticeList);
  });

  it("finds an item by id and says nothing for an unknown or missing id", () => {
    expect(findItem(desktop, "occt")?.name).toContain("Open CASCADE");
    expect(findItem(desktop, "nope")).toBeUndefined();
    expect(findItem(desktop, null)).toBeUndefined();
  });

  it("reads the kernel version from the OCCT entry", () => {
    expect(kernelVersion(desktop)).toBe("8.0.2");
    expect(kernelVersion([])).toBeNull();
  });
});

describe("the LGPL line (LGPL-2.1 section 6)", () => {
  it("cuts a copyright line down to years and holder", () => {
    expect(holderOfCopyrightLine("Copyright (c) 1999-2014 OPEN CASCADE SAS")).toBe("1999-2014 OPEN CASCADE SAS");
    expect(holderOfCopyrightLine("Copyright © 2010-2026 three.js authors")).toBe("2010-2026 three.js authors");
    expect(holderOfCopyrightLine("(C) Copyright John Maddock 2002")).toBe("John Maddock 2002");
    expect(holderOfCopyrightLine("© Microsoft Corporation. All rights reserved.")).toBeNull();
  });

  it("ignores free-form remarks and lines without a year", () => {
    expect(holderOfCopyrightLine("Newer files name 2015 and 2025 (OPEN CASCADE SAS).")).toBeNull();
    expect(holderOfCopyrightLine("Copyright (c) Meta Platforms, Inc. and affiliates.")).toBeNull();
  });

  it("picks the notice that names the component's own holder, the newest one if several do", () => {
    const occt = findItem(desktop, "occt")!;
    expect(compactCopyright(occt.name, occt.copyright)).toBe("1999-2026 OPEN CASCADE SAS");
  });

  it("takes the first three holders when no line names the component's own holder, and leaves out e-mail addresses", () => {
    const solver = findItem(desktop, "planegcs")!;
    expect(compactCopyright(solver.name, solver.copyright)).toBe("2011 Konstantinos Poulios, 2014 Victor Titov (DeepSOIC), 2019 Werner Mayer");
    expect(compactCopyright("X", ["Copyright 2001 A", "Copyright 2002 B", "Copyright 2003 C", "Copyright 2004 D"])).toBe("2001 A, 2002 B, 2003 C");
    expect(compactCopyright("X", [])).toBe("");
  });

  it("drops a trailing parenthesis from a name", () => {
    expect(shortName("Open CASCADE Technology (OCCT)")).toBe("Open CASCADE Technology");
    expect(shortName("planegcs (FreeCAD)")).toBe("planegcs");
    expect(shortName("Eigen")).toBe("Eigen");
  });

  it("picks the LGPL components and no others", () => {
    expect(lgplItems(desktop).map((i) => i.id)).toEqual(["occt", "planegcs"]);
    expect(lgplItems(browser).map((i) => i.id)).toEqual(["occt", "planegcs"]);
    expect(lgplItems([])).toEqual([]);
  });

  it("names them with their copyright for the Info tab", () => {
    expect(lgplLibraries(desktop, "and")).toBe(
      "Open CASCADE Technology (© 1999-2026 OPEN CASCADE SAS) and planegcs (© 2011 Konstantinos Poulios, 2014 Victor Titov (DeepSOIC), 2019 Werner Mayer)",
    );
    expect(lgplLibraries([], "and")).toBe("");
  });
});

describe("the licence summary (factual wording)", () => {
  it("has exactly the agreed text in German and English", () => {
    expect(catalogues.de.about.licenceSummary).toBe(
      "Partcraft wird unter der PolyForm Shield License 1.0.0 bereitgestellt. Sie erlaubt die kostenlose Nutzung, privat und geschäftlich, sowie Änderungen für den eigenen Gebrauch. Ausgenommen ist das Anbieten von Produkten, die mit Partcraft im Wettbewerb stehen. Ohne Gewährleistung.",
    );
    expect(catalogues.en.about.licenceSummary).toBe(
      "Partcraft is provided under the PolyForm Shield License 1.0.0. It permits free use, private and commercial, and changes for your own use. Offering products that compete with Partcraft is excluded. No warranty.",
    );
  });
});
