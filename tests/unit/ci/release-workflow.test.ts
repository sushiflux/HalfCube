// The release part of .github/workflows/ci.yml cannot run here, so these tests read the workflow as text and hold it to the rules the
// release was hardened for: the write token lives in one job that runs no repository code, the build job is read-only, nothing is
// pasted into script text, one publish per channel at a time. The check script of the publish job is taken out of the workflow and run
// against sample release folders, so the checks that decide what goes public are tested as they will run.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { branding } from "../../../app/src/branding.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8").replace(/\r\n/g, "\n");

/** The lines of one job (from its key to the next job key), comments removed. */
function jobLines(name: string): string[] {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`job ${name} not found in ci.yml`);
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}[A-Za-z][\w-]*:\s*$/.test(line)) break;
    if (!line.trimStart().startsWith("#")) out.push(line);
  }
  return out;
}

interface RunStep {
  name: string;
  /** The script text, dedented. */
  body: string;
}

/** Every `run:` of a job with the name of its step. */
function runSteps(lines: string[]): RunStep[] {
  const steps: RunStep[] = [];
  let name = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const nameMatch = /^ {6}- name: (.+)$/.exec(line);
    if (nameMatch?.[1] !== undefined) name = nameMatch[1];
    const block = /^(\s*)run: \|\s*$/.exec(line);
    if (block) {
      const indent = (block[1] ?? "").length;
      const body: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j] ?? "";
        if (next.trim() !== "" && next.length - next.trimStart().length <= indent) break;
        body.push(next.slice(indent + 2));
        i = j;
      }
      steps.push({ name, body: body.join("\n") });
      continue;
    }
    const inline = /^\s*run: (.+)$/.exec(line);
    if (inline?.[1] !== undefined) steps.push({ name, body: inline[1] });
  }
  return steps;
}

describe("the release jobs of ci.yml", () => {
  const build = jobLines("release-build");
  const publish = jobLines("release-publish");
  const all = workflow.split("\n").filter((l) => !l.trimStart().startsWith("#"));

  it("only the publish job has the write permission, the build job is read-only", () => {
    expect(all.filter((l) => /contents:\s*write/.test(l))).toHaveLength(1);
    expect(publish.some((l) => /^\s+contents: write\s*$/.test(l))).toBe(true);
    expect(build.some((l) => /^\s+contents: read\s*$/.test(l))).toBe(true);
    expect(build.some((l) => /contents:\s*write/.test(l))).toBe(false);
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
  });

  it("the build job runs no gh release command and holds no token for it", () => {
    const text = build.join("\n");
    expect(text).not.toMatch(/gh release|GH_TOKEN/);
    expect(text).toContain("scripts/build-installer.ps1");
  });

  it("the publish job runs no code of the repository: no checkout, no npm, no node, no project script", () => {
    const text = publish.join("\n");
    expect(text).not.toMatch(/actions\/checkout|setup-node|setup-dotnet|\bnpm\b|\bnpx\b|\.ps1|scripts\//);
    for (const step of runSteps(publish)) {
      // the one node call is the inline check script (stdin), never a file of the repository
      const shell = step.body.replace(/node - <<'JS'\n[\s\S]*\nJS(\n|$)/, "node - <<'JS'\n");
      for (const m of shell.matchAll(/\bnode\b[^\n]*/g)) expect(m[0]).toMatch(/^node - <<'JS'$/);
    }
  });

  it("the publish job only takes the two artifacts of the build job and the token sits in the one step that needs it", () => {
    const text = publish.join("\n");
    expect([...text.matchAll(/name: (release-files|release-text)\b/g)].map((m) => m[1])).toEqual(["release-files", "release-text"]);
    expect([...build.join("\n").matchAll(/^\s+name: (release-[a-z]+)$/gm)].map((m) => m[1])).toEqual(["release-files", "release-text"]);
    expect(text.match(/\$\{\{ github\.token \}\}/g)).toHaveLength(1);
    expect(text.match(/GH_TOKEN/g)?.length).toBeGreaterThan(0);
  });

  it("one publish per channel at a time, the running one is never cancelled", () => {
    const text = publish.join("\n");
    expect(text).toMatch(/concurrency:\n\s+group: release-publish-\$\{\{[^}]*'-nightly'[^}]*'-beta'[^}]*\}\}\n\s+cancel-in-progress: false/);
  });

  it("no ${{ }} expression is pasted into script text of the release jobs (values go through env)", () => {
    for (const step of [...runSteps(build), ...runSteps(publish)]) {
      expect(step.body, `step "${step.name}"`).not.toContain("${{");
    }
  });

  it("the platforms output reaches the notice step through env", () => {
    const step = runSteps(build).find((s) => s.name.startsWith("No Windows desktop target"));
    expect(step?.body).toContain("$PLATFORMS");
    expect(build.join("\n")).toMatch(/PLATFORMS: \$\{\{ steps\.info\.outputs\.platforms \}\}/);
  });

  it("the feed is checked before the release exists, after publishing only its reachability", () => {
    const names = runSteps(publish).map((s) => s.name);
    const check = names.findIndex((n) => n.startsWith("Check the release files"));
    const create = names.findIndex((n) => n.startsWith("Publish the GitHub release"));
    const reach = names.findIndex((n) => n.includes("reachable"));
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(create);
    expect(create).toBeLessThan(reach);
    const publishStep = runSteps(publish)[create]?.body ?? "";
    expect(publishStep.indexOf("gh release create")).toBeLessThan(publishStep.indexOf("gh release edit"));
    const reachStep = runSteps(publish)[reach]?.body ?? "";
    expect(reachStep).toContain("curl -fsSL -o /dev/null");
  });
});

