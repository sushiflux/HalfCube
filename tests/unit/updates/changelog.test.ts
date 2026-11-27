import { describe, expect, it } from "vitest";
import { compareVersionIds, inlineTokens, parseChangelog } from "../../../app/src/updates/changelog.ts";

const grouped = `# Nightly Changelog (α)

**[English](#english) · [Deutsch](#deutsch)**

---

<a name="english"></a>
## English

## vNEXT α

### Sketch
- 🔧 **Fix:** Dimensions no longer jump when the view is turned.

## v2026.11.12.13.557 (α)

### Sketch
- ✨ **New:** Draw a rectangle with two clicks.
- 🔧 **Fix:** Dimensions no longer jump
  when the view is turned.

### Bodies
- 🔄 **Change:** Fillets show a preview while you type the radius.

### General
- 🔧 Several small bugs fixed.

## v2026.11.5.4.4410 (α)

### General
- 🔒 Security updates of the components used.
- 🔧 Several small bugs fixed.

## v2026.11.2.1.100 (α)

HalfCube is a parametric 3D CAD program. You sketch first, then you build bodies.

---

<a name="deutsch"></a>
## Deutsch

## vNEXT α

### Skizze
- 🔧 **Behoben:** Maße springen nicht mehr.

## v2026.11.12.13.557 (α)

### Skizze
- ✨ **Neu:** Zeichne ein Rechteck mit zwei Klicks.
- 🔧 **Behoben:** „Maße“ springen nicht mehr beim Drehen der Ansicht.

### Körper
- 🔄 **Geändert:** Verrundungen zeigen eine Vorschau.

### Allgemein
- 🔧 Mehrere kleine Fehler behoben.

## v2026.11.5.4.4410 (α)

### Allgemein
- 🔧 Mehrere kleine Fehler behoben.

## v2026.11.2.1.100 (α)

HalfCube ist ein parametrisches 3D-CAD-Programm.
`;

describe("the date of an entry heading", () => {
  const entry = (heading: string) => parseChangelog(`## English\n\n## ${heading}\n### Sketch\n- ✨ **New:** A.\n`, "en")[0];

  it("reads the ISO date after the version", () => {
    expect(entry("v2026.11.12.13.557 (α) · 2026-11-27")?.date).toBe("2026-11-27");
    expect(entry("v2026.11.12.13.557 · 2026-01-05")?.date).toBe("2026-01-05");
  });

  it("reads it when platforms follow, and keeps the heading as written", () => {
    const e = entry("v2026.11.12.13.557 (β) · 2026-11-27 · Unraid");
    expect(e?.date).toBe("2026-11-27");
    expect(e?.id).toBe("v2026.11.12.13.557");
    expect(e?.heading).toBe("v2026.11.12.13.557 (β) · 2026-11-27 · Unraid");
  });

  it("has no date when the heading carries none, only platforms, or something that is not a real date", () => {
    expect(entry("v2026.11.12.13.557 (α)")?.date).toBeNull();
    expect(entry("v2026.11.12.13.557 (β) · Unraid")?.date).toBeNull();
    expect(entry("v2026.11.12.13.557 (α) · 2026-13-40")?.date).toBeNull();
    expect(entry("v2026.11.12.13.557 (α) · 2026-02-30")?.date).toBeNull();
    expect(entry("v2026.11.12.13.557 (α) · 27.11.2026")?.date).toBeNull();
    // Only the first segment after the version counts.
    expect(entry("v2026.11.12.13.557 (β) · Unraid · 2026-11-27")?.date).toBeNull();
  });
});

