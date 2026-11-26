// The engine through its real transport: in a browser the WebAssembly engine in a real Web Worker, in the Electron
// program the native engine process behind the preload bridge. The harness page (tests/e2e/harness) runs the product's
// own engine session in the page; the tests read what it reports. The browser name and version and the numbers of both
// self-tests go into the test annotations (HTML and JSON report) and into an attachment.
import type { TestInfo } from "@playwright/test";
import type { HarnessResult } from "../harness/main.ts";
import { expect, test, type AppUnderTest } from "../support/fixtures.ts";

async function runHarness(app: AppUnderTest, run: string, query = ""): Promise<HarnessResult> {
  const { page } = app;
  await page.goto(app.url(`/harness/index.html${query}`));
  await page.waitForFunction(() => "__harness" in window);
  return page.evaluate((name) => window.__harness.run(name), run);
}

/** Records what ran and what came out, so a report shows the browser and the numbers, not only "passed". */
async function record(app: AppUnderTest, name: string, result: HarnessResult, testInfo: TestInfo): Promise<void> {
  const engineDetail = result.startup?.steps.find((s) => s.id === "engine")?.detail;
  const summary = [
    `${name}: ${app.description}`,
    engineDetail ? `engine build: ${engineDetail}` : "",
    `engine transport: ${result.transport}`,
    result.kernel ? `kernel self-test: passed=${result.kernel.passed}, ${result.kernel.faceCount} faces, volume ${result.kernel.volume.toFixed(3)} mm3 (expected ${result.kernel.expectedVolume.toFixed(3)}), ${result.kernel.timeMs.toFixed(1)} ms` : "",
    result.solver
      ? `solver self-test: passed=${result.solver.passed}, status ${result.solver.status}, dof ${result.solver.dof}/${result.solver.expectedDof}, ${result.solver.constraintCount} constraints, max residual ${result.solver.maxResidual.toExponential(2)}, ${result.solver.timeMs.toFixed(1)} ms`
      : "",
  ].filter((line) => line !== "");
  for (const line of summary) testInfo.annotations.push({ type: "engine", description: line });
  await testInfo.attach(`${name}.json`, { body: JSON.stringify({ target: app.description, result }, null, 2), contentType: "application/json" });
}

function expectSelftestsPassed(result: HarnessResult): void {
  const { kernel, solver } = result;
  expect(kernel, "the kernel self-test ran").toBeDefined();
  expect(solver, "the solver self-test ran").toBeDefined();
  if (!kernel || !solver) return;

  expect(kernel.passed, kernel.problem ?? "kernel self-test").toBe(true);
  expect(kernel.steps.map((s) => s.name)).toEqual(["box", "hole", "fillet"]);
  for (const step of kernel.steps) {
    expect(step.valid, `kernel step ${step.name}: ${step.problem ?? "valid"}`).toBe(true);
    expect(step.solidCount, `kernel step ${step.name}: solids`).toBe(1);
    expect(Math.abs(step.volume - step.expectedVolume) / step.expectedVolume, `kernel step ${step.name}: volume`).toBeLessThanOrEqual(kernel.volumeTolerance);
    expect(step.faceCount, `kernel step ${step.name}: faces`).toBe(step.expectedFaceCount);
  }
  // Independent of the engine's own expected values: the closed form of the test body (a block 80 x 50 x 20 mm with a
  // hole of radius 10 mm and a fillet of 3 mm on the hole's top edge; the removed ring by Pappus' theorem).
  const block = 80 * 50 * 20;
  const withHole = block - Math.PI * 10 ** 2 * 20;
  const spandrel = 3 ** 2 * (1 - Math.PI / 4);
  const centroid = (3 * (5 / 6 - Math.PI / 4)) / (1 - Math.PI / 4);
  const filleted = withHole - 2 * Math.PI * (10 + centroid) * spandrel;
  expect(kernel.steps.map((s) => s.volume)).toEqual([block, withHole, filleted].map((v) => expect.closeTo(v, 4)));
  expect(Math.abs(kernel.volume - filleted) / filleted).toBeLessThanOrEqual(1e-6);
  expect(kernel.steps.map((s) => s.faceCount)).toEqual([6, 7, 8]);

  expect(solver.passed, solver.problem ?? "solver self-test").toBe(true);
  expect(solver.status).toBe("solved");
  expect(solver.dof, "fully constrained sketch").toBe(0);
  expect(solver.expectedDof).toBe(0);
  expect(solver.conflicting).toEqual([]);
  expect(solver.redundant).toEqual([]);
  expect(solver.maxResidual).toBeLessThanOrEqual(solver.residualTolerance);
  expect(solver.maxDeviation).toBeLessThanOrEqual(solver.residualTolerance);
  expect(solver.constraintCount).toBe(9);
  expect(solver.reference.referenceDiameter).toBeCloseTo(20, 9);
}

test("the engine starts and passes the kernel and solver self-tests of the normal start-up", async ({ app }, testInfo) => {
  const result = await runHarness(app, "startup");
  await record(app, "startup", result, testInfo);

  expect(result.transport).toBe(app.target === "electron" ? "native" : "worker");
  expect(result.crossOriginIsolated, "cross-origin isolation (needed for SharedArrayBuffer in the engine worker)").toBe(true);
  expect(result.startup.problem).toBeUndefined();
  expect(result.startup.phase).toBe("ready");
  expect(result.startup.engine).toBe("halfcube-engine");
  expect(result.startup.protocol).toBe(3);
  expect(result.startup.steps.map((s) => `${s.id}:${s.state}`)).toEqual(["engine:done", "kernel:done", "solver:done"]);
  // The loading screen follows these lines: one step after the other, never two at once.
  expect(result.stream).toEqual([
    "starting | engine:running,kernel:pending,solver:pending",
    "starting | engine:done,kernel:pending,solver:pending",
    "starting | engine:done,kernel:running,solver:pending",
    "starting | engine:done,kernel:done,solver:pending",
    "starting | engine:done,kernel:done,solver:running",
    "starting | engine:done,kernel:done,solver:done",
    "ready | engine:done,kernel:done,solver:done",
    "stopped | engine:done,kernel:done,solver:done",
  ]);
  expectSelftestsPassed(result);
});

test("diagnostics.kernelSelftest and diagnostics.solverSelftest answer through the transport", async ({ app }, testInfo) => {
  const result = await runHarness(app, "selftests");
  await record(app, "selftests", result, testInfo);

  expect(result.transport).toBe(app.target === "electron" ? "native" : "worker");
  expect(result.startup.steps.map((s) => `${s.id}:${s.state}`)).toEqual(["engine:done", "kernel:skipped", "solver:skipped"]);
  expectSelftestsPassed(result);
});