describe("the mapping from tag to Velopack version matches build-installer.ps1", () => {
  it("the script builds the same versions the check script expects", () => {
    const ps1 = readFileSync(join(repoRoot, "scripts", "build-installer.ps1"), "utf8");
    expect(ps1).toContain('\'release\' { $core }');
    expect(ps1).toContain('\'beta\' { "$core-beta.$vPrompts.$vLines" }');
    expect(ps1).toContain('\'nightly\' { "$core-alpha.$vPrompts.$vLines" }');
    expect(ps1).toContain('$finalName = "$productName-Setup-$fileId$fileSuffix.exe"');
    expect(ps1).toContain("branding\\branding.json");
    expect(ps1).toContain('$vpkFullName = "$PackId-$packVersion-$Channel-full.nupkg"');
  });
});

// The publish job runs no repository code, so it cannot read branding/branding.json; its file names and package id are literals
// in ci.yml. This holds them to the product name, so a rename cannot leave the release check expecting the old names.
describe("the release check in ci.yml names the product like branding.json", () => {
  it("expects the setup and the Velopack package under the product name", () => {
    const check = runSteps(jobLines("release-publish")).find((s) => s.name.startsWith("Check the release files"))?.body ?? "";
    expect(check).toContain("const setupName = `" + branding.name + "-Setup-${TAG}.exe`;");
    expect(check).toContain("const want = `" + branding.name + "-${pack}-${channel}-${String(a.Type).toLowerCase()}.nupkg`;");
    expect(check).toContain('a.PackageId !== "' + branding.name + '"');
  });
});

// ---------------------------------------------------------------- the check script, run against sample release folders

function checkScript(): string {
  const step = runSteps(jobLines("release-publish")).find((s) => s.name.startsWith("Check the release files"));
  if (!step) throw new Error("check step not found");
  const lines = step.body.split("\n");
  const start = lines.findIndex((l) => l === "node - <<'JS'");
  const end = lines.lastIndexOf("JS");
  if (start < 0 || end < start) throw new Error("check script not found in the step");
  return lines.slice(start + 1, end).join("\n");
}

