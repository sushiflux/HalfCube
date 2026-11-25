import { describe, expect, it } from "vitest";
import {
  currentVersion,
  describeVersion,
  formatVersion,
  parseChannel,
  parseVersionFile,
  parseVersionId,
} from "../../app/src/version.ts";

const id = "v2026.11.12.13.557";

describe("formatVersion", () => {
  it("shows all five segments and the channel symbol in parentheses", () => {
    expect(formatVersion(id, "dev")).toBe("v2026.11.12.13.557 (</>)");
    expect(formatVersion(id, "nightly")).toBe("v2026.11.12.13.557 (α)");
    expect(formatVersion(id, "beta")).toBe("v2026.11.12.13.557 (β)");
  });

  it("shows a release without any symbol or empty parentheses", () => {
    expect(formatVersion(id, "release")).toBe("v2026.11.12.13.557");
  });

  it("describeVersion keeps id and channel next to the readable form", () => {
    expect(describeVersion({ id, channel: "beta" })).toEqual({ id, channel: "beta", display: "v2026.11.12.13.557 (β)" });
  });

  it("currentVersion uses the build-time constant", () => {
    expect(currentVersion().display).toBe("v2026.1.2.3.4 (</>)");
  });
});

describe("parseVersionId", () => {
  it("accepts five numeric segments", () => {
    expect(parseVersionId(id)).toBe(id);
    expect(parseVersionId(`  ${id}\r`)).toBe(id);
    expect(parseVersionId("v2026.1.1.0.0")).toBe("v2026.1.1.0.0");
  });

  it.each(["", "v2026.11.4", "2026.11.4.58.26093", "v2026.11.4.58", "v2026.11.4.58.26093.1", "v2026.11.04.58.1", "v2026.11.4.58.x", "v2026.11.4.58.-1"])(
    "rejects %j",
    (bad) => {
      expect(() => parseVersionId(bad)).toThrow(/Invalid version id/);
    },
  );
});

describe("parseVersionFile", () => {
  it("reads the five-segment id from line 2", () => {
    expect(parseVersionFile(`v2026.11.4\n${id}\n`)).toBe(id);
    expect(parseVersionFile(`v2026.11.4\r\n${id}\r\n`)).toBe(id);
  });

  it("fails when line 2 is missing or empty", () => {
    expect(() => parseVersionFile("v2026.11.4\n")).toThrow(/second line/);
    expect(() => parseVersionFile("v2026.11.4")).toThrow(/second line/);
  });

  it("fails when line 2 is not a five-segment id", () => {
    expect(() => parseVersionFile("v2026.11.4\nv2026.11.4\n")).toThrow(/Invalid version id/);
  });
});

describe("parseChannel", () => {
  it("defaults to dev", () => {
    expect(parseChannel(undefined)).toBe("dev");
    expect(parseChannel("")).toBe("dev");
    expect(parseChannel("  ")).toBe("dev");
  });

  it("accepts the four channels, case-insensitive", () => {
    expect(parseChannel("nightly")).toBe("nightly");
    expect(parseChannel("Beta")).toBe("beta");
    expect(parseChannel("RELEASE")).toBe("release");
    expect(parseChannel("dev")).toBe("dev");
  });

  it("rejects anything else", () => {
    expect(() => parseChannel("stable")).toThrow(/Invalid channel/);
  });
});
