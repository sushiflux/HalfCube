import { describe, expect, it } from "vitest";
import { mapPackVersion, stampedIdFromNotes } from "../../../desktop/src/updates/version-map.ts";
import { formatVersion } from "../../../app/src/version.ts";

describe("mapPackVersion", () => {
  it("maps a nightly package version (alpha) back to the five-segment id", () => {
    expect(mapPackVersion("2026.11.12-alpha.13.557", "nightly", "")).toEqual({ id: "v2026.11.12.13.557", complete: true });
  });

  it("maps a beta package version back to the five-segment id", () => {
    expect(mapPackVersion("2026.11.12-beta.13.557", "beta", "")).toEqual({ id: "v2026.11.12.13.557", complete: true });
  });

  it("takes the last two segments of a release from the first stamped heading of its notes", () => {
    const notes = "# Changelog\n\n## v2026.11.12.13.557\n\n- text\n\n## v2026.11.5.9.100\n";
    expect(mapPackVersion("2026.11.12", "release", notes)).toEqual({ id: "v2026.11.12.13.557", complete: true });
  });

  it("falls back to the three segments for a release without stamped notes", () => {
    expect(mapPackVersion("2026.11.12", "release", "")).toEqual({ id: "v2026.11.12", complete: false });
    expect(mapPackVersion("2026.11.12", "release", "## vNEXT\n- text")).toEqual({ id: "v2026.11.12", complete: false });
  });

  it("ignores a stamped heading that belongs to another version", () => {
    expect(mapPackVersion("2026.11.12", "release", "## v2026.11.11.4.4410\n")).toEqual({ id: "v2026.11.12", complete: false });
  });

  it("reads the stamped heading with the channel symbol and a platform suffix", () => {
    expect(mapPackVersion("2026.11.12", "release", "## v2026.11.12.13.557 · Windows\n")?.id).toBe("v2026.11.12.13.557");
  });

  it("refuses a label that does not belong to the channel", () => {
    expect(mapPackVersion("2026.11.12-beta.13.557", "nightly", "")).toBeNull();
    expect(mapPackVersion("2026.11.12-alpha.13.557", "beta", "")).toBeNull();
    expect(mapPackVersion("2026.11.12-alpha.13.557", "release", "")).toBeNull();
  });

  it("returns null for shapes the installer script never packs", () => {
    expect(mapPackVersion("", "nightly", "")).toBeNull();
    expect(mapPackVersion("1.2", "release", "")).toBeNull();
    expect(mapPackVersion("2026.11.12-rc.1", "nightly", "")).toBeNull();
    expect(mapPackVersion("2026.11.12-alpha.13", "nightly", "")).toBeNull();
  });

  it("the shown version always goes through formatVersion", () => {
    const nightly = mapPackVersion("2026.11.12-alpha.13.557", "nightly", "");
    expect(formatVersion(nightly?.id ?? "", "nightly")).toBe("v2026.11.12.13.557 (α)");
    const release = mapPackVersion("2026.11.12", "release", "");
    expect(formatVersion(release?.id ?? "", "release")).toBe("v2026.11.12");
  });
});

describe("stampedIdFromNotes", () => {
  it("needs a heading at the start of a line", () => {
    expect(stampedIdFromNotes("see ## v2026.11.12.13.557", "2026", "11", "12")).toBeNull();
  });
});
