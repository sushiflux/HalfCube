// The build id and channel baked into the bundles, read back by scripts/build-installer.ps1: the web and desktop bundles in _build are
// shared with the local dev start script, so an installer build must never pack a bundle of another build.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkBundleBuildInfo, readBakedBuildInfo } from "../../../scripts/ci/release-lib.ts";

const cli = join(import.meta.dirname, "..", "..", "..", "scripts", "ci", "release.ts");
const ID = "v2026.11.14.3.120";
let dir: string;
let counter = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bundle-info-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The two shapes the bundlers write: the minified web bundle (template literals) and the readable desktop bundle (JSON). */
const webSource = (id: string, channel: string) => `function r(){return n({id:\`${id}\`,channel:\`${channel}\`})}export{r as t};`;
const desktopSource = (id: string, channel: string) => `function currentVersion() {\n\treturn describeVersion({\n\t\t"id": "${id}",\n\t\t"channel": "${channel}"\n\t});\n}\n`;

function bundles(web: { id: string; channel: string }, desktop: { id: string; channel: string }) {
  const root = join(dir, `b${counter++}`);
  mkdirSync(join(root, "web", "assets"), { recursive: true });
  mkdirSync(join(root, "desktop"));
  writeFileSync(join(root, "web", "index.html"), "<html></html>");
  writeFileSync(join(root, "web", "assets", "version-abc.js"), webSource(web.id, web.channel));
  writeFileSync(join(root, "web", "assets", "other.js"), "export const x = 1;");
  writeFileSync(join(root, "desktop", "main.cjs"), desktopSource(desktop.id, desktop.channel));
  return { web: join(root, "web"), main: join(root, "desktop", "main.cjs") };
}

describe("readBakedBuildInfo", () => {
  it("reads the minified web shape and the readable desktop shape", () => {
    const b = bundles({ id: ID, channel: "nightly" }, { id: ID, channel: "nightly" });
    expect(readBakedBuildInfo(b.web)).toEqual([{ id: ID, channel: "nightly" }]);
    expect(readBakedBuildInfo(b.main)).toEqual([{ id: ID, channel: "nightly" }]);
  });

  it("reads single and double quotes and ignores other objects with an id", () => {
    const f = join(dir, "q.js");
    writeFileSync(f, `a({id:"v1.2.3.4.5",channel:'beta'});b({id:"x",channel:"dev"});c({id:"v1.2.3.4.5",name:"dev"})`);
    expect(readBakedBuildInfo(f)).toEqual([{ id: "v1.2.3.4.5", channel: "beta" }]);
  });
});

describe("checkBundleBuildInfo", () => {
  it("passes when both bundles carry the expected pair", () => {
    const b = bundles({ id: ID, channel: "nightly" }, { id: ID, channel: "nightly" });
    expect(checkBundleBuildInfo({ web: b.web, desktop: b.main }, { id: ID, channel: "nightly" })).toBeNull();
  });

  it("finds a dev bundle (with the update demo) where a nightly is built", () => {
    const b = bundles({ id: ID, channel: "dev" }, { id: ID, channel: "nightly" });
    const problem = checkBundleBuildInfo({ web: b.web, desktop: b.main }, { id: ID, channel: "nightly" });
    expect(problem).toContain("web bundle");
    expect(problem).toContain(`${ID} / dev`);
    expect(problem).toContain(`${ID} / nightly`);
  });

  it("finds a bundle of another id (a dev start in between, or a build with -VersionId)", () => {
    const b = bundles({ id: ID, channel: "dev" }, { id: "v2026.11.13.2.80", channel: "dev" });
    expect(checkBundleBuildInfo({ web: b.web, desktop: b.main }, { id: ID, channel: "dev" })).toContain("desktop bundle");
  });

  it("finds a missing bundle and a bundle without any build info (the check never passes silently)", () => {
    const b = bundles({ id: ID, channel: "dev" }, { id: ID, channel: "dev" });
    expect(checkBundleBuildInfo({ web: b.web, desktop: join(dir, "nope.cjs") }, { id: ID, channel: "dev" })).toContain("is missing");
    writeFileSync(b.main, "console.log('no info here');");
    expect(checkBundleBuildInfo({ web: b.web, desktop: b.main }, { id: ID, channel: "dev" })).toContain("carries no build id and channel");
  });

  it("finds a mix of two builds inside one bundle", () => {
    const b = bundles({ id: ID, channel: "nightly" }, { id: ID, channel: "nightly" });
    writeFileSync(join(b.web, "assets", "stale.js"), webSource(ID, "dev"));
    expect(checkBundleBuildInfo({ web: b.web, desktop: b.main }, { id: ID, channel: "nightly" })).toContain(`${ID} / dev`);
  });
});

describe("release.ts verify-bundles", () => {
  const run = (b: { web: string; main: string }, extra: string[]) =>
    spawnSync(process.execPath, [cli, "verify-bundles", "--web", b.web, "--main", b.main, "--id", ID, "--channel", "nightly", ...extra], { encoding: "utf8" });

  it("fails with the problem on stderr by default and reports it on stdout with exit code 0 in report mode", () => {
    const wrong = bundles({ id: ID, channel: "dev" }, { id: ID, channel: "nightly" });
    const failed = run(wrong, []);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("web bundle");
    const reported = run(wrong, ["--on-mismatch", "report"]);
    expect(reported.status).toBe(0);
    expect(reported.stdout.trim().startsWith("mismatch: The web bundle")).toBe(true);
  });

  it("reports a match", () => {
    const ok = bundles({ id: ID, channel: "nightly" }, { id: ID, channel: "nightly" });
    expect(run(ok, []).status).toBe(0);
    expect(run(ok, ["--on-mismatch", "report"]).stdout.trim()).toBe("match");
  });

  it("rejects an unknown mode", () => {
    const ok = bundles({ id: ID, channel: "nightly" }, { id: ID, channel: "nightly" });
    expect(run(ok, ["--on-mismatch", "ignore"]).status).toBe(1);
  });
});
