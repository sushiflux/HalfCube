// Playwright globalSetup: builds the bundles the Electron program runs from (UI, harness page, main process) into
// _build/e2e before the first test. HALFCUBE_E2E_SKIP_BUILD=1 reuses the bundles of an earlier run.
import { prepare } from "./prepare.ts";

export default async function globalSetup(): Promise<void> {
  if (process.env.HALFCUBE_E2E_SKIP_BUILD === "1") return;
  await prepare();
}