describe("parseChangelog", () => {
  it("reads the English section: entries newest first as in the file", () => {
    const entries = parseChangelog(grouped, "en");
    expect(entries.map((e) => e.id)).toEqual([null, "v2026.11.12.13.557", "v2026.11.5.4.4410", "v2026.11.2.1.100"]);
    expect(entries[1]?.heading).toBe("v2026.11.12.13.557 (α)");
  });

  it("reads the German section from its own part of the file", () => {
    const entries = parseChangelog(grouped, "de");
    expect(entries.map((e) => e.id)).toEqual([null, "v2026.11.12.13.557", "v2026.11.5.4.4410", "v2026.11.2.1.100"]);
    const sketch = entries[1]?.sections[0];
    expect(sketch?.area).toBe("Skizze");
    expect(sketch?.lines[0]).toEqual({ category: "new", text: "Zeichne ein Rechteck mit zwei Klicks." });
    expect(sketch?.lines[1]).toEqual({ category: "fix", text: "„Maße“ springen nicht mehr beim Drehen der Ansicht." });
    expect(entries[1]?.sections[1]).toMatchObject({ area: "Körper", lines: [{ category: "change" }] });
  });

  it("groups lines by product area and keeps their categories", () => {
    const entry = parseChangelog(grouped, "en")[1];
    expect(entry?.sections.map((s) => [s.area, s.general])).toEqual([
      ["Sketch", false],
      ["Bodies", false],
      ["General", true],
    ]);
    expect(entry?.sections[0]?.lines[0]).toEqual({ category: "new", text: "Draw a rectangle with two clicks." });
    expect(entry?.sections[1]?.lines[0]).toEqual({ category: "change", text: "Fillets show a preview while you type the radius." });
  });

  it("joins a wrapped line", () => {
    const entry = parseChangelog(grouped, "en")[1];
    expect(entry?.sections[0]?.lines[1]).toEqual({ category: "fix", text: "Dimensions no longer jump when the view is turned." });
  });

  it("gives maintenance lines no category and drops their emoji", () => {
    const entry = parseChangelog(grouped, "en")[2];
    expect(entry?.sections).toEqual([
      { area: "General", general: true, lines: [{ category: null, text: "Security updates of the components used." }, { category: null, text: "Several small bugs fixed." }] },
    ]);
  });

  it("marks an unstamped vNEXT heading with id null", () => {
    const entry = parseChangelog(grouped, "en")[0];
    expect(entry).toMatchObject({ id: null, heading: "vNEXT α", userVisible: true });
  });

  it("marks an entry of maintenance lines only as not user-visible", () => {
    const entries = parseChangelog(grouped, "en");
    expect(entries[2]?.userVisible).toBe(false);
    expect(entries[1]?.userVisible).toBe(true);
  });

  it("parses the ungrouped first entry into one section without an area", () => {
    const entry = parseChangelog(grouped, "en")[3];
    expect(entry?.sections).toEqual([
      { area: null, general: false, lines: [{ category: null, text: "HalfCube is a parametric 3D CAD program. You sketch first, then you build bodies." }] },
    ]);
    expect(entry?.userVisible).toBe(true);
  });

  it("reads an ungrouped first entry written as a labelled bullet", () => {
    const md = "## English\n\n## v2026.11.2.1.100 (α)\n\n- ✨ **New:** HalfCube sketches and builds parts. It runs offline.\n";
    expect(parseChangelog(md, "en")[0]?.sections).toEqual([
      { area: null, general: false, lines: [{ category: "new", text: "HalfCube sketches and builds parts. It runs offline." }] },
    ]);
  });

  it("reads the older layout with a category heading and unlabelled lines", () => {
    const md = "## English\n\n## v2026.11.2.1.100 (α)\n\n### ✨ New\n\n- First thing.\n- Second thing.\n\n### 🔄 Changed\n\n- Third thing.\n";
    const entry = parseChangelog(md, "en")[0];
    expect(entry?.sections).toEqual([
      {
        area: null,
        general: false,
        lines: [
          { category: "new", text: "First thing." },
          { category: "new", text: "Second thing." },
          { category: "change", text: "Third thing." },
        ],
      },
    ]);
  });

  it("knows all six categories in both languages", () => {
    const md = [
      "## English",
      "## v2026.11.12.1.1",
      "### Sketch",
      "- **New:** a",
      "- **Change:** b",
      "- **Fix:** c",
      "- **Security:** d",
      "- **Removed:** e",
      "- **Deprecated:** f",
      "## Deutsch",
      "## v2026.11.12.1.1",
      "### Skizze",
      "- **Neu:** a",
      "- **Geändert:** b",
      "- **Behoben:** c",
      "- **Sicherheit:** d",
      "- **Entfernt:** e",
      "- **Veraltet:** f",
    ].join("\n");
    const expected = ["new", "change", "fix", "security", "removed", "deprecated"];
    for (const language of ["en", "de"] as const) {
      expect(parseChangelog(md, language)[0]?.sections[0]?.lines.map((l) => l.category)).toEqual(expected);
    }
  });

  it("keeps a bold lead-in that is not a category as text", () => {
    const md = "## English\n## v2026.11.12.1.1\n### Sketch\n- ✨ **New:** **Dimensions:** type a value at the line.\n- **Snap:** points snap now.\n";
    const lines = parseChangelog(md, "en")[0]?.sections[0]?.lines;
    expect(lines).toEqual([
      { category: "new", text: "**Dimensions:** type a value at the line." },
      { category: null, text: "**Snap:** points snap now." },
    ]);
  });

  it("reads an excerpt without language headings as the requested language", () => {
    const md = "## v2026.11.12.13.557 (β)\n\n### Sketch\n- ✨ **New:** A.\n";
    expect(parseChangelog(md, "de")).toHaveLength(1);
    expect(parseChangelog(md, "en")).toHaveLength(1);
  });

  it("returns nothing for a language the file does not have", () => {
    expect(parseChangelog("## English\n\n## v2026.11.12.13.557\n### Sketch\n- **New:** A.\n", "de")).toEqual([]);
  });

  it("handles Windows line endings", () => {
    const entries = parseChangelog(grouped.replace(/\n/g, "\r\n"), "de");
    expect(entries[1]?.sections[0]?.lines[0]?.text).toBe("Zeichne ein Rechteck mit zwei Klicks.");
  });

  it("never throws on odd input", () => {
    const odd = [
      "",
      "   \n\n",
      "no headings at all",
      "## English\n",
      "## English\n## v2026.11.12\n- stray\n",
      "## English\n- bullet before any entry\n## v2026.11.12.1.1\n- bullet without area\n### \n- x\n#### deep\n",
      "## English\n## vNEXT\n### Sketch\n### Bodies\n",
      "\u0000\u0001 ## v1.2.3.4.5\n",
      "## Deutsch\n## v99999999999999999999.1.1.1.1\n### A\n- **Neu:**\n",
    ];
    for (const input of odd) {
      for (const language of ["en", "de"] as const) {
        expect(() => parseChangelog(input, language)).not.toThrow();
      }
    }
    expect(parseChangelog(undefined as unknown as string, "en")).toEqual([]);
    // Nothing under the headings: no sections, not user-visible.
    expect(parseChangelog("## English\n## vNEXT\n### Sketch\n", "en")).toEqual([{ id: null, heading: "vNEXT", date: null, sections: [], userVisible: false }]);
    // An entry that is not stamped in the five-segment form is skipped.
    expect(parseChangelog("## English\n## v2026.11.12\n- stray\n", "en")).toEqual([]);
  });
});

