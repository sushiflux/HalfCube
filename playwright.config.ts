// End-to-end suite (Playwright). Run with `npm run test:e2e`; see tests/e2e/run.mjs.
//
// One project, "electron": every spec runs against the real desktop program (Electron, the native engine process), launched
// by the fixture in tests/e2e/support/electron-app.ts as an inactive window on the secondary monitor. The bundles it runs
// from are built once by the global setup (tests/e2e/support/global-setup.ts).
import { defineConfig } from "@playwright/test";

const ci = process.env.CI !== undefined;

export default defineConfig({
  testDir: "tests/e2e/specs",
  outputDir: "_build/e2e/test-results",
  globalSetup: "./tests/e2e/support/global-setup.ts",
  fullyParallel: true,
  forbidOnly: ci,
  retries: 0,
  // Two workers: each worker is a real program and the owner's PC stays usable.
  workers: 2,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "_build/e2e/report" }], ["json", { outputFile: "_build/e2e/report.json" }]],
  use: { actionTimeout: 15_000, navigationTimeout: 30_000 },
  projects: [{ name: "electron" }],
});
