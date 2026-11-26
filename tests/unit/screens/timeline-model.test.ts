import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "../../../app/src/document/index.ts";
import type { HalfCubeDocument, SketchFeature } from "../../../app/src/document/types.ts";
import { buildTimeline, problemSteps, sketchSubSteps, type TimelineText } from "../../../app/src/screens/main/timeline-model.ts";

const text: TimelineText = {
  line: "Linie",
  construction: "Hilfslinie",
  rectangle: "Rechteck",
  circle: "Kreis",
  shape: (kind, n) => `${{ line: "Linie", rectangle: "Rechteck", circle: "Kreis", arc: "Bogen", spline: "Spline" }[kind]} ${n}`,
  constructionNamed: (name) => `${name} (Hilfslinie)`,
  dimension: (d) => `${d.number !== undefined ? `d${d.number}` : "Maß"} · ${d.driving ? "" : "("}${d.value.value}${d.value.unit === "deg" ? "°" : " mm"}${d.driving ? "" : ")"}`,
  constraint: (_sketch, kind, refs) => `C:${kind}:${refs.join("+")}`,
};

const feature: SketchFeature = {
  id: "f1",
  type: "sketch",
  name: "Skizze1",
  component: "root",
  visible: true,
  plane: { kind: "originPlane", plane: "xy" },
  sketch: {
    points: [],
    // The lists are separate; the order of the steps comes from the id numbers (one counter for the whole document).
    lines: [
      { id: "l10", p1: "p2", p2: "p3", construction: false },
      { id: "l4", p1: "p2", p2: "p3", construction: true },
    ],
    circles: [{ id: "c7", center: "p2", radius: 5, construction: false }],
    constraints: [
      { id: "k12", kind: "horizontal", refs: ["l10"] },
      { id: "d8", kind: "distance", refs: ["l10"], number: 0, value: { value: 40, unit: "mm" }, driving: true, label: { x: 0, y: 0 } },
      { id: "d11", kind: "angle", refs: ["l4", "l10"], number: 1, value: { value: 30, unit: "deg" }, driving: false, label: { x: 0, y: 0 } },
    ],
  },
};

describe("sketchSubSteps", () => {
  it("lists every element in the order it was made", () => {
    expect(sketchSubSteps(feature, text).map((s) => [s.id, s.kind, s.label])).toEqual([
      ["l4", "construction", "Hilfslinie"],
      ["c7", "circle", "Kreis"],
      ["d8", "dimension", "d0 · 40 mm"],
      ["l10", "line", "Linie"],
      ["d11", "reference", "d1 · (30°)"],
      ["k12", "constraint", "C:horizontal:l10"],
    ]);
  });

  it("gives constraints their own glyph and an empty sketch no steps", () => {
    expect(sketchSubSteps(feature, text).find((s) => s.id === "k12")?.glyph).toBe("cHorizontal");
    expect(sketchSubSteps({ ...feature, sketch: { points: [], lines: [], circles: [], constraints: [] } }, text)).toEqual([]);
  });
});

describe("buildTimeline", () => {
  const doc = (): HalfCubeDocument => ({
    ...createEmptyDocument({ rootName: "Teil" }),
    timeline: [
      feature,
      {
        id: "f20",
        type: "extrude",
        name: "Extrusion1",
        component: "root",
        profile: { sketch: "f1", region: "l10" },
        extent: "oneSide",
        distance: { value: 10, unit: "mm" },
        operation: "newBody",
        body: "b21",
      },
    ],
  });

  it("makes a sketch ONE step with its inner steps and a body operation a step of its own", () => {
    const steps = buildTimeline(doc(), [], text);
    expect(steps.map((s) => [s.featureId, s.kind, s.glyph, s.subSteps.length])).toEqual([
      ["f1", "sketch", "pencil", 6],
      ["f20", "extrude", "fnExtrude", 0],
    ]);
  });

  it("marks a step unknown until the engine has answered and carries the rebuilt state afterwards", () => {
    expect(buildTimeline(doc(), [], text).map((s) => s.state)).toEqual(["unknown", "unknown"]);
    const steps = buildTimeline(doc(), [{ featureId: "f20", state: "error", cached: false, ms: 1 }], text);
    expect(steps.map((s) => s.state)).toEqual(["unknown", "error"]);
  });
});

