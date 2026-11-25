// Builds one version of the test app: stage the sources, install production dependencies, package Electron with
// @electron/packager, then create the Velopack release with vpk pack.
//
// Usage: node scripts/build.mjs <version> [--feed <dir>] [--vpk <path to vpk.exe>] [--velopack <npm version>]
//        [--stage <name>] [--extra "<vpk pack args>"]
// Output: <feed>/ (default _build/feed) holds the Setup.exe, the nupkg packages and releases.win.json. Packing a later
// version into the same folder is what makes vpk create the delta package.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const version = args[0];
if (!version) throw new Error("usage: node scripts/build.mjs <version> [--feed <dir>] [--vpk <vpk.exe>]");
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const feedDir = resolve(opt("feed", join(root, "_build", "feed")));
const vpk = resolve(opt("vpk", join(root, "_build", "tools", "vpk.exe")));
const extra = opt("extra", "").split(" ").filter(Boolean);
const velopackVersion = opt("velopack", undefined); // other npm version than the pinned one: installed without lock file
const stageName = opt("stage", version);
const packId = "PartcraftVelopackTest";

function run(cmd, cmdArgs, cwd) {
  console.log(`> ${cmd} ${cmdArgs.join(" ")}`);
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", shell: cmd.endsWith(".cmd"), env: { ...process.env, npm_config_loglevel: "error" } });
  if (r.status !== 0) throw new Error(`${cmd} failed with exit code ${r.status}`);
}

// 1. Stage the app sources with the requested version.
const stage = join(root, "_build", "stage", stageName);
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "assets"), { recursive: true });
for (const f of ["main.cjs", "window.html"]) cpSync(join(root, "app", f), join(stage, f));
if (!velopackVersion) cpSync(join(root, "app", "package-lock.json"), join(stage, "package-lock.json"));
cpSync(join(root, "assets", "partcraft-icon-512.png"), join(stage, "assets", "partcraft-icon-512.png"));
const pkg = JSON.parse(readFileSync(join(root, "app", "package.json"), "utf8"));
pkg.version = version;
if (velopackVersion) pkg.dependencies.velopack = velopackVersion;
writeFileSync(join(stage, "package.json"), JSON.stringify(pkg, null, 2));
run(process.platform === "win32" ? "npm.cmd" : "npm", [velopackVersion ? "install" : "ci", "--omit=dev", "--no-audit", "--no-fund"], stage);

// 2. Package Electron. The native Velopack module must stay outside the asar archive.
const pkgOut = join(root, "_build", "pkg", stageName);
rmSync(pkgOut, { recursive: true, force: true });
const outDirs = await packager({
  dir: stage,
  out: pkgOut,
  name: packId,
  platform: "win32",
  arch: "x64",
  icon: join(root, "assets", "partcraft.ico"),
  asar: { unpack: "**/*.node" },
  prune: true,
  overwrite: true,
  appCopyright: "SushiFlux",
  win32metadata: { CompanyName: "SushiFlux", FileDescription: "Partcraft Velopack test application", ProductName: packId },
});
const packDir = outDirs[0];
console.log(`packaged: ${packDir}`);

// 3. Velopack release.
mkdirSync(feedDir, { recursive: true });
run(vpk, [
  "pack", "--skip-updates",
  "--packId", packId,
  "--packVersion", version,
  "--packDir", packDir,
  "--mainExe", `${packId}.exe`,
  "--packTitle", "Partcraft Velopack Test",
  "--packAuthors", "SushiFlux",
  "--icon", join(root, "assets", "partcraft.ico"),
  "--splashImage", join(root, "assets", "partcraft-icon-512.png"),
  "--runtime", "win-x64",
  "--outputDir", feedDir,
  ...extra,
], root);

for (const f of readdirSync(feedDir)) console.log(`  ${f}  ${statSync(join(feedDir, f)).size} bytes`);
