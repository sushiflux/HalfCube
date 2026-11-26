// Which closed areas the finished sketches of the document have. The toolbar needs it to enable "Extrudieren", and the extrude
// command offers these areas to pick. The engine finds them (one sketch.solve per sketch); nothing is drawn from this list
// outside the extrude command (there is no permanent profile fill outside a sketch).
//
// A sketch is asked again only when its data object changed (the document is immutable: an edit, an undo or a load gives a
// new object), never on every document change. An answer that arrives for data that is out of date is dropped.
import type { SketchData, SketchFeature } from "../../document/types.ts";
import type { PlaneFrame } from "../../engine/generated/protocol.ts";
import type { ProfileView, SketchProfiles } from "../../model/index.ts";

export interface CatalogueEntry {
  sketchId: string;
  name: string;
  frame: PlaneFrame;
  profiles: readonly ProfileView[];
}

/** A closed area as the command names it: the sketch step and the region key the engine gave it. */
export interface ProfileRef {
  sketchId: string;
  regionId: string;
}

export const sameProfile = (a: ProfileRef | null, b: ProfileRef | null): boolean =>
  a === null || b === null ? a === b : a.sketchId === b.sketchId && a.regionId === b.regionId;

interface Slot {
  data: SketchData;
  name: string;
  state: "pending" | "ready" | "failed";
  result?: SketchProfiles;
}

export type ProfileProbe = (feature: SketchFeature) => Promise<SketchProfiles>;

export class ProfileCatalogue {
  private readonly slots = new Map<string, Slot>();
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly CatalogueEntry[] = [];
  private readonly probe: ProfileProbe;

  constructor(probe: ProfileProbe) {
    this.probe = probe;
  }

  getSnapshot = (): readonly CatalogueEntry[] => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Follows the given sketches (the finished ones; the open sketch is not listed). New or changed ones are asked from the
   * engine, sketches that are no longer listed are forgotten. With `ready` false nothing is asked yet and a failed one is
   * not retried: call sync again when the engine is ready.
   */
  sync(features: readonly SketchFeature[], ready: boolean): void {
    let changed = false;
    const keep = new Set(features.map((f) => f.id));
    for (const id of [...this.slots.keys()]) {
      if (!keep.has(id)) {
        this.slots.delete(id);
        changed = true;
      }
    }
    for (const feature of features) {
      const slot = this.slots.get(feature.id);
      if (slot && slot.data === feature.sketch && (slot.state !== "failed" || !ready)) {
        if (slot.name !== feature.name) {
          slot.name = feature.name;
          changed = true;
        }
        continue;
      }
      if (!ready) {
        // Not asked yet: the sketch has no answer, whatever it had before (its data changed).
        if (slot) {
          this.slots.delete(feature.id);
          changed = true;
        }
        continue;
      }
      const next: Slot = { data: feature.sketch, name: feature.name, state: "pending" };
      this.slots.set(feature.id, next);
      changed = true;
      this.probe(feature).then(
        (result) => {
          if (this.slots.get(feature.id) !== next) return; // out of date: a newer ask replaced it
          next.state = "ready";
          next.result = result;
          this.publish();
        },
        () => {
          if (this.slots.get(feature.id) !== next) return;
          next.state = "failed";
          this.publish();
        },
      );
    }
    if (changed) this.publish();
  }

  /** Rebuilds the snapshot (sketches with an answer and at least one area, in the order they were first seen). */
  private publish(): void {
    const entries: CatalogueEntry[] = [];
    for (const [sketchId, slot] of this.slots) {
      if (slot.state === "ready" && slot.result && slot.result.profiles.length > 0) {
        entries.push({ sketchId, name: slot.name, frame: slot.result.frame, profiles: slot.result.profiles });
      }
    }
    this.snapshot = entries;
    for (const l of [...this.listeners]) l();
  }
}

/** Every area of every sketch in the catalogue, as the command names them. */
export function allProfiles(entries: readonly CatalogueEntry[]): ProfileRef[] {
  return entries.flatMap((e) => e.profiles.map((p) => ({ sketchId: e.sketchId, regionId: p.key })));
}

/**
 * The area to start the extrusion with when the user has chosen something beforehand: a selected sketch step that has exactly one
 * closed area. Otherwise (nothing selected, a sketch with several areas) the command asks.
 */
export function choosePreselect(entries: readonly CatalogueEntry[], selectedStepId: string | null): ProfileRef | null {
  if (selectedStepId === null) return null;
  const entry = entries.find((e) => e.sketchId === selectedStepId);
  const [only, ...more] = entry?.profiles ?? [];
  return entry && only && more.length === 0 ? { sketchId: entry.sketchId, regionId: only.key } : null;
}

/** "Fläche 2 · Skizze1": the 1-based position of an area in its sketch's list. */
export function profileNumber(entries: readonly CatalogueEntry[], ref: ProfileRef): { n: number; sketch: string } | null {
  const entry = entries.find((e) => e.sketchId === ref.sketchId);
  if (!entry) return null;
  const index = entry.profiles.findIndex((p) => p.key === ref.regionId);
  return index < 0 ? null : { n: index + 1, sketch: entry.name };
}