describe("compareVersionIds", () => {
  it("orders by year, month and commit of the year", () => {
    expect(compareVersionIds("v2026.11.12.13.557", "v2026.11.5.4.4410")).toBe(1);
    expect(compareVersionIds("v2026.11.5.4.4410", "v2026.11.12.13.557")).toBe(-1);
    expect(compareVersionIds("v2026.12.1.1.1", "v2026.11.99.1.1")).toBe(1);
    expect(compareVersionIds("v2027.1.1.1.1", "v2026.12.99.1.1")).toBe(1);
    // numbers, not text: 9 < 12
    expect(compareVersionIds("v2026.11.9.1.1", "v2026.11.12.1.1")).toBe(-1);
  });

  it("does not let the last two segments decide", () => {
    expect(compareVersionIds("v2026.11.12.13.557", "v2026.11.12.99.99999")).toBe(0);
    expect(compareVersionIds("v2026.11.12", "v2026.11.12.13.557")).toBe(0);
  });

  it("puts an unreadable id first and never throws", () => {
    expect(compareVersionIds("", "v2026.11.12.1.1")).toBe(-1);
    expect(compareVersionIds("v2026.11.12.1.1", "nonsense")).toBe(1);
    expect(compareVersionIds("a", "b")).toBe(0);
  });
});

describe("parseChangelog on crafted release notes", () => {
  // A bullet that opens a bold label and then holds a long run of spaces: before the fix 80,000 spaces took about 2.4 s.
  it("reads a line with a huge unfinished label quickly", () => {
    const md = `## v2026.11.12.13.557\n- **a${" ".repeat(200_000)}b\n`;
    const started = performance.now();
    const entries = parseChangelog(md, "en");
    expect(performance.now() - started).toBeLessThan(250);
    expect(entries[0]?.sections[0]?.lines[0]?.category).toBeNull();
  });

  it("still reads both label forms with spaces around the colon", () => {
    const md = "## v2026.11.12.13.557\n- **New :** one\n- **Fixed** : two\n";
    expect(parseChangelog(md, "en")[0]?.sections[0]?.lines).toEqual([
      { category: "new", text: "one" },
      { category: "fix", text: "two" },
    ]);
  });
});

describe("inlineTokens", () => {
  it("splits bold, italic, code and links; a link keeps only its text", () => {
    expect(inlineTokens("A **bold** and *em* `code` [site](javascript:alert) end")).toEqual([
      { kind: "text", text: "A " },
      { kind: "strong", text: "bold" },
      { kind: "text", text: " and " },
      { kind: "em", text: "em" },
      { kind: "text", text: " " },
      { kind: "code", text: "code" },
      { kind: "text", text: " " },
      { kind: "link", text: "site" },
      { kind: "text", text: " end" },
    ]);
  });

  it("leaves a link whose address holds parentheses as plain text", () => {
    expect(inlineTokens("[x](a(b)c)")).toEqual([{ kind: "text", text: "[x](a(b)c)" }]);
  });

  it("keeps markup as plain text (React escapes it)", () => {
    expect(inlineTokens("<img src=x onerror=alert(1)>")).toEqual([{ kind: "text", text: "<img src=x onerror=alert(1)>" }]);
  });

  // Release notes come from the network feed: a crafted line must not freeze the window. Before the fix 40,000 "[" took about
  // 750 ms and the time grew with the square of the length (100,000 took several seconds).
  it.each([
    ["opening brackets", "[".repeat(100_000)],
    ["unclosed links", "[a](".repeat(25_000)],
    ["unclosed code", "`a".repeat(50_000)],
    ["unclosed emphasis", "*a ".repeat(33_000)],
  ])("stays linear on %s", (_name, text) => {
    const started = performance.now();
    const tokens = inlineTokens(text);
    expect(performance.now() - started).toBeLessThan(250);
    expect(tokens.map((t) => t.text).join("").length).toBeLessThanOrEqual(text.length);
  });
});
