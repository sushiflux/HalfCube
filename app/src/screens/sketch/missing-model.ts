// "What is still missing" in plain words: the facts the engine reports about what is still free (SketchView.freedom) turned into
// entries of the palette - a short label ("Lage frei", "Durchmesser frei"), one complete sentence that names the shape ("Kreis 2
// lässt sich noch verschieben ...") and says what to do, and the elements to highlight - plus the state of the small chip the list
// hides behind. Pure: view and translator in, entries out.
import type { Translate } from "../../i18n/core.ts";
import type { SketchView } from "../../model/index.ts";
import { nameOfElements } from "./shape-name.ts";

export interface MissingEntry {
  /** Stable key of the entry (kind and elements), for React and the tests. */
  key: string;
  kind: SketchView["freedom"][number]["kind"];
  label: string;
  text: string;
  /** What lights up in the view while the entry is hovered, focused or picked, and what a click brings into view. */
  elements: string[];
}

/** How many entries the palette shows before it says "and N more". */
export const MISSING_SHOWN = 4;

type Fact = SketchView["freedom"][number];

/** Whether every line in the list runs along u (horizontal) or along v (vertical) in the sketch; null for neither or a mix. */
function orientation(view: SketchView, ids: readonly string[]): "horizontal" | "vertical" | null {
  let found: "horizontal" | "vertical" | null = null;
  for (const id of ids) {
    const line = view.lines.find((l) => l.id === id);
    const a = view.points.find((p) => p.id === line?.p1);
    const b = view.points.find((p) => p.id === line?.p2);
    if (!line || !a || !b) return null;
    const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
    const length = Math.hypot(dx, dy);
    const now = dy <= 1e-4 * length ? "horizontal" : dx <= 1e-4 * length ? "vertical" : null;
    if (now === null || (found !== null && found !== now)) return null;
    found = now;
  }
  return found;
}

/** What the fact is about, by the names the user sees (shape-name.ts): one shape by its kind and number, several by their Form. */
function nameOf(t: Translate, view: SketchView, fact: Fact): string {
  return nameOfElements(t, view, fact.elements, t(`sketch.missing.subject.${fact.shape}`));
}

function entryOf(t: Translate, view: SketchView, fact: Fact): MissingEntry {
  const key = `${fact.kind}:${fact.elements.join(",")}`;
  const name = nameOf(t, view, fact);
  const base = { key, kind: fact.kind, elements: fact.elements };
  const count = fact.elements.length;
  switch (fact.kind) {
    case "position":
      return {
        ...base,
        label: t("sketch.missing.positionLabel"),
        text: fact.moves === 1 ? t("sketch.missing.positionOne", { name }) : `${t("sketch.missing.positionFirst", { name })} ${t(`sketch.missing.position.${fact.shape}`)}`,
      };
    case "rotation":
      return { ...base, label: t("sketch.missing.rotationLabel"), text: t("sketch.missing.rotation", { name }) };
    case "length": {
      if (fact.shape === "rectangle") {
        const direction = orientation(view, fact.elements);
        if (direction === "horizontal") return { ...base, label: t("sketch.missing.widthLabel"), text: t("sketch.missing.width", { name }) };
        if (direction === "vertical") return { ...base, label: t("sketch.missing.heightLabel"), text: t("sketch.missing.height", { name }) };
        return { ...base, label: t("sketch.missing.sideLabel"), text: t("sketch.missing.side", { name }) };
      }
      return { ...base, label: t("sketch.missing.lengthLabel"), text: count === 1 ? t("sketch.missing.lengthOne", { name }) : t("sketch.missing.lengthMany", { name, count }) };
    }
    case "direction":
      return { ...base, label: t("sketch.missing.directionLabel"), text: count === 1 ? t("sketch.missing.directionOne", { name }) : t("sketch.missing.directionMany", { name, count }) };
    case "radius":
      return { ...base, label: t("sketch.missing.radiusLabel"), text: count === 1 ? t("sketch.missing.radiusOne", { name }) : t("sketch.missing.radiusMany", { name, count }) };
    case "point": {
      const centre = view.circles.some((c) => c.center === fact.elements[0]);
      return centre
        ? { ...base, label: t("sketch.missing.centreLabel"), text: t("sketch.missing.centre", { name }) }
        : { ...base, label: t("sketch.missing.pointLabel"), text: t("sketch.missing.point", { name }) };
    }
  }
}

/** All entries, in the engine's order. Empty for a sketch the engine has no facts for (fully defined, drawn nothing, not analysed). */
export function missingEntries(t: Translate, view: SketchView): MissingEntry[] {
  return view.freedom.map((fact) => entryOf(t, view, fact));
}

export interface MissingList {
  /** Shape and size are fully determined and only the position (moving, turning) is free: said first, as one positive line. */
  onlyPosition: boolean;
  entries: MissingEntry[];
}

export function missingList(t: Translate, view: SketchView): MissingList {
  const entries = missingEntries(t, view);
  return { onlyPosition: view.freedom.length > 0 && view.freedom.every((f) => f.kind === "position" || f.kind === "rotation"), entries };
}

/**
 * The compact chip the list hides behind (collapsed by default): a neutral count while something is still free, a check when
 * everything is determined, a warning only for a real problem (constraints that contradict or repeat each other, a sketch that
 * cannot be solved). "Position free" is no error, so it never gets the warning. None: nothing drawn yet, no chip.
 */
export type ChipState = { kind: "none" } | { kind: "open"; count: number } | { kind: "full" } | { kind: "problem" };

export function chipState(view: SketchView): ChipState {
  if (view.status === "conflicting" || view.status === "redundant" || view.status === "failed") return { kind: "problem" };
  if (view.points.length === 0 && view.lines.length === 0 && view.circles.length === 0) return { kind: "none" };
  if (view.dof === 0) return { kind: "full" };
  // An engine without the facts (or a sketch it does not analyse) still says that something is open: count its degrees of freedom.
  return { kind: "open", count: view.freedom.length > 0 ? view.freedom.length : view.dof };
}
