import { describe, expect, it } from "vitest";
import { buildErrorText, metaLine, type ErrorReport } from "../../../app/src/ui/errorText.ts";

const report: ErrorReport = {
  headline: "Engine konnte nicht gestartet werden: halfcube-engine.exe fehlt",
  code: "HC-ENGINE-001",
  blocks: [
    { kind: "text", text: "Die Programmdatei der Engine wurde nicht gefunden:" },
    { kind: "code", text: "%LOCALAPPDATA%\\HalfCube\\current\\resources\\engine\\halfcube-engine.exe" },
    { kind: "text", text: "   " },
  ],
  version: "v2026.11.5.13.12369 (</>)",
  environment: "Browser",
  time: "25.11.2026 14:32:07",
};

describe("error text for the copy button", () => {
  it("has the headline with its code, the details and one line with code, version, place and time", () => {
    expect(buildErrorText(report)).toBe(
      [
        "Engine konnte nicht gestartet werden: halfcube-engine.exe fehlt (HC-ENGINE-001)",
        "",
        "Die Programmdatei der Engine wurde nicht gefunden:\n%LOCALAPPDATA%\\HalfCube\\current\\resources\\engine\\halfcube-engine.exe",
        "",
        "HC-ENGINE-001 · v2026.11.5.13.12369 (</>) · Browser · 25.11.2026 14:32:07",
      ].join("\n"),
    );
  });

  it("contains everything, nothing shortened", () => {
    const long = "x".repeat(5000);
    const text = buildErrorText({ ...report, blocks: [{ kind: "text", text: long }] });
    expect(text).toContain(long);
  });

  it("works without details", () => {
    expect(buildErrorText({ ...report, blocks: [] })).toBe(
      `${report.headline} (${report.code})\n\n${metaLine(report)}`,
    );
  });
});
