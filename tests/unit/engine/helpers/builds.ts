// Where the engine builds live and whether they are there. A test that needs a missing build is skipped with the
// reason in its name, so a fresh checkout without engine builds still gets a green run.
import { existsSync } from "node:fs";
import { describe } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../../../../config/build-info.ts";

const exeName = process.platform === "win32" ? "partcraft-engine.exe" : "partcraft-engine";
const build = join(repoRoot, "engine", "_build");

/** Native engine built with test commands (diagnostics.crash, diagnostics.hang); override with PC_ENGINE_TESTING_EXE. */
export const nativeTestingExe = process.env.PC_ENGINE_TESTING_EXE ?? join(build, "windows-release-testing", "bin", exeName);
/** Native release engine; override with PC_ENGINE_RELEASE_EXE. */
export const nativeReleaseExe = process.env.PC_ENGINE_RELEASE_EXE ?? join(build, "windows-release", "bin", exeName);
/** WebAssembly engine with test commands; override with PC_ENGINE_WASM_TESTING_DIR. */
export const wasmTestingDir = process.env.PC_ENGINE_WASM_TESTING_DIR ?? join(build, "wasm-testing");
/** WebAssembly release engine; override with PC_ENGINE_WASM_DIR. */
export const wasmReleaseDir = process.env.PC_ENGINE_WASM_DIR ?? join(build, "wasm");

export const wasmModuleUrl = (dir: string): string => pathToFileURL(join(dir, "partcraft-engine.mjs")).href;

const wasmPresent = (dir: string) => existsSync(join(dir, "partcraft-engine.mjs")) && existsSync(join(dir, "partcraft-engine.wasm"));

/** Reason to skip when the build is missing, otherwise false (the shape describe(..., { skip }) wants). */
export const skipUnlessNativeTesting = process.platform !== "win32" || !existsSync(nativeTestingExe) ? `native testing build missing (${nativeTestingExe})` : false;
export const skipUnlessNativeRelease = process.platform !== "win32" || !existsSync(nativeReleaseExe) ? `native release build missing (${nativeReleaseExe})` : false;
export const skipUnlessWasmTesting = wasmPresent(wasmTestingDir) ? false : `WebAssembly testing build missing (${wasmTestingDir})`;
export const skipUnlessWasmRelease = wasmPresent(wasmReleaseDir) ? false : `WebAssembly release build missing (${wasmReleaseDir})`;

/**
 * describe() that is skipped, with the reason in its name, when a build is missing. Pass one of the skipUnless values.
 */
export function describeUnless(skip: string | false, name: string, body: () => void): void {
  const run = skip === false ? describe : describe.skip;
  run(`${name}${skip ? ` [skipped: ${skip}]` : ""}`, body);
}
