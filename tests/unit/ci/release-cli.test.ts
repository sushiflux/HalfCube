// scripts/ci/release.ts end to end in a throw-away git repository: the commands the release job runs, as the job runs them.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const cli = join(repoRoot, "scripts", "ci", "release.ts");
const ID = "v2026.11.14.3.120";
let dir: string;

function git(...args: string[]) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}
function release(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [cli, ...args, "--root", dir], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "", ...env } });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "release-cli-"));
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  writeFileSync(join(dir, "version.txt"), `v2026.11.14\n${ID}\n`);
  copyFileSync(join(repoRoot, "tests", "fixtures", "changelog", "nightly.md"), join(dir, "CHANGELOG.nightly.md"));
  git("add", ".");
  git("commit", "-q", "-m", "x");
  git("tag", "-a", `${ID}-nightly`, "-m", "Nightly", "-m", "platform: windows-desktop");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("scripts/ci/release.ts", () => {
  it("info: channel, readable title from the one formatter, pre-release flag, platform decision", () => {
    const out = join(dir, "gh-output");
    const r = release(["info", "--tag", `${ID}-nightly`], { GITHUB_OUTPUT: out });
    expect(r.status).toBe(0);
    const lines = readFileSync(out, "utf8").trim().split("\n");
    expect(lines).toContain("channel=nightly");
    expect(lines).toContain(`id=${ID}`);
    expect(lines).toContain(`title=${ID} (α)`);
    expect(lines).toContain("prerelease=true");
    expect(lines).toContain("changelog=CHANGELOG.nightly.md");
    expect(lines).toContain("windows=true");
    expect(lines).toContain("platforms=windows-desktop");
  });

  it("info: a tag for another platform builds no Windows package", () => {
    git("tag", "-a", "v2026.11.14.3.120-beta", "-m", "Beta", "-m", "platform: unraid");
    const r = release(["info", "--tag", "v2026.11.14.3.120-beta"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("windows=false");
    expect(r.out).toContain("prerelease=true");
  });

  it("info: refuses a tag that carries another version than its commit", () => {
    git("tag", "-a", "v2026.11.14.3.999-nightly", "-m", "Nightly");
    const r = release(["info", "--tag", "v2026.11.14.3.999-nightly"]);
    expect(r.status).toBe(1);
    expect(r.err).toContain("must carry the version of its own commit");
  });

  it("body and excerpt: one entry for the release, the frame with all entries for Velopack", () => {
    const body = join(dir, "out", "body.md");
    const notes = join(dir, "out", "notes.md");
    expect(release(["body", "--tag", `${ID}-nightly`, "--out", body]).status).toBe(0);
    expect(release(["excerpt", "--tag", `${ID}-nightly`, "--out", notes]).status).toBe(0);
    expect(readFileSync(body, "utf8")).toContain(`## ${ID} (α) · Windows`);
    expect(readFileSync(body, "utf8")).not.toContain("v2026.11.13.2.80");
    const excerpt = readFileSync(notes, "utf8");
    expect(excerpt.startsWith("# Nightly Changelog (α)")).toBe(true);
    expect(excerpt).toContain("v2026.11.11.1.30");
  });

  it("excerpt: --max-length cuts between entries but keeps this version's entry; a bad value fails", () => {
    const notes = join(dir, "limited.md");
    const r = release(["excerpt", "--tag", `${ID}-nightly`, "--out", notes, "--max-length", "1"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("newest 2 entries per language");
    const text = readFileSync(notes, "utf8");
    expect(text).toContain(`## ${ID} (α) · Windows`);
    expect(text).not.toContain("v2026.11.13.2.80");
    expect(release(["excerpt", "--tag", `${ID}-nightly`, "--out", notes, "--max-length", "0"]).status).toBe(1);
  });

  it("body and excerpt: no entry heading gives the neutral text and one notice line, the excerpt still lists the newest entries", () => {
    writeFileSync(join(dir, "version.txt"), "v2026.11.15\nv2026.11.15.1.1\n");
    git("add", ".");
    git("commit", "-q", "-m", "y");
    git("tag", "-a", "v2026.11.15.1.1-nightly", "-m", "Nightly");
    const body = join(dir, "b.md");
    const r = release(["body", "--tag", "v2026.11.15.1.1-nightly", "--out", body]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("::notice::No customer entry for v2026.11.15.1.1 (α) in CHANGELOG.nightly.md. The release text is neutral.");
    expect(readFileSync(body, "utf8")).toBe("No user-visible changes.\n\n---\n\nKeine sichtbaren Änderungen.\n");
    const notes = join(dir, "n.md");
    expect(release(["excerpt", "--tag", "v2026.11.15.1.1-nightly", "--out", notes]).status).toBe(0);
    expect(readFileSync(notes, "utf8")).toContain("v2026.11.14.3.120");
  });

  it("body and excerpt: a channel without a changelog file yet gives the neutral text and the empty frame", () => {
    git("rm", "-q", "CHANGELOG.nightly.md");
    writeFileSync(join(dir, "version.txt"), "v2026.11.15\nv2026.11.15.1.1\n");
    git("add", ".");
    git("commit", "-q", "-m", "z");
    git("tag", "-a", "v2026.11.15.1.1-nightly", "-m", "Nightly");
    const body = join(dir, "b.md");
    const r = release(["body", "--tag", "v2026.11.15.1.1-nightly", "--out", body]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("does not exist yet");
    expect(readFileSync(body, "utf8")).toContain("No user-visible changes.");
    const notes = join(dir, "n.md");
    expect(release(["excerpt", "--tag", "v2026.11.15.1.1-nightly", "--out", notes]).status).toBe(0);
    expect(readFileSync(notes, "utf8")).toContain('<a name="english"></a>\n## English');
  });
});
