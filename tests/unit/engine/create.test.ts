// createEngineSession without the Electron preload bridge: there is no other engine, so the start must fail with a
// complete cause instead of silently trying something else.
import { describe, expect, it } from "vitest";
import { createEngineSession } from "../../../app/src/engine/create.ts";

describe("createEngineSession", () => {
  it("fails the start with a complete cause when the desktop bridge is missing", async () => {
    const session = createEngineSession({ restartDelayMs: 0 });
    const status = await session.start();
    expect(status.phase).toBe("failed");
    expect(status.problem?.code).toBe("engine_start_failed");
    expect(status.problem?.message).toBe("The desktop bridge of the Electron window is missing; HalfCube runs only as the desktop program.");
    expect(status.problem?.details).toContain("Connection: native engine process");
  });
});
