// What the highlight marks (per loop, holes stay empty): the band runs along every determined
// loop on its own, the fill covers every region whose outer loop is determined.
import { describe, expect, it } from "vitest";
import { bandOfLoops, determinedLoops } from "../../../app/src/viewport/sketch/band.ts";
import { filledProfiles } from "../../../app/src/viewport/sketch/three-profile-fill.ts";
import { rectangleProfile } from "./sketch-fixtures.ts";

const hole = { x: 30, y: 20, r: 8 };
/** The rectangle 0..60 x 0..40 with a round hole: outer loop and hole loop have their own state. */
const frame = (outer: boolean, inner: boolean) => rectangleProfile("r", 0, 0, 60, 40, outer && inner, [hole], [outer, inner]);

describe("the band of determined loops", () => {
  it("a determined rectangle with a free hole gets a band on the rectangle only", () => {
    const p = frame(true, false);
    const loops = determinedLoops([p]);
    expect(loops).toEqual([p.loops[0]]);
    const band = bandOfLoops(loops, 1.6);
    // Four corners, two vertices each; the free hole's 24 points would have added 48 more.
    expect(band.positions.length / 2).toBe(8);
  });

  it("a free outer loop with a determined hole gets the band on the hole only", () => {
    const p = frame(false, true);
    expect(determinedLoops([p])).toEqual([p.loops[1]]);
  });

  it("every loop determined: all loops; none determined: nothing", () => {
    const all = frame(true, true);
    expect(determinedLoops([all])).toEqual(all.loops);
    expect(determinedLoops([frame(false, false)])).toEqual([]);
  });

  it("works over several regions and ignores regions with no loops determined", () => {
    const a = frame(true, false);
    const b = rectangleProfile("b", 100, 0, 140, 30, false);
    const c = rectangleProfile("c", 200, 0, 240, 30, true);
    expect(determinedLoops([a, b, c])).toEqual([a.loops[0], c.loops[0]]);
  });
});

describe("the fill of determined regions", () => {
  it("a region is filled when its outer loop is determined, whether its hole is or not", () => {
    const free = frame(true, false), tied = frame(true, true);
    expect(filledProfiles([free, tied])).toEqual([free, tied]);
  });

  it("a free outer loop is not filled, even when its hole is determined; open or free regions never", () => {
    expect(filledProfiles([frame(false, true), frame(false, false), rectangleProfile("q", 0, 0, 5, 5, false)])).toEqual([]);
  });

  it("the hole stays empty: the fill the engine delivers has the hole cut out (the highlight adds nothing in it)", () => {
    // The highlight only chooses regions; it never fills a loop that is a hole. A determined hole is a region of its own
    // (the disc) and is filled as that one, not as part of the frame.
    const disc = rectangleProfile("c1", 22, 12, 38, 28, true);
    expect(filledProfiles([frame(true, true), disc]).map((p) => p.key)).toEqual(["r", "c1"]);
  });
});
