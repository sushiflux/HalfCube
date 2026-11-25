// Launches the real Electron program (the build in _build/e2e/desktop) for a test: never visible or focused
// (PARTCRAFT_WINDOW=inactive), with its own empty user data folder, a first-start file, and a check that no engine process
// is left behind when it is closed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, type ElectronApplication, type Page } from "@playwright/test";
import { desktopDir, repoRoot } from "./paths.ts";

export interface ElectronOptions {
  /** Language the first-start file hands to the program (what the installer would write). */
  language?: "de" | "en";
  colorMode?: "light" | "dark";
  /** Extra environment for this launch. */
  env?: Record<string, string>;
}

export interface LaunchedElectron {
  app: ElectronApplication;
  page: Page;
  /** Process id of Electron's main process (the parent of the engine process). */
  pid: number;
  userData: string;
  /** Console errors and uncaught page errors since the launch. */
  errors: string[];
  /** Closes the program, removes its folder, and throws when an engine process of it survived. */
  close(): Promise<void>;
}

/** The engine program the Electron host starts: the release build if there is one, otherwise the testing build. */
export function engineExecutable(): string {
  const build = join(repoRoot, "engine", "_build");
  const candidates = [join(build, "windows-release", "bin", "partcraft-engine.exe"), join(build, "windows-release-testing", "bin", "partcraft-engine.exe")];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`No native engine found. Build it with engine/scripts/build-windows.ps1. Looked for: ${candidates.join("; ")}`);
  return found;
}

/** PIDs of partcraft-engine.exe processes whose parent is `parentPid` (Windows). */
export function engineChildren(parentPid: number): number[] {
  if (process.platform !== "win32") return [];
  const script = `Get-CimInstance Win32_Process -Filter "Name='partcraft-engine.exe' AND ParentProcessId=${parentPid}" | ForEach-Object { $_.ProcessId }`;
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`Could not list engine processes: ${r.stderr}`);
  return r.stdout.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

export function processAlive(pid: number): boolean {
  if (process.platform !== "win32") return false;
  const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { encoding: "utf8" });
  return r.stdout.includes(`"${pid}"`);
}

export async function launchElectron(options: ElectronOptions = {}): Promise<LaunchedElectron> {
  const mainFile = join(desktopDir, "main.cjs");
  if (!existsSync(mainFile)) throw new Error(`${mainFile} does not exist; the desktop bundle was not built (tests/e2e/support/prepare.ts).`);
  const electronExe = createRequire(import.meta.url)("electron") as string;

  const userData = mkdtempSync(join(tmpdir(), "partcraft-e2e-"));
  const choices = join(userData, "setup-choices.json");
  writeFileSync(choices, JSON.stringify({ version: 1, language: options.language ?? "en", colorMode: options.colorMode ?? "light" }));

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PARTCRAFT_DEV_URL;
  Object.assign(env, {
    PARTCRAFT_WINDOW: "inactive",
    PARTCRAFT_USER_DATA: join(userData, "data"),
    PARTCRAFT_ENGINE_EXE: engineExecutable(),
    PARTCRAFT_SETUP_CHOICES_FILE: choices,
    ...options.env,
  });

  const app = await _electron.launch({ executablePath: electronExe, args: [mainFile], env, timeout: 60_000 });
  // app.process() is the process Playwright started; the main process (parent of the engine) is what the program reports.
  const launcherPid = app.process().pid;
  const pid = await app.evaluate(() => process.pid);
  const page = await app.firstWindow({ timeout: 60_000 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  await page.waitForLoadState("domcontentloaded");

  return {
    app,
    page,
    pid,
    userData,
    errors,
    async close() {
      const engines = engineChildren(pid);
      await app.close().catch(() => undefined);
      const survivors: number[] = [];
      for (const enginePid of engines) {
        // The engine ends with its host; give the operating system a moment to finish the process.
        const deadline = Date.now() + 5000;
        while (processAlive(enginePid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
        if (processAlive(enginePid)) {
          survivors.push(enginePid);
          spawnSync("taskkill", ["/PID", String(enginePid), "/T", "/F"]);
        }
      }
      for (const p of [pid, launcherPid]) {
        if (p !== undefined && processAlive(p)) spawnSync("taskkill", ["/PID", String(p), "/T", "/F"]);
      }
      rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      if (survivors.length > 0) throw new Error(`Engine process(es) ${survivors.join(", ")} survived the end of the program (parent ${pid}); killed by the test.`);
    },
  };
}
