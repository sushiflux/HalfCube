// The pre-commit hook stamps the placeholder headings of the staged customer changelogs with the commit's readable version
// (scripts/git-hooks/pre-commit). Runs the real hook in a throw-away git repository, never in this one.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatVersion } from "../../../app/src/version.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
let dir: string;

function git(...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  // The hook can run inside another repository's hook (this test started from a commit): never inherit its variables
  for (const k of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_PREFIX", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) delete env[k];
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hook-test-"));
  mkdirSync(join(dir, "scripts", "git-hooks"), { recursive: true });
  copyFileSync(join(repoRoot, "scripts", "git-hooks", "pre-commit"), join(dir, "scripts", "git-hooks", "pre-commit"));
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  git("config", "core.hooksPath", "scripts/git-hooks");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The local calendar day, the way the hook's date '+%Y-%m-%d' writes it. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const frame = (title: string, enHeading: string, deHeading: string) =>
  `# ${title}\n\n**[English](#english) · [Deutsch](#deutsch)**\n\n---\n\n<a name="english"></a>\n## English\n\n${enHeading}\n\n- ✨ **New:** x\n\n---\n\n<a name="deutsch"></a>\n## Deutsch\n\n${deHeading}\n\n- ✨ **Neu:** x\n`;

describe("pre-commit hook: customer changelog headings", () => {
  it("stamps ## vNEXT α, β and the plain placeholder with the readable version and the date of the commit, in both languages", () => {
    writeFileSync(join(dir, "CHANGELOG.nightly.md"), frame("Nightly Changelog (α)", "## vNEXT α · Windows", "## vNEXT α · Windows"));
    writeFileSync(join(dir, "CHANGELOG.beta.md"), frame("Beta Changelog (β)", "## vNEXT β · Unraid", "## vNEXT β · Unraid"));
    writeFileSync(join(dir, "CHANGELOG.md"), frame("Changelog", "## vNEXT", "## vNEXT"));
    git("add", ".");
    // The day is read before and after the commit, so a commit across midnight cannot fail the test
    const before = today();
    git("commit", "-q", "-m", "first");
    const after = today();
    const day = before === after ? before : after;
    const id = readFileSync(join(dir, "version.txt"), "utf8").split("\n")[1] as string;
    expect(id).toMatch(/^v\d+\.\d+\.1\.1\.\d+$/);
    const committed = (file: string) => git("show", `HEAD:${file}`);
    const lines = (file: string) => committed(file).split("\n").filter((l) => l.startsWith("## v"));
    // The stamp equals the output of the project's one formatter, symbol and all; the date follows it, the platform part follows the date
    const stamped = (version: string, rest = "") => `## ${version} · ${day}${rest}`;
    const sameDay = (headings: string[], expected: string) => {
      const dayless = headings.map((h) => h.replace(/ · \d{4}-\d{2}-\d{2}/, " · DAY"));
      expect(dayless).toEqual([expected.replace(day, "DAY"), expected.replace(day, "DAY")]);
      for (const h of headings) expect([before, after]).toContain(/(\d{4}-\d{2}-\d{2})/.exec(h)?.[1]);
    };
    const nightly = lines("CHANGELOG.nightly.md");
    sameDay(nightly, stamped(formatVersion(id, "nightly"), " · Windows"));
    expect(committed("CHANGELOG.nightly.md")).not.toContain("vNEXT");
    sameDay(lines("CHANGELOG.beta.md"), stamped(formatVersion(id, "beta"), " · Unraid"));
    expect(committed("CHANGELOG.beta.md")).not.toContain("vNEXT");
    sameDay(lines("CHANGELOG.md"), stamped(id));
    expect(committed("CHANGELOG.md")).not.toContain("vNEXT");
  });

  it("leaves stamped entries alone and stamps only a changelog that is part of the commit", () => {
    writeFileSync(join(dir, "CHANGELOG.nightly.md"), frame("Nightly Changelog (α)", "## v2026.1.1.1.1 (α)", "## v2026.1.1.1.1 (α)"));
    writeFileSync(join(dir, "CHANGELOG.beta.md"), frame("Beta Changelog (β)", "## vNEXT β", "## vNEXT β"));
    git("add", "CHANGELOG.nightly.md");
    git("commit", "-q", "-m", "first");
    expect(git("show", "HEAD:CHANGELOG.nightly.md")).toContain("## v2026.1.1.1.1 (α)");
    // The beta file was not staged: the placeholder stays in the working tree
    expect(readFileSync(join(dir, "CHANGELOG.beta.md"), "utf8")).toContain("## vNEXT β");
  });
});
