// Shared references for the spike's automated UI run (autotest.ts); not part of the product design.
import type { Viewport } from "./viewport.ts";

export const spikeHooks: { viewport: Viewport | null } = { viewport: null };
