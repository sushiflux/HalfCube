// The message when the 3D view cannot start: specific and friendly in both languages, the library's raw error only as the
// technical detail (still in the copyable text).
import { describe, expect, it } from "vitest";
import { branding } from "../../../app/src/branding.ts";
import { makeState } from "../../../app/src/i18n/core.ts";
import type { Language } from "../../../app/src/i18n/types.ts";
import { buildErrorText } from "../../../app/src/ui/errorText.ts";
import { describeViewportFailure, probeGraphics } from "../../../app/src/viewport/unavailable.ts";

const raw = new TypeError(`can't access property "getSupportedExtensions", this.gl is null`);
const rawLine = `TypeError: ${raw.message}`;

const textIn = (language: Language, probe: { webgpu: boolean; webgl2: boolean }) => describeViewportFailure(raw, probe, makeState(language).t);

describe("describeViewportFailure", () => {
  it.each(["de", "en"] as const)("names what failed and what to do in %s when neither WebGPU nor WebGL 2 exists", (language) => {
    const text = textIn(language, { webgpu: false, webgl2: false });
    expect(text.code).toBe("HC-VIEW-001");
    // The headline is the cause in words, not the library's text.
    expect(text.headline).not.toContain("gl is null");
    expect(text.headline).not.toContain("TypeError");
    expect(text.headline).toMatch(language === "de" ? /3D-Ansicht konnte nicht gestartet werden.*Grafikschnittstelle/ : /3D view could not start.*graphics interface/);
    const prose = text.blocks.filter((b) => b.kind === "text").map((b) => b.text).join("\n");
    expect(prose).toMatch(language === "de" ? /Grafiktreiber.*Hardwarebeschleunigung/s : /graphics driver.*hardware acceleration/s);
    expect(prose).toContain(branding.name);
    expect(prose).not.toContain("{");
    expect(prose).toContain(language === "de" ? "WebGPU: nicht verfügbar · WebGL 2: nicht verfügbar" : "WebGPU: not available · WebGL 2: not available");
  });

  it.each(["de", "en"] as const)("keeps the raw library text only as the code block of the details, and in the copy text (%s)", (language) => {
    const text = textIn(language, { webgpu: false, webgl2: false });
    const codeBlocks = text.blocks.filter((b) => b.kind === "code");
    expect(codeBlocks).toEqual([{ kind: "code", text: rawLine }]);
    expect(text.blocks.filter((b) => b.kind === "text").some((b) => b.text.includes("gl is null"))).toBe(false);
    const copy = buildErrorText({ headline: text.headline, code: text.code, blocks: text.blocks, version: "v1", environment: "Desktop win32", time: "t" });
    expect(copy).toContain(rawLine);
    expect(copy).toContain(`${text.headline} (HC-VIEW-001)`);
  });

  it("uses another headline and code when a graphics interface exists but did not start", () => {
    const text = textIn("en", { webgpu: false, webgl2: true });
    expect(text.code).toBe("HC-VIEW-002");
    expect(text.headline).toBe("The 3D view could not start: the graphics interface reports an error");
    expect(text.blocks.map((b) => b.text).join("\n")).toContain("WebGPU: not available · WebGL 2: available");
  });
});

describe("probeGraphics", () => {
  const nav = (gpu: boolean) => (gpu ? { gpu: {} } : {}) as unknown as Navigator;
  const doc = (context: unknown) => ({ createElement: () => ({ getContext: () => context }) }) as unknown as Document;

  it("reports what the renderer offers", () => {
    expect(probeGraphics(doc(null), nav(false))).toEqual({ webgpu: false, webgl2: false });
    expect(probeGraphics(doc({ getExtension: () => null }), nav(true))).toEqual({ webgpu: true, webgl2: true });
  });

  it("releases the test context and counts a throwing context creation as not available", () => {
    let lost = 0;
    probeGraphics(doc({ getExtension: () => ({ loseContext: () => lost++ }) }), nav(false));
    expect(lost).toBe(1);
    const throwing = { createElement: () => ({ getContext: () => { throw new Error("blocked"); } }) } as unknown as Document;
    expect(probeGraphics(throwing, nav(false)).webgl2).toBe(false);
  });
});
