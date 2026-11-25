// Hang and crash of the WebAssembly engine in a real Web Worker (browser only; the testing variant of the engine, which
// has diagnostics.hang and diagnostics.crash, is part of the suite's build and never of a product build). The watchdog
// must stop a frozen worker and the session must replace it, also after a trap.
import { expect, test } from "../support/fixtures.ts";
import type { HarnessResult } from "../harness/main.ts";

test("a frozen engine worker is stopped by the watchdog and replaced; a trap is reported and replaced", async ({ app }, testInfo) => {
  const { page } = app;
  await page.goto(app.url("/harness/index.html?folder=engine-testing"));
  await page.waitForFunction(() => "__harness" in window);
  const result: HarnessResult = await page.evaluate(() => window.__harness.run("hang-and-trap"));
  testInfo.annotations.push({ type: "engine", description: `hang-and-trap: ${app.description}` });
  await testInfo.attach("hang-and-trap.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });

  expect(result.transport).toBe("worker");
  expect(result.startup.phase).toBe("ready");

  const { hang, trap } = result;
  expect(hang, "hang result").toBeDefined();
  expect(trap, "trap result").toBeDefined();
  if (!hang || !trap) return;

  // The request had a 500 ms limit: the watchdog fires after it, not much later.
  expect(hang.name).toBe("EngineCrashedError");
  expect(hang.info).toMatchObject({ kind: "hang" });
  expect(hang.ms).toBeGreaterThanOrEqual(500);
  expect(hang.ms).toBeLessThan(5000);
  expect(JSON.stringify(hang.info)).toContain("The engine worker was terminated");
  expect(hang.afterPhase).toBe("ready");
  expect(hang.restarts).toBe(1);
  expect(hang.history).toEqual(["engine_hung"]);

  expect(trap.name).toBe("EngineCrashedError");
  expect(trap.info).toMatchObject({ kind: "fatal" });
  expect(JSON.stringify(trap.info)).toContain("divide by zero");
  expect(trap.afterPhase).toBe("ready");
  expect(trap.restarts).toBe(2);
});
