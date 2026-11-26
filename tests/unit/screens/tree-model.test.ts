import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "../../../app/src/document/index.ts";
import type { HalfCubeDocument, SketchFeature } from "../../../app/src/document/types.ts";
import { buildTree, initiallyExpanded, type TreeText } from "../../../app/src/screens/main/tree-model.ts";

const text: TreeText = {
  origin: "Ursprung",
  planes: { xy: "Oben (XY)", xz: "Vorne (XZ)", yz: "Rechts (YZ)" },
  axes: { x: "X-Achse", y: "Y-Achse", z: "Z-Achse" },
  sketches: "Skizzen",
  bodies: "Körper",
};

const sketch = (id: string, plane: "xy" | "xz" | "yz" = "xy"): SketchFeature => ({
  id,
  type: "sketch",
  name: `Skizze ${id}`,
  component: "root",
  visible: true,
  plane: { kind: "originPlane", plane },
  sketch: { points: [], lines: [], circles: [], constraints: [] },
});

function docWith(features: SketchFeature[]): HalfCubeDocument {
  return { ...createEmptyDocument({ rootName: "Teil" }), timeline: features };
}

const open = new Set(initiallyExpanded);

describe("buildTree", () => {
  it("shows the component and a closed origin for an empty document", () => {
    const rows = buildTree({ doc: docWith([]), steps: [], expanded: open, text });
    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      ["component:root", 0],
      ["origin", 1],
    ]);
    expect(rows[0]?.label).toBe("Teil");
    expect(rows[1]).toMatchObject({ hasChildren: true, expanded: false });
  });

  it("lists the three planes and three axes when the origin is open", () => {
    const rows = buildTree({ doc: docWith([]), steps: [], expanded: new Set([...open, "origin"]), text });
    expect(rows.filter((r) => r.kind === "plane").map((r) => r.plane)).toEqual(["xy", "xz", "yz"]);
    expect(rows.filter((r) => r.kind === "axis").map((r) => r.label)).toEqual(["X-Achse", "Y-Achse", "Z-Achse"]);
    expect(rows.filter((r) => r.kind === "plane" || r.kind === "axis").every((r) => r.depth === 2)).toBe(true);
  });

  it("derives the sketch folder from the timeline and carries the step state", () => {
    const doc = docWith([sketch("f1"), sketch("f2", "xz")]);
    const rows = buildTree({ doc, steps: [{ featureId: "f2", state: "error", cached: false, ms: 1 }], expanded: open, text });
    expect(rows.map((r) => r.id)).toEqual(["component:root", "origin", "folder:sketches", "sketch:f1", "sketch:f2"]);
    expect(rows.find((r) => r.id === "sketch:f2")?.state).toBe("error");
    expect(rows.find((r) => r.id === "sketch:f1")?.state).toBeUndefined();
  });

  it("hides the children of a closed folder and of a closed component", () => {
    const doc = docWith([sketch("f1")]);
    const closedFolder = buildTree({ doc, steps: [], expanded: new Set(["component:root"]), text });
    expect(closedFolder.map((r) => r.id)).toEqual(["component:root", "origin", "folder:sketches"]);
    const closedComponent = buildTree({ doc, steps: [], expanded: new Set(), text });
    expect(closedComponent.map((r) => r.id)).toEqual(["component:root"]);
  });

  it("lists the bodies of the component with the step that made them", () => {
    const base = docWith([sketch("f1")]);
    const doc: HalfCubeDocument = { ...base, components: [{ id: "root", name: "Teil", bodies: [{ id: "b3", name: "Körper1", createdBy: "f2", visible: true }] }] };
    const rows = buildTree({ doc, steps: [{ featureId: "f2", state: "warning", cached: false, ms: 1 }], expanded: open, text });
    expect(rows.find((r) => r.id === "body:b3")).toMatchObject({ kind: "body", label: "Körper1", featureId: "f2", state: "warning", depth: 2 });
  });
});