let root: string;
let counter = 0;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "release-workflow-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Sample {
  dir: string;
  tag: string;
  channel: string;
  pack: string;
  full: string;
  delta: string;
  setup: string;
  feedName: string;
}

/** A release folder the way build-installer.ps1 -Ci leaves it: setup, full package, delta, slim feed, build-result.json. */
function sample(tag: string, withDelta = true): Sample {
  const dir = join(root, `rel-${counter++}`);
  mkdirSync(dir);
  const pre = /^v(\d+)\.(\d+)\.(\d+)\.(\d+)\.(\d+)-(nightly|beta)$/.exec(tag);
  const rel = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  const channel = pre ? (pre[6] as string) : "release";
  const pack = pre
    ? `${pre[1]}.${pre[2]}.${pre[3]}-${channel === "nightly" ? "alpha" : "beta"}.${pre[4]}.${pre[5]}`
    : `${rel?.[1]}.${rel?.[2]}.${rel?.[3]}`;
  const full = `HalfCube-${pack}-${channel}-full.nupkg`;
  const delta = `HalfCube-${pack}-${channel}-delta.nupkg`;
  const setup = `HalfCube-Setup-${tag}.exe`;
  const feedName = `releases.${channel}.json`;
  const files: Record<string, string> = { [full]: "full package bytes", [setup]: "setup bytes" };
  if (withDelta) files[delta] = "delta package bytes";
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  const asset = (name: string, type: string) => ({
    PackageId: "HalfCube",
    Version: pack,
    Type: type,
    FileName: name,
    SHA1: "AA",
    SHA256: createHash("sha256").update(files[name] ?? "").digest("hex").toUpperCase(),
    Size: Buffer.byteLength(files[name] ?? ""),
    NotesMarkdown: "",
    NotesHTML: "",
  });
  const assets = [asset(full, "Full"), ...(withDelta ? [asset(delta, "Delta")] : [])];
  writeFileSync(join(dir, feedName), JSON.stringify({ Assets: assets }));
  writeFileSync(join(dir, "build-result.json"), JSON.stringify({ id: "x", channel, displayVersion: "x", packVersion: pack, setup, files: [] }));
  return { dir, tag, channel, pack, full, delta, setup, feedName };
}

