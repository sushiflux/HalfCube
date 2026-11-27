// Runs the end-to-end suite against the real desktop program (Electron, native engine), natively on this PC.
//
//   npm run test:e2e                      builds the bundles once (global setup), then runs every spec
//   npm run test:e2e -- welcome           further arguments go to `playwright test`
//
// Environment: HALFCUBE_E2E_SKIP_BUILD=1 reuses the bundles in _build/e2e of an earlier run.
// The program's windows open inactive on the secondary monitor (tests/e2e/support/electron-app.ts); nothing takes the focus.
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(root, "node_modules", "@playwright", "test", "cli.js");

const child = spawn(process.execPath, [cli, "test", ...process.argv.slice(2)], { cwd: root, env: process.env, stdio: "inherit" });
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
