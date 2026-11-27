// The parameter checks at the top of scripts/build-installer.ps1 (CI mode, -VersionId, -FeedDir, -PreviousFrom). They run before
// anything is built or created, so these tests start the real script and only look at its refusal. Windows only (PowerShell 5.1).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "..", "..", "..", "scripts", "build-installer.ps1");
let dir: string;
let notes: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "installer-params-"));
  notes = join(dir, "notes.md");
  writeFileSync(notes, "# Nightly Changelog\n");
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-OutDir", join(dir, "out"), ...args], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_REF: "", ...env },
    timeout: 60_000,
  });
  return { status: r.status, text: `${r.stdout}\n${r.stderr}` };
}

describe.skipIf(process.platform !== "win32")("build-installer.ps1 refuses wrong parameter combinations before building", () => {
  it("CI mode builds only nightly, beta and release and needs the release notes", () => {
    const dev = run(["-Ci", "-Channel", "dev", "-ReleaseNotes", notes]);
    expect(dev.status).not.toBe(0);
    expect(dev.text).toContain("-Ci baut nur die Kanaele nightly, beta und release.");
    const noNotes = run(["-Ci", "-Channel", "nightly"]);
    expect(noNotes.status).not.toBe(0);
    expect(noNotes.text).toContain("-Ci braucht -ReleaseNotes");
  });

  it("CI mode takes none of the local-only switches", () => {
    const r = run(["-Ci", "-Channel", "nightly", "-ReleaseNotes", notes, "-OhneEngine"]);
    expect(r.status).not.toBe(0);
    expect(r.text).toContain("-OhneEngine ist nur fuer lokale Tests");
  });

  it("-VersionId is rejected together with -Ci and in a CI tag build", () => {
    const ci = run(["-Ci", "-Channel", "nightly", "-ReleaseNotes", notes, "-VersionId", "v2026.11.20.1.1"]);
    expect(ci.status).not.toBe(0);
    expect(ci.text).toContain("-VersionId ist nur fuer lokale Tests");
    const tag = run(["-Channel", "nightly", "-VersionId", "v2026.11.20.1.1"], { GITHUB_REF: "refs/tags/v2026.11.12.13.557-nightly" });
    expect(tag.status).not.toBe(0);
    expect(tag.text).toContain("CI-Tag-Bau abgelehnt");
  });

  it("-VersionId must be a five-part id without leading zeros", () => {
    for (const bad of ["v2026.11", "2026.11.20.1.1", "v2026.011.20.1.1", "v2026.11.20.1.1-beta"]) {
      const r = run(["-VersionId", bad]);
      expect(r.status).not.toBe(0);
      expect(r.text).toContain("keine fuenfteilige Kennung");
    }
  });

  it("-FeedDir and -PreviousFrom exclude each other, -PreviousFrom needs a repository URL, -ReleaseNotes a file", () => {
    const both = run(["-FeedDir", join(dir, "feed"), "-PreviousFrom", "https://github.com/a/b"]);
    expect(both.status).not.toBe(0);
    expect(both.text).toContain("schliessen sich aus");
    const url = run(["-PreviousFrom", "github.com/a/b"]);
    expect(url.status).not.toBe(0);
    expect(url.text).toContain("https://github.com/<owner>/<repo>");
    const missing = run(["-ReleaseNotes", join(dir, "nope.md")]);
    expect(missing.status).not.toBe(0);
    expect(missing.text).toContain("Datei nicht gefunden");
  });
});

// The release job hands the script a GitHub token with write access for "vpk download". The npm builds, npx and the packager run
// third-party code, so none of them may inherit it. Fake dotnet and npm on PATH stop the script at its first build step; the fake npm
// writes what it sees of the token.
describe.skipIf(process.platform !== "win32")("build-installer.ps1 keeps the GitHub token away from the build tools", () => {
  it("the first npm build runs without GITHUB_TOKEN in its environment", () => {
    const fakes = join(dir, "fakes");
    mkdirSync(fakes, { recursive: true });
    const seen = join(dir, "npm-env.txt");
    writeFileSync(join(fakes, "dotnet.cmd"), "@echo off\r\nif \"%1\"==\"--version\" echo 11.0.100\r\nexit /b 0\r\n");
    writeFileSync(join(fakes, "npm.cmd"), `@echo off\r\n>"${seen}" echo token=[%GITHUB_TOKEN%]\r\nexit /b 7\r\n`);
    const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
    const r = run(["-Channel", "dev"], {
      [pathKey]: `${fakes};${process.env[pathKey] ?? ""}`,
      GITHUB_TOKEN: "ghs_fake_token_for_this_test",
    });
    expect(r.status).not.toBe(0);
    expect(r.text).toContain("Code 7");
    expect(readFileSync(seen, "utf8").trim()).toBe("token=[]");
    expect(r.text).not.toContain("ghs_fake_token_for_this_test");
  });
});
