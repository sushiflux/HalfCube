// Optional local proof of the Visual C++ runtime entry: when Visual Studio (or its Build Tools) is installed, the version
// of the runtime files that scripts/build-installer.ps1 copies must be the version pinned in the sources. Without Visual
// Studio (CI runners of other jobs, other systems) the proof is reported as not done, never silently skipped.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The runtime files the engine DLLs import (checked with the import tables of the built engine, not guessed). */
export const VC_RUNTIME_FILES = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "msvcp140_2.dll"];

export interface VcRuntimeCheck {
  /** null when nothing could be checked here. */
  problems: string[] | null;
  message: string;
}

function newestRedistFolder(): string | null {
  const vswhere = join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!existsSync(vswhere)) return null;
  const install = execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], {
    encoding: "utf8",
  }).trim();
  const redist = join(install, "VC", "Redist", "MSVC");
  if (!install || !existsSync(redist)) return null;
  const versions = readdirSync(redist)
    .filter((v) => /^\d/.test(v))
    .sort()
    .reverse();
  for (const version of versions) {
    const folder = join(redist, version, "x64", "Microsoft.VC143.CRT");
    if (existsSync(folder)) return folder;
  }
  return null;
}

export function checkVcRuntime(pinnedVersion: string): VcRuntimeCheck {
  if (process.platform !== "win32") return { problems: null, message: "Visual C++ runtime version not checked (not Windows)." };
  const folder = newestRedistFolder();
  if (!folder) return { problems: null, message: "Visual C++ runtime version not checked (no Visual Studio with the C++ tools found)." };
  const problems: string[] = [];
  for (const name of VC_RUNTIME_FILES) {
    const file = join(folder, name);
    if (!existsSync(file)) {
      problems.push(`vcrt: ${name} is not in ${folder}.`);
      continue;
    }
    const version = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${file.replaceAll("'", "''")}').VersionInfo.FileVersion`], { encoding: "utf8" }).trim();
    if (version !== pinnedVersion) {
      problems.push(`vcrt: ${name} in the installed Visual Studio is version ${version}, third_party/notices.sources.json pins ${pinnedVersion}. Update the pinned version and third_party/licenses/vcrt-notice.txt.`);
    }
  }
  return { problems, message: `Visual C++ runtime files checked against the installed Visual Studio (${VC_RUNTIME_FILES.length} files).` };
}
