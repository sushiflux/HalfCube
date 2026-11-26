// A stand-in for the engine that answers sketch.solve at once: nothing moves, every sketch is solved except the ones the
// test refuses, and a reference dimension (driving false) reports the length it would measure. Enough for the tests of
// undo steps, which count commits and do not care about the geometry.
import type { Reply } from "../../../app/src/engine/client.ts";
import type { SketchSolveResult } from "../../../app/src/engine/generated/protocol.ts";
import type { SketchData } from "../../../app/src/document/types.ts";
import type { EngineLink } from "../../../app/src/model/engine-link.ts";

export type SolveCommand = Extract<Parameters<EngineLink["request"]>[0], { type: "sketch.solve" }>;

export interface SolveLinkOptions {
  /** Return a status to refuse the proposed sketch with it, or null to solve it. */
  refuse?: (sketch: SketchData) => "conflicting" | "redundant" | null;
}

export function solveLink(options: SolveLinkOptions = {}): EngineLink {
  let n = 0;
  return {
    isReady: () => true,
    onReady: () => () => undefined,
    request: ((command: SolveCommand) => {
      const id = ++n;
      const sketch = command.sketch;
      const refused = options.refuse?.(sketch) ?? null;
      const at = (pid: string | undefined) => sketch.points.find((p) => p.id === pid);
      const reference: Record<string, number> = {};
      for (const c of sketch.constraints) {
        if (!("driving" in c) || c.driving) continue;
        // A length of a line or between two points; every other reference dimension reads 1.
        const [a, b] = c.refs;
        const line = sketch.lines.find((l) => l.id === a);
        const [p, q] = line ? [at(line.p1), at(line.p2)] : [at(a), at(b)];
        reference[c.id] = p && q ? Math.hypot(q.x - p.x, q.y - p.y) : 1;
      }
      const message: SketchSolveResult = {
        type: "sketchSolveResult",
        replyTo: id,
        status: refused ?? "solved",
        dof: 0,
        points: sketch.points.map((p) => ({ id: p.id, x: p.x, y: p.y })),
        circles: [],
        entities: {},
        constraints: {},
        conflicting: refused === "conflicting" ? ["k9"] : [],
        redundant: refused === "redundant" ? ["d3"] : [],
        partiallyRedundant: [],
        reference,
        profiles: [],
        freedom: [],
        frame: { origin: { x: 0, y: 0, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
        timeMs: 1,
      };
      const reply: Promise<Reply<"sketch.solve">> = Promise.resolve({ message, payload: new ArrayBuffer(0) });
      return { id, reply };
    }) as unknown as EngineLink["request"],
    cancel: () => undefined,
  };
}
