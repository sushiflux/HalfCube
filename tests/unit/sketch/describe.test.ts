// What messages, tooltips and the timeline call a sketch's elements: the numbered shape names and d3 for dimensions, in German and
// English; a name shown once; and never an internal id (l4, k5, d12, p2, f1).
import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "../../../app/src/document/index.ts";
import type { PartcraftDocument, SketchData, SketchFeature } from "../../../app/src/document/types.ts";
import type { Problem } from "../../../app/src/engine/generated/protocol.ts";
import { makeState } from "../../../app/src/i18n/core.ts";
import { problemText } from "../../../app/src/model/index.ts";
import {
  constraintLabel,
  describeDocumentId,
  describeElement,
  describeSketchData,
  dimensionLabel,
  type DescribedSketch,
} from "../../../app/src/screens/sketch/describe.ts";
import { refsText } from "../../../app/src/screens/sketch/shape-name.ts";

const de = makeState("de").t;
const en = makeState("en").t;

// Rectangle 1 owns l1..l4, Line 3 owns l5, circle 2 owns c6; l9 belongs to no numbered shape.
const sketch: DescribedSketch = {
  shapes: [
    { id: "s1", kind: "rectangle", number: 1, members: ["p1", "p2", "p3", "p4", "l1", "l2", "l3", "l4"] },
    { id: "s2", kind: "line", number: 3, members: ["p5", "p6", "l5"] },
    { id: "s3", kind: "circle", number: 2, members: ["p7", "c6"] },
  ],
  forms: [],
  constraints: [
    { id: "k10", kind: "parallel", refs: ["l1", "l5"] },
    { id: "k11", kind: "equal", refs: ["l1", "l3"] },
    { id: "k12", kind: "horizontal", refs: ["l9"] },
    { id: "k13", kind: "coincident", refs: ["p2", "p5"] },
  ],
  dimensions: [
    { id: "d20", kind: "distance", refs: ["l1"], number: 3, value: { value: 40, unit: "mm" }, driving: true },
    { id: "d21", kind: "distance", refs: ["l2"], number: 4, value: { value: 60, unit: "mm" }, driving: false, measured: 60 },
    { id: "d22", kind: "angle", refs: ["l1", "l5"], number: 0, value: { value: 30, unit: "deg" }, driving: true },
    { id: "d23", kind: "diameter", refs: ["c6"], number: 2, value: { value: 20, unit: "mm" }, driving: true },
    { id: "d24", kind: "distance", refs: ["l1"], number: 1, value: { value: 12.5, unit: "mm" }, driving: true },
    { id: "d25", kind: "distance", refs: ["l1"], value: { value: 5, unit: "mm" }, driving: true },
  ],
};

/** Ids as the engine and the document write them. */
const ID = /\b(?:[plcksf]\d+|d\d{2,})\b|\(d\d+\)|@origin|@axis/;

describe("what a constraint or dimension refers to", () => {
  it("names a shape by its number, German and English", () => {
    expect(refsText(de, sketch, ["l2"])).toBe("Rechteck 1");
    expect(refsText(en, sketch, ["l2"])).toBe("Rectangle 1");
    expect(refsText(de, sketch, ["l5"])).toBe("Linie 3");
    expect(refsText(de, sketch, ["c6"])).toBe("Kreis 2");
  });

  it("shows a name once: two sides of the same rectangle read 'in Rechteck 1' / 'within Rectangle 1'", () => {
    expect(refsText(de, sketch, ["l1", "l3"])).toBe("in Rechteck 1");
    expect(refsText(en, sketch, ["l1", "l3"])).toBe("within Rectangle 1");
    // A corner point and a side of the same rectangle are the same shape too.
    expect(refsText(de, sketch, ["p2", "l4"])).toBe("in Rechteck 1");
  });

  it("lists different shapes in the order of the references, each once", () => {
    expect(refsText(de, sketch, ["l1", "l5"])).toBe("Rechteck 1, Linie 3");
    expect(refsText(de, sketch, ["l1", "l5", "l2"])).toBe("Rechteck 1, Linie 3");
    expect(refsText(en, sketch, ["l5", "l1"])).toBe("Line 3, Rectangle 1");
  });

  it("names the fixed references and elements of no numbered shape by their kind, never by their id", () => {
    expect(refsText(de, sketch, ["@origin"])).toBe("Ursprung");
    expect(refsText(en, sketch, ["@origin"])).toBe("Origin");
    expect(refsText(de, sketch, ["l1", "@axisU"])).toBe("Rechteck 1, Horizontale Achse");
    expect(refsText(en, sketch, ["@axisV", "l5"])).toBe("Vertical axis, Line 3");
    expect(refsText(de, sketch, ["l9"])).toBe("Linie");
    expect(refsText(de, sketch, ["p99"])).toBe("Punkt");
    expect(refsText(en, sketch, ["c99"])).toBe("Circle");
    expect(refsText(de, sketch, ["zzz"])).toBe("Element der Skizze");
  });

  it("says Form N when the element belongs to several shapes of one Form", () => {
    const joined: DescribedSketch = { ...sketch, forms: [{ number: 1, shapes: ["s1", "s2"] }] };
    // p2 of the rectangle and p5 of the line were tied together: one point owned by both shapes in the model's eyes.
    const shared: DescribedSketch = { ...joined, shapes: sketch.shapes.map((s) => (s.id === "s2" ? { ...s, members: [...s.members, "p2"] } : s)) };
    expect(refsText(de, shared, ["p2"])).toBe("Form 1");
    expect(refsText(en, shared, ["p2"])).toBe("Shape 1");
  });
});

