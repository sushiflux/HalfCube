// Where the Electron main process finds the native engine, the folder of the Chromium session data, and the file the
// installer writes for the first start. Pure functions of their inputs, so they are tested without Electron.
//
// ENGINE LAYOUT IN THE INSTALLED PROGRAM (contract with the installer script):
//   <install folder>\current\resources\engine\halfcube-engine.exe
//   <install folder>\current\resources\engine\*.dll          the OCCT libraries (TK*.dll) from the same build folder
//   <install folder>\current\resources\engine\licenses\      licence texts that belong to the engine (if the build has any)
// i.e. everything in engine\_build\windows-release\bin\ (the executable and the DLLs next to it; leave out
// halfcube-engine-tests.exe) goes flat into resources\engine\. The engine is looked up at
// process.resourcesPath + "\engine" and never anywhere else when the program is packaged: no environment variable can
// redirect it. Other platforms use the same folder with the executable name "halfcube-engine" (no .exe).
//
// IN DEVELOPMENT (program not packaged), in this order:
//   1. HALFCUBE_ENGINE_EXE (full path), for tests and for trying another build
//   2. engine\_build\windows-release\bin\halfcube-engine.exe
//   3. engine\_build\windows-release-testing\bin\halfcube-engine.exe (has diagnostics.crash and diagnostics.hang)
import { join, resolve } from "node:path";
import { NATIVE_EXECUTABLE } from "../../app/src/engine/generated/protocol.ts";

export interface EnginePathInput {
  packaged: boolean;
  /** process.resourcesPath of the running program. */
  resourcesPath: string;
  /** The repository root (two folders above the built main.cjs). Only used when not packaged. */
  repoRoot: string;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  /** Whether a file exists; injected so tests need no real files. */
  exists: (path: string) => boolean;
}

export type EnginePathResult = { ok: true; exe: string; source: string } | { ok: false; message: string; details: string };

export function executableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? `${NATIVE_EXECUTABLE}.exe` : NATIVE_EXECUTABLE;
}

export function resolveEngineExecutable(input: EnginePathInput): EnginePathResult {
  const name = executableName(input.platform);
  const candidates: { path: string; source: string }[] = [];
  if (input.packaged) {
    candidates.push({ path: join(input.resourcesPath, "engine", name), source: "installed program" });
  } else {
    const override = input.env.HALFCUBE_ENGINE_EXE;
    if (override) candidates.push({ path: resolve(override), source: "HALFCUBE_ENGINE_EXE" });
    else {
      const build = join(input.repoRoot, "engine", "_build");
      candidates.push(
        { path: join(build, "windows-release", "bin", name), source: "release build" },
        { path: join(build, "windows-release-testing", "bin", name), source: "testing build (release build not found)" },
      );
    }
  }
  for (const c of candidates) if (input.exists(c.path)) return { ok: true, exe: c.path, source: c.source };
  return {
    ok: false,
    message: input.packaged
      ? `The engine program is missing from the installation (expected at ${candidates[0]?.path}). Reinstall HalfCube.`
      : `The engine program was not found. Build it with engine/scripts/build-windows.ps1 or set HALFCUBE_ENGINE_EXE.`,
    details: `Looked for: ${candidates.map((c) => c.path).join("; ")}`,
  };
}

/**
 * Folder for Chromium's caches and other session data. On Windows the local application data folder, so nothing of it
 * lands in the roaming profile and the uninstaller removes it with the program (Velopack deletes
 * %LOCALAPPDATA%\<product>). Returns null when the default (inside userData) should stay: other platforms, programs
 * that are not packaged, and runs with their own HALFCUBE_USER_DATA folder (tests).
 */
export function sessionDataDir(input: {
  packaged: boolean;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  productName: string;
}): string | null {
  if (!input.packaged || input.platform !== "win32" || input.env.HALFCUBE_USER_DATA) return null;
  const local = input.env.LOCALAPPDATA;
  if (!local) return null;
  return join(local, input.productName, "session");
}

/** Path of the installer's first-start file: %APPDATA%\<product>\setup-choices.json (the roaming folder). */
export function setupChoicesPath(input: {
  appData: string;
  productName: string;
  packaged: boolean;
  env: Readonly<Record<string, string | undefined>>;
}): string {
  // Only an unpackaged program (development, tests) may read the file from somewhere else.
  const override = !input.packaged ? input.env.HALFCUBE_SETUP_CHOICES_FILE : undefined;
  return override ? resolve(override) : join(input.appData, input.productName, "setup-choices.json");
}
