// The closed regions of a sketch, asked from the engine in one sketch.solve (with the element states, so every region says
// which of its loops are determined). Shared by the extrude command (its own sketch) and by the toolbar, which needs to know
// whether any finished sketch has something to extrude.
import type { SketchFeature } from "../document/types.ts";
import type { EngineLink } from "./engine-link.ts";
import { SKETCH_SOLVE_TIMEOUT_MS } from "./engine-link.ts";
import type { SketchProfiles } from "./editors.ts";
import { profileView } from "./payload.ts";

export async function solveSketchProfiles(link: EngineLink, feature: SketchFeature): Promise<SketchProfiles> {
  const reply = await link.request(
    { type: "sketch.solve", sketch: feature.sketch, plane: feature.plane, diagnose: true, profiles: true },
    { timeoutMs: SKETCH_SOLVE_TIMEOUT_MS },
  ).reply;
  const m = reply.message;
  return { frame: m.frame, profiles: m.profiles.map((r) => profileView(r, reply.payload, m.entities)) };
}