function check(s: Sample, overrides: { tag?: string; claimed?: string } = {}) {
  const r = spawnSync(process.execPath, ["-"], {
    input: checkScript(),
    encoding: "utf8",
    env: { ...process.env, TAG: overrides.tag ?? s.tag, FILES_DIR: s.dir, CLAIMED_CHANNEL: overrides.claimed ?? s.channel },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

type FeedAsset = { Type: string; FileName: string; Version: string; SHA256: string };
interface FeedJson {
  Assets: FeedAsset[];
}
interface BuildResultJson {
  packVersion: string;
  channel: string;
}

function editJson<T>(file: string, edit: (json: T) => void) {
  const json = JSON.parse(readFileSync(file, "utf8")) as T;
  edit(json);
  writeFileSync(file, JSON.stringify(json));
}

describe("the check script of the publish job", () => {
  const nightly = "v2026.11.14.3.120-nightly";

  it("accepts the files of a nightly with a delta, of a beta without a delta and of a release", () => {
    expect(check(sample(nightly)).status).toBe(0);
    expect(check(sample("v2026.11.14.3.120-beta", false)).status).toBe(0);
    const r = check(sample("v2026.11.14"));
    expect(r.out).toContain("(release, Velopack 2026.11.14)");
    expect(r.status).toBe(0);
  });

  it("refuses a feed that names another version than the tag", () => {
    const s = sample(nightly);
    editJson<FeedJson>(join(s.dir, s.feedName), (j) => {
      for (const a of j.Assets) a.Version = "2026.11.9-alpha.2.200";
    });
    const r = check(s);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`the tag means "${s.pack}"`);
    expect(r.out).toContain("Nothing was published.");
  });

  it("refuses a feed without a full package, with two, or with an unknown asset type", () => {
    const none = sample(nightly);
    editJson<FeedJson>(join(none.dir, none.feedName), (j) => {
      j.Assets = j.Assets.filter((a) => a.Type !== "Full");
    });
    expect(check(none).out).toContain("must list exactly one full package, it lists 0");
    const twice = sample(nightly);
    editJson<FeedJson>(join(twice.dir, twice.feedName), (j) => {
      j.Assets.push({ ...(j.Assets[0] as FeedAsset) });
    });
    expect(check(twice).out).toContain("it lists 2");
    const odd = sample(nightly);
    editJson<FeedJson>(join(odd.dir, odd.feedName), (j) => {
      (j.Assets[1] as FeedAsset).Type = "Patch";
    });
    expect(check(odd).out).toContain("neither Full nor Delta");
  });

  it("refuses file names that do not match the feed and files the feed does not know", () => {
    const wrongName = sample(nightly);
    editJson<FeedJson>(join(wrongName.dir, wrongName.feedName), (j) => {
      (j.Assets[0] as FeedAsset).FileName = "HalfCube-other-full.nupkg";
    });
    const r = check(wrongName);
    expect(r.status).toBe(1);
    expect(r.out).toContain("file name does not match");
    expect(r.out).toContain("is not among the uploaded assets");
    const extra = sample(nightly);
    writeFileSync(join(extra.dir, "evil.dll"), "x");
    expect(check(extra).out).toContain("evil.dll is not expected in the release files");
    const missing = sample(nightly);
    rmSync(join(missing.dir, missing.delta));
    expect(check(missing).out).toContain(`${missing.delta}: the file is not among the uploaded assets`);
    const noSetup = sample(nightly);
    rmSync(join(noSetup.dir, noSetup.setup));
    expect(check(noSetup).out).toContain(`${noSetup.setup} is missing from the release files`);
  });

  it("refuses a package that was changed after the feed was written (size and hash)", () => {
    const s = sample(nightly);
    writeFileSync(join(s.dir, s.full), "tampered package bytes");
    const r = check(s);
    expect(r.status).toBe(1);
    expect(r.out).toContain("the feed says");
    expect(r.out).toContain("SHA256");
  });

  it("compares the hash without regard to case", () => {
    const s = sample(nightly);
    editJson<FeedJson>(join(s.dir, s.feedName), (j) => {
      for (const a of j.Assets) a.SHA256 = String(a.SHA256).toLowerCase();
    });
    expect(check(s).status).toBe(0);
  });

  it("refuses a missing feed, a feed that is not JSON and a build-result that disagrees with the tag", () => {
    const noFeed = sample(nightly);
    rmSync(join(noFeed.dir, noFeed.feedName));
    expect(check(noFeed).out).toContain(`${noFeed.feedName} is missing or not valid JSON`);
    const broken = sample(nightly);
    writeFileSync(join(broken.dir, broken.feedName), "<html>");
    expect(check(broken).status).toBe(1);
    const result = sample(nightly);
    editJson<BuildResultJson>(join(result.dir, "build-result.json"), (j) => {
      j.packVersion = "2026.11.9-alpha.2.200";
      j.channel = "beta";
    });
    const r = check(result);
    expect(r.out).toContain("build-result.json: Velopack version");
    expect(r.out).toContain('build-result.json: channel "beta"');
  });

  it("refuses files of another tag, another channel than the tag means, and a folder inside the release files", () => {
    const s = sample(nightly);
    expect(check(s, { tag: "v2026.11.14.3.121-nightly" }).status).toBe(1);
    expect(check(s, { claimed: "release" }).out).toContain('The build job reports the channel "release"');
    mkdirSync(join(s.dir, "sub"));
    expect(check(s).out).toContain("sub in the release files is not a plain file");
    expect(check(s, { tag: "not-a-tag" }).out).toContain("is not a release tag");
  });
});
