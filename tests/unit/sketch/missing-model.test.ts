// "What is still missing": the engine's facts in plain words, German and English, complete sentences that name the shapes, with the
// elements to light up; and the state of the collapsed chip.
import { describe, expect, it } from "vitest";
import { catalogues, formatMessage, lookup } from "../../../app/src/i18n/core.ts";
import type { MessageKey } from "../../../app/src/i18n/types.ts";
import type { SketchView } from "../../../app/src/model/index.ts";
import { chipState, missingList, MISSING_SHOWN } from "../../../app/src/screens/sketch/missing-model.ts";
import { shapeName } from "../../../app/src/screens/sketch/shape-name.ts";
import { FakeEditor } from "./fakes.ts";

const translate = (language: "de" | "en") => (key: MessageKey, params?: Record<string, string | number>) => formatMessage(lookup(catalogues[language], key), params);

type ShapeSeed = Omit<SketchView["shapes"][number], "id"> & { id?: string };
/** The shapes get the ids s0, s1 ... in order (so forms can name them) unless they have one. */
function viewWith(freedom: SketchView["freedom"], seed?: Parameters<FakeEditor["seed"]>[0], shapes: ShapeSeed[] = [], patch: Partial<SketchView> = {}): SketchView {
  const editor = new FakeEditor();
  editor.seed(seed ?? {});
  return { ...editor.view, freedom, shapes: shapes.map((x, i) => ({ id: x.id ?? `s${i}`, ...x })), ...patch };
}

// A 12 x 55 rectangle (the owner's), l1 and l3 horizontal, l2 and l4 vertical.
const rectangle: Parameters<FakeEditor["seed"]>[0] = {
  points: [["p1", 5, 5], ["p2", 17, 5], ["p3", 17, 60], ["p4", 5, 60]],
  lines: [["l1", "p1", "p2"], ["l2", "p2", "p3"], ["l3", "p3", "p4"], ["l4", "p4", "p1"]],
};
const rect1: ShapeSeed = { kind: "rectangle", number: 1, members: ["p1", "p2", "p3", "p4", "l1", "l2", "l3", "l4"] };

