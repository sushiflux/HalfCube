import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBuildInfo, readDevPorts, repoRoot } from "../../config/build-info.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "build-info-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readBuildInfo", () => {
  it("reads line 2 of version.txt and the channel from the environment", () => {
    writeFileSync(join(dir, "version.txt"), "v2026.11.4\nv2026.11.4.58.26093\n");
    expect(readBuildInfo(dir, {})).toEqual({ id: "v2026.11.4.58.26093", channel: "dev" });
    expect(readBuildInfo(dir, { HALFCUBE_CHANNEL: "nightly" })).toEqual({ id: "v2026.11.4.58.26093", channel: "nightly" });
  });

  it("lets HALFCUBE_VERSION_ID replace the id of version.txt (local update tests) and validates it", () => {
    writeFileSync(join(dir, "version.txt"), "v2026.11.4\nv2026.11.4.58.26093\n");
    expect(readBuildInfo(dir, { HALFCUBE_VERSION_ID: "v2026.11.20.1.2", HALFCUBE_CHANNEL: "nightly" })).toEqual({ id: "v2026.11.20.1.2", channel: "nightly" });
    expect(() => readBuildInfo(dir, { HALFCUBE_VERSION_ID: "v2026.11.20" })).toThrow(/Invalid version id/);
    // An empty value is no override
    expect(readBuildInfo(dir, { HALFCUBE_VERSION_ID: "  " }).id).toBe("v2026.11.4.58.26093");
  });

  it("fails on an invalid channel", () => {
    writeFileSync(join(dir, "version.txt"), "v2026.11.4\nv2026.11.4.58.26093\n");
    expect(() => readBuildInfo(dir, { HALFCUBE_CHANNEL: "foo" })).toThrow(/Invalid channel/);
  });

  it("fails on a missing or malformed version.txt", () => {
    expect(() => readBuildInfo(dir, {})).toThrow(/version.txt/);
    writeFileSync(join(dir, "version.txt"), "v2026.11.4\n");
    expect(() => readBuildInfo(dir, {})).toThrow(/second line/);
  });

  it("reads the version.txt of the repository", () => {
    expect(readBuildInfo(repoRoot, {}).id).toMatch(/^v\d+\.\d+\.\d+\.\d+\.\d+$/);
  });
});

describe("readDevPorts", () => {
  it("reads the registered ports of the repository", () => {
    expect(readDevPorts()).toEqual({ "web-dev": 5313, "e2e-cdp": 5315 });
  });

  it("rejects a missing or invalid port", () => {
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "dev-ports.json"), JSON.stringify({ "web-dev": 5313, "e2e-cdp": "x" }));
    expect(() => readDevPorts(dir)).toThrow(/e2e-cdp/);
  });
});
