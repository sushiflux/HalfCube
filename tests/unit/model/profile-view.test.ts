// Which loops of a region are fully determined (per loop): worked out from the element states of the
// same engine answer, so a free hole does not take the highlight from the determined loops around it.
import { describe, expect, it } from "vitest";
import { loopsDetermined, profileView } from "../../../app/src/model/payload.ts";
import type { Region } from "../../../app/src/engine/generated/protocol.ts";

const empty = { offset: 0, byteLength: 0 };
function region(outer: string[], holes: string[][], determined: boolean): Region {
  return {
    key: "r",
    outer,
    holes,
    area: 1,
    determined,
    fill: { positions: empty, indices: empty, triangleCount: 0 },
    loops: [empty, ...holes.map(() => empty)],
  };
}

describe("loopsDetermined", () => {
  const frame = ["l1", "l2", "l3", "l4"];

  it("a determined rectangle with a free circle inside: the outer loop is determined, the hole is not", () => {
    const states = { l1: "full", l2: "full", l3: "full", l4: "full", c1: "under" };
    expect(loopsDetermined({ outer: frame, holes: [["c1"]] }, states)).toEqual([true, false]);
  });

  it("every loop counts on its own: two holes, one determined", () => {
    const states = { l1: "full", l2: "full", l3: "full", l4: "full", c1: "full", c2: "under" };
    expect(loopsDetermined({ outer: frame, holes: [["c1"], ["c2"]] }, states)).toEqual([true, true, false]);
  });

  it("one free curve of a loop makes that loop free, an over-determined one too", () => {
    expect(loopsDetermined({ outer: frame, holes: [] }, { l1: "full", l2: "full", l3: "full", l4: "under" })).toEqual([false]);
    expect(loopsDetermined({ outer: frame, holes: [] }, { l1: "full", l2: "full", l3: "full", l4: "over" })).toEqual([false]);
  });

  it("a curve without a state is not determined; without any states nothing is", () => {
    expect(loopsDetermined({ outer: ["c1"], holes: [] }, {})).toEqual([false]);
    expect(loopsDetermined({ outer: ["c1"], holes: [["c2"]] }, undefined)).toEqual([false, false]);
  });

  it("is delivered with the profile view, in the order of the loops, next to the whole-region flag", () => {
    const view = profileView(region(frame, [["c1"]], false), new ArrayBuffer(0), { l1: "full", l2: "full", l3: "full", l4: "full", c1: "under" });
    expect(view.loopsDetermined).toEqual([true, false]);
    expect(view.determined).toBe(false);
    expect(view.loops).toHaveLength(2);
  });
});