describe("what is still missing, in words", () => {
  it("the owner's rectangle: only the position is free - said first, then the three ways to fix it, with the shape's name (German)", () => {
    const view = viewWith([{ kind: "position", shape: "rectangle", moves: 2, elements: ["l1", "l2", "l3", "l4"] }], rectangle, [rect1]);
    const list = missingList(translate("de"), view);
    expect(list.onlyPosition).toBe(true);
    expect(translate("de")("sketch.missing.onlyPosition")).toBe("Form und Größe sind vollständig bestimmt, nur die Lage ist noch frei.");
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]).toMatchObject({
      label: "Lage frei",
      text: "Rechteck 1 lässt sich noch verschieben. Einen Punkt mit „Fest“ festsetzen, an den Ursprung legen oder den Abstand zum Ursprung bemaßen.",
      elements: ["l1", "l2", "l3", "l4"],
    });
  });

  it("the same in English", () => {
    const view = viewWith([{ kind: "position", shape: "rectangle", moves: 2, elements: ["l1", "l2", "l3", "l4"] }], rectangle, [rect1]);
    expect(translate("en")("sketch.missing.onlyPosition")).toBe("Shape and size are fully determined, only the position is still free.");
    expect(missingList(translate("en"), view).entries[0]).toMatchObject({
      label: "Position free",
      text: "Rectangle 1 can still be moved. Fix a point with Fix, put it on the origin or dimension the distance to the origin.",
    });
  });

  it("two rectangles and two circles are told apart by their names", () => {
    const view = viewWith(
      [
        { kind: "position", shape: "rectangle", moves: 2, elements: ["l1", "l2", "l3", "l4"] },
        { kind: "position", shape: "rectangle", moves: 2, elements: ["l5", "l6", "l7", "l8"] },
        { kind: "radius", shape: "circle", elements: ["c1"] },
        { kind: "radius", shape: "circle", elements: ["c2"] },
      ],
      undefined,
      [
        rect1,
        { kind: "rectangle", number: 2, members: ["l5", "l6", "l7", "l8"] },
        { kind: "circle", number: 1, members: ["c1"] },
        { kind: "circle", number: 2, members: ["c2"] },
      ],
    );
    const texts = missingList(translate("de"), view).entries.map((e) => e.text);
    expect(texts[0]).toMatch(/^Rechteck 1 lässt sich noch verschieben\./);
    expect(texts[1]).toMatch(/^Rechteck 2 lässt sich noch verschieben\./);
    expect(texts[2]).toBe("Kreis 1 hat noch keinen festen Durchmesser. Den Durchmesser bemaßen.");
    expect(texts[3]).toBe("Kreis 2 hat noch keinen festen Durchmesser. Den Durchmesser bemaßen.");
    expect(missingList(translate("en"), view).entries[3]!.text).toBe("Circle 2 has no fixed diameter yet. Dimension the diameter.");
  });

  it("a group of connected shapes is called Form N, whatever tools made it; no numbered shape falls back to the bare kind", () => {
    const parts: ShapeSeed[] = [1, 2, 3, 4].map((n) => ({ kind: "line", number: n, members: [`l${n}`] }));
    const form = [{ number: 2, shapes: ["s0", "s1", "s2", "s3"] }];
    const fact = (ids: string[]): SketchView["freedom"] => [{ kind: "position", shape: "shape", moves: 2, elements: ids }];
    for (const ids of [["l1", "l2"], ["l1", "l2", "l3"], ["l1", "l2", "l3", "l4"]]) {
      expect(missingList(translate("de"), viewWith(fact(ids), undefined, parts, { forms: form })).entries[0]!.text).toMatch(/^Form 2 lässt sich noch verschieben./);
      expect(missingList(translate("en"), viewWith(fact(ids), undefined, parts, { forms: form })).entries[0]!.text).toMatch(/^Shape 2 can still be moved./);
    }
    // One shape of the group by itself keeps its kind's name; elements of no numbered shape are named by the kind the engine found.
    expect(missingList(translate("de"), viewWith(fact(["l3"]), undefined, parts, { forms: form })).entries[0]!.text).toMatch(/^Linie 3 lässt sich/);
    expect(missingList(translate("de"), viewWith(fact(["l9"]), undefined, parts)).entries[0]!.text).toMatch(/^Form lässt sich noch verschieben/);
  });

  it("a free rectangle: the position, then the width and the height by the direction of their sides", () => {
    const view = viewWith(
      [
        { kind: "position", shape: "rectangle", moves: 2, elements: ["l1", "l2", "l3", "l4"] },
        { kind: "length", shape: "rectangle", elements: ["l1", "l3"] },
        { kind: "length", shape: "rectangle", elements: ["l2", "l4"] },
      ],
      rectangle,
      [rect1],
    );
    const list = missingList(translate("de"), view);
    expect(list.onlyPosition).toBe(false);
    expect(list.entries.map((e) => e.label)).toEqual(["Lage frei", "Breite frei", "Höhe frei"]);
    expect(list.entries[1]!.text).toBe("Die Breite von Rechteck 1 ist noch nicht festgelegt. Eine waagerechte Seite bemaßen.");
    expect(list.entries[2]!.elements).toEqual(["l2", "l4"]);
  });

  it("a rectangle that is turned has a side length, not a width", () => {
    const turned: Parameters<FakeEditor["seed"]>[0] = { ...rectangle, points: [["p1", 0, 0], ["p2", 10, 5], ["p3", 6, 13], ["p4", -4, 8]] };
    const view = viewWith([{ kind: "length", shape: "rectangle", elements: ["l1", "l3"] }], turned, [rect1]);
    expect(missingList(translate("de"), view).entries[0]!.label).toBe("Seitenlänge frei");
  });

  it("circles, lines, points: one sentence each, with the name, and a count when several change together", () => {
    const view = viewWith(
      [
        { kind: "radius", shape: "circle", elements: ["c1"] },
        { kind: "direction", shape: "line", elements: ["l1"] },
        { kind: "length", shape: "line", elements: ["l1", "l2", "l3"] },
        { kind: "rotation", shape: "line", elements: ["l1"] },
        { kind: "point", shape: "shape", elements: ["pc"] },
        { kind: "point", shape: "shape", elements: ["px"] },
      ],
      { points: [["pc", 1, 1], ["px", 9, 9]], circles: [["c1", "pc", 3]] },
      [{ kind: "circle", number: 1, members: ["pc", "c1"] }, { kind: "line", number: 1, members: ["l1"] }, { kind: "line", number: 2, members: ["l2"] }, { kind: "line", number: 3, members: ["l3"] }],
      { forms: [{ number: 1, shapes: ["s1", "s2", "s3"] }] },
    );
    const texts = missingList(translate("de"), view).entries.map((e) => `${e.label}: ${e.text}`);
    expect(texts).toEqual([
      "Durchmesser frei: Kreis 1 hat noch keinen festen Durchmesser. Den Durchmesser bemaßen.",
      "Winkel frei: Die Richtung von Linie 1 ist noch frei. Einen Winkel bemaßen oder die Linie waagerecht oder senkrecht machen.",
      "Länge frei: Die Länge von 3 Linien von Form 1 ist noch nicht festgelegt. Die Länge einer davon bemaßen.",
      "Drehung frei: Linie 1 lässt sich noch drehen. Eine Linie waagerecht oder senkrecht machen oder einen Winkel bemaßen.",
      "Mittelpunkt frei: Der Mittelpunkt von Kreis 1 lässt sich noch verschieben. Seinen Abstand zu einer Linie oder einem Punkt bemaßen.",
      "Punkt frei: Der Punkt lässt sich noch gegen den Rest von Form bemaßen. Ihn bemaßen oder mit einer Abhängigkeit festlegen.".replace("gegen den Rest von Form bemaßen", "gegen den Rest von Form verschieben"),
    ]);
  });

  it("movement along one direction only; only position and rotation free counts as only the position", () => {
    const shapes: ShapeSeed[] = [{ kind: "circle", number: 2, members: ["c1"] }];
    const one = viewWith([{ kind: "position", shape: "circle", moves: 1, elements: ["c1"] }, { kind: "rotation", shape: "circle", elements: ["c1"] }], undefined, shapes);
    const list = missingList(translate("en"), one);
    expect(list.onlyPosition).toBe(true);
    expect(list.entries[0]!.text).toBe("Circle 2 can still be moved in one direction. Fix a point with Fix, put it on an axis or dimension another distance from the origin.");
    expect(missingList(translate("en"), viewWith([{ kind: "position", shape: "circle", moves: 2, elements: ["c1"] }, { kind: "radius", shape: "circle", elements: ["c1"] }], undefined, shapes)).onlyPosition).toBe(false);
  });

  it("nothing free, nothing listed; every entry is a complete sentence in both languages", () => {
    expect(missingList(translate("de"), viewWith([])).entries).toEqual([]);
    expect(missingList(translate("de"), viewWith([])).onlyPosition).toBe(false);
    for (const language of ["de", "en"] as const) {
      const all = viewWith(
        ["position", "rotation", "length", "direction", "radius", "point"].flatMap((kind) =>
          ["point", "line", "circle", "rectangle", "shape"].map((shape) => ({ kind, shape, moves: 2, elements: ["x", "y"] }) as SketchView["freedom"][number]),
        ),
      );
      for (const e of missingList(translate(language), all).entries) {
        expect(e.text).toMatch(/[.]$/);
        expect(e.text).not.toMatch(/\{|undefined/);
      }
    }
    expect(MISSING_SHOWN).toBeGreaterThanOrEqual(3);
  });

  it("shape names: the word of the kind and the stored number, in both languages", () => {
    expect(shapeName(translate("de"), { kind: "rectangle", number: 1 })).toBe("Rechteck 1");
    expect(shapeName(translate("de"), { kind: "circle", number: 12 })).toBe("Kreis 12");
    expect(shapeName(translate("de"), { kind: "line", number: 3 })).toBe("Linie 3");
    expect(shapeName(translate("en"), { kind: "rectangle", number: 1 })).toBe("Rectangle 1");
    expect(shapeName(translate("en"), { kind: "circle", number: 2 })).toBe("Circle 2");
    expect(shapeName(translate("en"), { kind: "line", number: 3 })).toBe("Line 3");
    expect(shapeName(translate("de"), { kind: "arc", number: 1 })).toBe("Bogen 1");
    expect(shapeName(translate("en"), { kind: "spline", number: 1 })).toBe("Spline 1");
  });
});

