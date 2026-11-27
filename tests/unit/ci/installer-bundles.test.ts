// _build\web and _build\desktop are shared with scripts\dev.ps1. The installer script must look at what the bundles carry (the build id
// and channel baked into them), not at a note it wrote itself. These tests run a copy of the script in a throw-away project folder with
// fake dotnet and npm: the fake npm writes bundles the way the bundler bakes them (HALFCUBE_CHANNEL and the id), so nothing of the real
// _build folder is touched. The script stops at the missing engine, which is the proof that it got past the bundle step. Windows only
// (PowerShell 5.1).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ID = "v2026.11.14.3.120";
const repo = join(import.meta.dirname, "..", "..", "..");
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "installer-bundles-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// What the real bundlers bake: the web bundle is minified (template literals), the desktop bundle is readable JSON.
const fakeNpm = `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(join(process.cwd(), "npm-calls.txt"), args.join(" ") + "\\n");
const id = process.env.HALFCUBE_VERSION_ID || readFileSync("version.txt", "utf8").split("\\n")[1].trim();
const channel = process.env.FAKE_BUNDLE_CHANNEL || process.env.HALFCUBE_CHANNEL;
if (args[1] === "build:web") {
  mkdirSync("_build/web/assets", { recursive: true });
  writeFileSync("_build/web/index.html", "<html></html>");
  writeFileSync("_build/web/assets/version-x.js", "function r(){return n({id:\`" + id + "\`,channel:\`" + channel + "\`})}export{r as t};");
}
if (args[1] === "build:desktop") {
  mkdirSync("_build/desktop", { recursive: true });
  writeFileSync("_build/desktop/main.cjs", 'describeVersion({\\n\\t"id": "' + id + '",\\n\\t"channel": "' + channel + '"\\n});');
  writeFileSync("_build/desktop/preload.cjs", "// preload");
}
`;

function project(label: string): string {
  const root = join(dir, `proj-${label}`);
  for (const d of ["scripts/ci", "app/src/dev", "node_modules/electron", "node_modules/@electron/packager/bin", "fakes"]) mkdirSync(join(root, d), { recursive: true });
  mkdirSync(join(root, "branding"), { recursive: true });
  for (const f of ["scripts/build-installer.ps1", "scripts/ci/release.ts", "scripts/ci/release-lib.ts", "app/src/version.ts", "app/src/dev/look.ts", "branding/branding.json"]) copyFileSync(join(repo, f), join(root, f));
  writeFileSync(join(root, "version.txt"), `v2026.11.14\n${ID}\n`);
  writeFileSync(join(root, "node_modules/electron/package.json"), '{"version":"1.0.0"}');
  writeFileSync(join(root, "node_modules/@electron/packager/package.json"), '{"version":"20.3.0"}');
  writeFileSync(join(root, "node_modules/@electron/packager/bin/electron-packager.mjs"), "// fake packager");
  writeFileSync(join(root, "fakes/dotnet.cmd"), '@echo off\r\nif "%1"=="--version" echo 11.0.100\r\nexit /b 0\r\n');
  writeFileSync(join(root, "fakes/fake-npm.mjs"), fakeNpm);
  writeFileSync(join(root, "fakes/npm.cmd"), `@echo off\r\nnode "${join(root, "fakes", "fake-npm.mjs")}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  return root;
}

function build(root: string, args: string[], env: Record<string, string> = {}) {
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "build-installer.ps1"), "-OutDir", join(root, "out"), ...args], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, GITHUB_REF: "", [pathKey]: `${join(root, "fakes")};${process.env[pathKey] ?? ""}`, ...env },
    timeout: 90_000,
  });
  const log = join(root, "npm-calls.txt");
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean) : [];
  if (existsSync(log)) rmSync(log);
  return { status: r.status, text: `${r.stdout}\n${r.stderr}`, calls };
}

/** What dev.ps1 -Neubau leaves behind: bundles of the dev channel and the id of version.txt. */
function devBundles(root: string) {
  mkdirSync(join(root, "_build/web/assets"), { recursive: true });
  mkdirSync(join(root, "_build/desktop"), { recursive: true });
  writeFileSync(join(root, "_build/web/index.html"), "<html></html>");
  writeFileSync(join(root, "_build/web/assets/version-x.js"), `function r(){return n({id:\`${ID}\`,channel:\`dev\`})}export{r as t};`);
  writeFileSync(join(root, "_build/desktop/main.cjs"), `describeVersion({\n\t"id": "${ID}",\n\t"channel": "dev"\n});`);
  writeFileSync(join(root, "_build/desktop/preload.cjs"), "// preload");
}

describe.skipIf(process.platform !== "win32")("build-installer.ps1 checks the bundles in _build against this build", () => {
  it("rebuilds a dev bundle that another start left in _build before it builds a nightly", () => {
    const root = project("foreign");
    devBundles(root);
    const r = build(root, ["-Channel", "nightly"]);
    expect(r.text).toContain("passen nicht zu diesem Bau");
    expect(r.text).toContain(`${ID} / dev`);
    expect(r.calls).toEqual(["run build:web", "run build:desktop"]);
    expect(r.text).toContain("Engine nicht gefunden");
    expect(readFileSync(join(root, "_build/web/assets/version-x.js"), "utf8")).toContain("channel:`nightly`");
  }, 60_000);

  it("builds nothing again when the bundles carry this build and are up to date, and rebuilds for another build id", () => {
    const root = project("current");
    devBundles(root);
    expect(build(root, ["-Channel", "nightly"]).calls).toHaveLength(2);
    const again = build(root, ["-Channel", "nightly"]);
    expect(again.calls).toEqual([]);
    expect(again.text).not.toContain("passen nicht zu diesem Bau");
    expect(again.text).toContain("Engine nicht gefunden");
    const other = build(root, ["-Channel", "nightly", "-VersionId", "v2026.11.20.1.1"]);
    expect(other.calls).toEqual(["run build:web", "run build:desktop"]);
  }, 60_000);

  it("stops loudly when the bundles are still wrong after the build", () => {
    const root = project("stuck");
    devBundles(root);
    const r = build(root, ["-Channel", "nightly"], { FAKE_BUNDLE_CHANNEL: "dev" });
    expect(r.status).not.toBe(0);
    expect(r.text).toContain("web bundle");
    expect(r.text).toContain(`${ID} / dev`);
    expect(r.text).toContain("verify-bundles");
    expect(r.text).not.toContain("Engine nicht gefunden");
  }, 60_000);

  it("a CI build always rebuilds the bundles", () => {
    const root = project("ci");
    devBundles(root);
    const notesFile = join(root, "notes.md");
    writeFileSync(notesFile, "# Nightly Changelog\n");
    const args = ["-Ci", "-Channel", "nightly", "-ReleaseNotes", notesFile];
    expect(build(root, args).calls).toEqual(["run build:web", "run build:desktop"]);
    expect(build(root, args).calls).toEqual(["run build:web", "run build:desktop"]);
  }, 60_000);
});

describe("build-installer.ps1 runs the packager from node_modules", () => {
  it("no npx, no version resolved at build time; the packager is pinned exactly in package.json", () => {
    const ps1 = readFileSync(join(repo, "scripts", "build-installer.ps1"), "utf8");
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
    expect(ps1).not.toMatch(/npx\.cmd|'--yes'|@electron\/packager@/);
    expect(ps1).toContain("node_modules\\@electron\\packager\\bin\\electron-packager.mjs");
    expect(pkg.devDependencies["@electron/packager"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