describe("constraints and dimensions in words", () => {
  it("a constraint says what it holds: 'Parallel: Rechteck 1, Linie 3'", () => {
    expect(describeElement(de, sketch, "k10", true)).toBe("Parallel: Rechteck 1, Linie 3");
    expect(describeElement(en, sketch, "k10", false)).toBe("Parallel: Rectangle 1, Line 3");
    expect(describeElement(de, sketch, "k11", true)).toBe("Gleich: in Rechteck 1");
    expect(describeElement(en, sketch, "k11", false)).toBe("Equal: within Rectangle 1");
    expect(describeElement(de, sketch, "k12", true)).toBe("Horizontal: Linie");
    expect(describeElement(de, sketch, "k13", true)).toBe("Koinzident: Rechteck 1, Linie 3");
    expect(constraintLabel(de, sketch, "fix", [])).toBe("Fixiert");
  });

  it("a dimension is its name and value: 'd3 · 40 mm', a reference dimension in brackets", () => {
    expect(describeElement(de, sketch, "d20", true)).toBe("d3 · 40 mm");
    expect(describeElement(en, sketch, "d20", false)).toBe("d3 · 40 mm");
    expect(describeElement(de, sketch, "d21", true)).toBe("d4 · (60 mm)");
    expect(describeElement(de, sketch, "d22", true)).toBe("d0 · 30°");
    expect(describeElement(de, sketch, "d23", true)).toBe("d2 · Ø20 mm");
    expect(describeElement(de, sketch, "d24", true)).toBe("d1 · 12,5 mm");
    expect(describeElement(en, sketch, "d24", false)).toBe("d1 · 12.5 mm");
  });

  it("a dimension that has no number yet is named by its kind, never by its id", () => {
    const text = dimensionLabel(de, sketch.dimensions.find((d) => d.id === "d25")!, true);
    expect(text).toBe("Länge · 5 mm");
    expect(text).not.toMatch(ID);
  });

  it("an element is named like in the sketch, and no description contains an internal id", () => {
    const ids = ["k10", "k11", "k12", "k13", "d20", "d21", "d22", "d23", "d24", "d25", "l1", "l9", "p2", "c6", "p99", "zzz"];
    const leaked = ids.flatMap((id) => [de, en].map((t) => describeElement(t, sketch, id, true))).filter((text) => ID.test(text));
    expect(leaked).toEqual([]);
  });
});

describe("a stored sketch and the whole document", () => {
  const data: SketchData = {
    points: [],
    lines: [
      { id: "l2", p1: "p1", p2: "p2", construction: false },
      { id: "l3", p1: "p2", p2: "p3", construction: false },
    ],
    circles: [],
    constraints: [
      { id: "k4", kind: "perpendicular", refs: ["l2", "l3"] },
      { id: "d5", kind: "distance", refs: ["l2"], number: 7, value: { value: 25, unit: "mm" }, driving: true, label: { x: 0, y: 0 } },
    ],
    steps: [{ id: "s1", kind: "rectangle", number: 2, members: ["p1", "p2", "p3", "l2", "l3"] }],
  };
  const feature: SketchFeature = { id: "f1", type: "sketch", name: "Skizze1", component: "root", visible: true, plane: { kind: "originPlane", plane: "xy" }, sketch: data };
  const doc: PartcraftDocument = { ...createEmptyDocument({ rootName: "Teil" }), timeline: [feature] };

  it("reads the same names from a stored sketch", () => {
    const described = describeSketchData(data);
    expect(constraintLabel(de, described, "perpendicular", ["l2", "l3"])).toBe("Senkrecht: in Rechteck 2");
    expect(describeElement(de, described, "d5", true)).toBe("d7 · 25 mm");
  });

  it("names a step by its name and an element of any sketch like the sketch does; unknown ids by their kind", () => {
    expect(describeDocumentId(de, doc, "f1", true)).toBe("Skizze1");
    expect(describeDocumentId(de, doc, "k4", true)).toBe("Senkrecht: in Rechteck 2");
    expect(describeDocumentId(en, doc, "l2", false)).toBe("Rectangle 2");
    expect(describeDocumentId(de, doc, "d5", true)).toBe("d7 · 25 mm");
    expect(describeDocumentId(de, doc, "f99", true)).toBe("Schritt");
    expect(describeDocumentId(en, doc, "l99", false)).toBe("Line");
    const leaked = ["f1", "k4", "l2", "d5", "f99", "l99", "x"].map((id) => describeDocumentId(de, doc, id, true)).filter((text) => ID.test(text));
    expect(leaked).toEqual([]);
  });
});

describe("the translated headline of a problem", () => {
  const problem: Problem = { code: "sketch_conflicting", message: "engine text with l1 and k4", refs: ["k4", "d5", "l2"] };

  it("names every id by its kind when nobody describes it better, so no id reaches the user", () => {
    const text = problemText(de, problem);
    expect(text).toBe("Abhängigkeiten und Maße der Skizze widersprechen sich. Beteiligt sind unter anderem: Abhängigkeit, Maß, Linie.");
    expect(text).not.toMatch(ID);
    expect(problemText(en, { code: "upstream_failed", message: "x", refs: ["f3"] })).toBe("This step builds on a step that failed (Step).");
  });

  it("uses the describer when it is given one", () => {
    expect(problemText(de, problem, (id) => `<${id}>`)).toContain("<k4>, <d5>, <l2>");
  });
});
