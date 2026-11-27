// Shared helper: starts the Electron runtime of the repository with a hidden window and waits for it.
// The runtime comes from HALFCUBE_ELECTRON_EXE or from the repository's own node_modules. The child gets its own
// temporary user data folder, never shows a window and is ended (with its child processes) when it hangs.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// The slug of the product (branding/branding.json) names the temporary folders.
const { slug } = JSON.parse(readFileSync(resolve(here, "..", "..", "branding", "branding.json"), "utf8"));

/** Finds the Electron binary of the repository (or the one named in HALFCUBE_ELECTRON_EXE). */
export function findElectron() {
  const fromEnv = process.env.HALFCUBE_ELECTRON_EXE;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`HALFCUBE_ELECTRON_EXE zeigt auf keine Datei: ${fromEnv}`);
    return resolve(fromEnv);
  }
  let name = "electron";
  if (process.platform === "win32") name = "electron.exe";
  else if (process.platform === "darwin") name = "Electron.app/Contents/MacOS/Electron";
  const candidate = resolve(here, "..", "..", "node_modules", "electron", "dist", name);
  if (!existsSync(candidate)) {
    throw new Error(
      `Die Electron-Laufzeit fehlt (${candidate}). Im Hauptordner "npm install" ausführen oder HALFCUBE_ELECTRON_EXE setzen.`,
    );
  }
  return candidate;
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else process.kill(pid, "SIGKILL");
}

/**
 * Runs `electron <script> <job.json>` with the job object written to a temporary file.
 * Resolves with the stdout text; rejects with the error output when the exit code is not 0.
 */
export async function runElectronJob(script, job, timeoutMs = 300_000) {
  const work = mkdtempSync(join(tmpdir(), `${slug}-docs-`));
  const jobFile = join(work, "job.json");
  writeFileSync(jobFile, JSON.stringify({ ...job, userData: join(work, "user-data") }));
  try {
    return await new Promise((resolvePromise, reject) => {
      const env = {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: "0",
        HALFCUBE_JOB_SCRIPT: resolve(script),
        HALFCUBE_JOB_FILE: jobFile,
      };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(findElectron(), ["--disable-gpu", join(here, "bootstrap.cjs")], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env,
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr.on("data", (chunk) => {
        err += chunk;
      });
      const timer = setTimeout(() => {
        killTree(child.pid);
        reject(new Error(`Electron hat nach ${timeoutMs / 1000} s nicht geantwortet und wurde beendet.\n${err}`));
      }, timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          if (process.env.DOCS_PDF_DEBUG) process.stderr.write(err);
          resolvePromise(out);
        }
        else reject(new Error(`Electron endete mit Code ${code}.\n${err || out}`));
      });
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
