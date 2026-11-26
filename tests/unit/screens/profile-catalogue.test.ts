import { describe, expect, it } from "vitest";
import type { SketchData, SketchFeature } from "../../../app/src/document/types.ts";
import type { ProfileView, SketchProfiles } from "../../../app/src/model/index.ts";
import {
  allProfiles,
  choosePreselect,
  ProfileCatalogue,
  profileNumber,
  sameProfile,
  type CatalogueEntry,
} from "../../../app/src/screens/main/profile-catalogue.ts";

const frame = { origin: { x: 0, y: 0, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 } };
const area = (key: string): ProfileView => ({
  key,
  outer: [],
  holes: [],
  area: 1,
  determined: true,
  loopsDetermined: [true],
  fill: { positions: new Float32Array(), indices: new Uint32Array() },
  loops: [],
});
const sketchData = (): SketchData => ({ points: [], lines: [], circles: [], constraints: [] });
const feature = (id: string, sketch: SketchData = sketchData(), name = `Skizze ${id}`): SketchFeature => ({
  id,
  type: "sketch",
  name,
  component: "root",
  visible: true,
  plane: { kind: "originPlane", plane: "xy" },
  sketch,
});

/** A probe whose answers the test completes by hand. */
function fakeProbe() {
  const calls: { feature: SketchFeature; resolve: (r: SketchProfiles) => void; reject: (e: Error) => void }[] = [];
  const probe = (f: SketchFeature) =>
    new Promise<SketchProfiles>((resolve, reject) => {
      calls.push({ feature: f, resolve, reject });
    });
  return { probe, calls };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ProfileCatalogue", () => {
  it("asks the engine once per sketch and lists the sketches that have at least one area", async () => {
    const { probe, calls } = fakeProbe();
    const c = new ProfileCatalogue(probe);
    const a = feature("f1");
    const b = feature("f2");
    c.sync([a, b], true);
    expect(calls).toHaveLength(2);
    expect(c.getSnapshot()).toEqual([]);
    calls[0]?.resolve({ frame, profiles: [area("l1,l2,l3")] });
    calls[1]?.resolve({ frame, profiles: [] }); // an open sketch: no closed area, not listed
    await flush();
    expect(c.getSnapshot().map((e) => e.sketchId)).toEqual(["f1"]);
    // The same sketch data again: nothing is asked.
    c.sync([a, b], true);
    expect(calls).toHaveLength(2);
  });

  it("asks again when the data of a sketch changed, and drops an answer that is out of date", async () => {
    const { probe, calls } = fakeProbe();
    const c = new ProfileCatalogue(probe);
    const sketch = sketchData();
    c.sync([feature("f1", sketch)], true);
    const changed = { ...sketch };
    c.sync([feature("f1", changed)], true);
    expect(calls).toHaveLength(2);
    calls[1]?.resolve({ frame, profiles: [area("new")] });
    calls[0]?.resolve({ frame, profiles: [area("old")] }); // arrives late
    await flush();
    expect(c.getSnapshot()[0]?.profiles.map((p) => p.key)).toEqual(["new"]);
  });

  it("forgets sketches that are gone and notifies listeners only when the list changes", async () => {
    const { probe, calls } = fakeProbe();
    const c = new ProfileCatalogue(probe);
    let notified = 0;
    c.subscribe(() => notified++);
    const a = feature("f1");
    c.sync([a], true);
    calls[0]?.resolve({ frame, profiles: [area("x")] });
    await flush();
    const before = notified;
    c.sync([a], true);
    expect(notified).toBe(before);
    c.sync([], true);
    expect(c.getSnapshot()).toEqual([]);
    expect(notified).toBeGreaterThan(before);
  });

  it("waits for the engine: nothing is asked while it is not ready, and a failed sketch is asked again when it is", async () => {
    const { probe, calls } = fakeProbe();
    const c = new ProfileCatalogue(probe);
    const a = feature("f1");
    c.sync([a], false);
    expect(calls).toHaveLength(0);
    c.sync([a], true);
    expect(calls).toHaveLength(1);
    calls[0]?.reject(new Error("The engine crashed"));
    await flush();
    expect(c.getSnapshot()).toEqual([]);
    c.sync([a], false); // still down: no new ask
    expect(calls).toHaveLength(1);
    c.sync([a], true); // up again
    expect(calls).toHaveLength(2);
  });

  it("follows a renamed sketch without asking again", async () => {
    const { probe, calls } = fakeProbe();
    const c = new ProfileCatalogue(probe);
    const data = sketchData();
    c.sync([feature("f1", data, "Skizze1")], true);
    calls[0]?.resolve({ frame, profiles: [area("x")] });
    await flush();
    c.sync([feature("f1", data, "Grundriss")], true);
    expect(calls).toHaveLength(1);
    expect(c.getSnapshot()[0]?.name).toBe("Grundriss");
  });
});

describe("helpers", () => {
  const entries: CatalogueEntry[] = [
    { sketchId: "f1", name: "Skizze1", frame, profiles: [area("a"), area("b")] },
    { sketchId: "f3", name: "Skizze2", frame, profiles: [area("c")] },
  ];
  it("lists every area with its sketch and numbers it within the sketch", () => {
    expect(allProfiles(entries)).toEqual([
      { sketchId: "f1", regionId: "a" },
      { sketchId: "f1", regionId: "b" },
      { sketchId: "f3", regionId: "c" },
    ]);
    expect(profileNumber(entries, { sketchId: "f1", regionId: "b" })).toEqual({ n: 2, sketch: "Skizze1" });
    expect(profileNumber(entries, { sketchId: "f1", regionId: "zz" })).toBeNull();
  });
  it("preselects only a selected sketch with exactly one area", () => {
    expect(choosePreselect(entries, "f3")).toEqual({ sketchId: "f3", regionId: "c" });
    expect(choosePreselect(entries, "f1")).toBeNull();
    expect(choosePreselect(entries, null)).toBeNull();
    expect(choosePreselect(entries, "f9")).toBeNull();
  });
  it("compares areas by sketch and key", () => {
    expect(sameProfile({ sketchId: "f1", regionId: "a" }, { sketchId: "f1", regionId: "a" })).toBe(true);
    expect(sameProfile({ sketchId: "f1", regionId: "a" }, { sketchId: "f2", regionId: "a" })).toBe(false);
    expect(sameProfile(null, null)).toBe(true);
    expect(sameProfile(null, { sketchId: "f1", regionId: "a" })).toBe(false);
  });
});