describe("the chip of the collapsed list", () => {
  const drawn: Parameters<FakeEditor["seed"]>[0] = { points: [["p1", 0, 0], ["p2", 5, 0]], lines: [["l1", "p1", "p2"]] };
  it("nothing drawn: no chip", () => {
    expect(chipState(viewWith([]))).toEqual({ kind: "none" });
  });
  it("something free: a neutral count of the open entries - position free is no error", () => {
    const view = viewWith([{ kind: "position", shape: "line", moves: 2, elements: ["l1"] }, { kind: "length", shape: "line", elements: ["l1"] }], drawn, [], { dof: 3 });
    expect(chipState(view)).toEqual({ kind: "open", count: 2 });
  });
  it("an engine without the facts still counts the degrees of freedom", () => {
    expect(chipState(viewWith([], drawn, [], { dof: 5 }))).toEqual({ kind: "open", count: 5 });
  });
  it("everything determined: a check", () => {
    expect(chipState(viewWith([], drawn, [], { dof: 0 }))).toEqual({ kind: "full" });
  });
  it("a warning only for a real problem: contradicting, repeated or not solvable", () => {
    for (const status of ["conflicting", "redundant", "failed"] as const) expect(chipState(viewWith([], drawn, [], { status, dof: 2 }))).toEqual({ kind: "problem" });
  });
});
