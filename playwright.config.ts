// End-to-end suite (Playwright). Run with `npm run test:e2e` (browser in the official Docker image) or
// `npm run test:e2e:local` (installed Chrome/Brave, a marked fallback); see tests/e2e/run.mjs.
//
// Two projects run the same specs: "browser" (the web build in Chromium) and "electron" (the real program). Files named
// *.browser.spec.ts run only in the first, *.electron.spec.ts only in the second.
import { defineConfig } from "@playwright/test";
import { browserMode, serverHost, serverPort, type Target } from "./tests/e2e/support/paths.ts";

const ci = process.env.CI !== undefined;

export default defineConfig<unknown, { target: Target }>({
  testDir: "tests/e2e/specs",
  outputDir: "_build/e2e/test-results",
  fullyParallel: true,
  forbidOnly: ci,
  retries: 0,
  // Two workers: each Electron worker is a real program and the owner's PC stays usable.
  workers: 2,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "_build/e2e/report" }], ["json", { outputFile: "_build/e2e/report.json" }]],
  metadata: { browserMode: browserMode() },
  use: { actionTimeout: 15_000, navigationTimeout: 30_000 },
  webServer: {
    command: "node tests/e2e/support/serve.ts",
    url: `http://127.0.0.1:${serverPort}/index.html`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
    env: { PARTCRAFT_E2E_HOST: serverHost },
  },
  projects: [
    { name: "browser", testIgnore: "**/*.electron.spec.ts", use: { target: "browser" } },
    { name: "electron", testIgnore: "**/*.browser.spec.ts", use: { target: "electron" } },
  ],
});