describe("buildTimeline: the extrusion being made", () => {
  const withSketch = (): HalfCubeDocument => ({ ...createEmptyDocument({ rootName: "Teil" }), timeline: [feature] });

  it("shows a draft step after the sketch while the dialog is open, with the extrude icon, marked as a draft", () => {
    const steps = buildTimeline(withSketch(), [], text, { featureId: "f30", label: "Extrusion1" });
    expect(steps.map((s) => [s.featureId, s.kind, s.glyph, s.draft ?? false])).toEqual([
      ["f1", "sketch", "pencil", false],
      ["f30", "extrude", "fnExtrude", true],
    ]);
    expect(steps[1]?.state).toBe("unknown");
  });

  it("shows no draft when there is none, and none twice for a step that exists already (editing)", () => {
    expect(buildTimeline(withSketch(), [], text, null)).toHaveLength(1);
    const existing: HalfCubeDocument = {
      ...withSketch(),
      timeline: [
        feature,
        { id: "f20", type: "extrude", name: "Extrusion1", component: "root", profile: { sketch: "f1", region: "r" }, extent: "oneSide", distance: { value: 5, unit: "mm" }, operation: "newBody", body: "b21" },
      ],
    };
    const steps = buildTimeline(existing, [], text, { featureId: "f20", label: "Extrusion1" });
    expect(steps).toHaveLength(2);
    expect(steps[1]?.draft).toBeUndefined();
  });
});

describe("problemSteps", () => {
  it("keeps the failed and warned steps in timeline order", () => {
    const base = { cached: false, ms: 1 };
    const steps = [
      { featureId: "f1", state: "ok" as const, ...base },
      { featureId: "f2", state: "warning" as const, ...base },
      { featureId: "f3", state: "skipped" as const, ...base },
      { featureId: "f4", state: "error" as const, ...base },
    ];
    expect(problemSteps(steps).map((s) => s.featureId)).toEqual(["f2", "f4"]);
  });

  it("uses the recorded steps: a rectangle is ONE inner step, elements without a step still show", () => {
    const withSteps: SketchFeature = {
      ...feature,
      sketch: {
        ...feature.sketch,
        lines: [
          { id: "l2", p1: "p1", p2: "p2", construction: false },
          { id: "l3", p1: "p2", p2: "p3", construction: false },
          { id: "l4", p1: "p3", p2: "p4", construction: false },
          { id: "l5", p1: "p4", p2: "p1", construction: false },
          { id: "l30", p1: "p5", p2: "p6", construction: true },
        ],
        circles: [],
        constraints: [
          { id: "k6", kind: "horizontal", refs: ["l2"] },
          { id: "k7", kind: "vertical", refs: ["l3"] },
          { id: "d8", kind: "distance", refs: ["l2"], number: 4, value: { value: 60, unit: "mm" }, driving: true, label: { x: 0, y: 0 } },
          { id: "k9", kind: "equal", refs: ["l2", "l4"] },
        ],
        steps: [
          { id: "s10", kind: "rectangle", number: 1, members: ["p1", "p2", "p3", "p4", "l2", "l3", "l4", "l5", "k6", "k7"] },
          { id: "s11", kind: "dimension", members: ["d8"] },
          { id: "s12", kind: "constraint", members: ["k9"] },
        ],
      },
    };
    expect(sketchSubSteps(withSteps, text).map((s) => [s.id, s.kind, s.label])).toEqual([
      ["s10", "rectangle", "Rechteck 1"],
      ["s11", "dimension", "d4 · 60 mm"],
      ["s12", "constraint", "C:equal:l2+l4"],
      // l30 belongs to no recorded step: one entry of its own at the place its id says.
      ["l30", "construction", "Hilfslinie"],
    ]);
  });

  it("names a recorded line, construction line and circle by their number, and falls back to the bare word without one", () => {
    const named: SketchFeature = {
      ...feature,
      sketch: {
        points: [],
        lines: [
          { id: "l2", p1: "p1", p2: "p2", construction: false },
          { id: "l3", p1: "p3", p2: "p4", construction: true },
          { id: "l4", p1: "p5", p2: "p6", construction: false },
        ],
        circles: [{ id: "c5", center: "p7", radius: 3, construction: false }],
        constraints: [],
        steps: [
          { id: "s6", kind: "line", number: 3, members: ["p1", "p2", "l2"] },
          { id: "s7", kind: "line", number: 4, members: ["p3", "p4", "l3"] },
          { id: "s8", kind: "circle", number: 2, members: ["p7", "c5"] },
          { id: "s9", kind: "line", members: ["p5", "p6", "l4"] },
        ],
      },
    };
    expect(sketchSubSteps(named, text).map((x) => [x.id, x.label])).toEqual([
      ["s6", "Linie 3"],
      ["s7", "Linie 4 (Hilfslinie)"],
      ["s9", "Linie"],
      ["s8", "Kreis 2"],
    ]);
  });
});
