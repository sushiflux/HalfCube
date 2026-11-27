// What the user is told when the 3D view cannot start. Pure, so it can be tested without a window: the facts come in as a probe
// (is WebGPU offered, does a WebGL 2 context exist) and the translate function; the raw error text of the graphics library
// (for example "TypeError: can't access property "getSupportedExtensions", this.gl is null") is never the message, it only
// stays as the technical detail for the report.
import type { Translate } from "../i18n/core.ts";
import type { ErrorBlock } from "../ui/errorText.ts";

/** What the Chromium renderer offers for drawing, measured at the moment the start failed. */
export interface GraphicsProbe {
  webgpu: boolean;
  webgl2: boolean;
}

export interface ViewportFailureText {
  /** What failed, specific. */
  headline: string;
  /** HC-VIEW-001: no graphics interface at all. HC-VIEW-002: one is there but the start failed. */
  code: "HC-VIEW-001" | "HC-VIEW-002";
  blocks: ErrorBlock[];
}

/** Reads what the renderer offers right now. A WebGL 2 context created for the test is released again. */
export function probeGraphics(doc: Document = document, nav: Navigator = navigator): GraphicsProbe {
  const webgpu = "gpu" in nav && (nav as Navigator & { gpu?: unknown }).gpu !== undefined;
  let webgl2 = false;
  try {
    const context = doc.createElement("canvas").getContext("webgl2");
    webgl2 = context !== null;
    context?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webgl2 = false;
  }
  return { webgpu, webgl2 };
}

export function describeViewportFailure(error: Error, probe: GraphicsProbe, t: Translate): ViewportFailureText {
  const noInterface = !probe.webgpu && !probe.webgl2;
  const state = (ok: boolean) => (ok ? t("viewport.available") : t("viewport.notAvailable"));
  return {
    headline: noInterface ? t("viewport.unavailableTitle") : t("viewport.failedTitle"),
    code: noInterface ? "HC-VIEW-001" : "HC-VIEW-002",
    blocks: [
      { kind: "text", text: noInterface ? t("viewport.unavailableText") : t("viewport.failedText") },
      { kind: "text", text: t("viewport.probeLine", { webgpu: state(probe.webgpu), webgl2: state(probe.webgl2) }) },
      { kind: "text", text: t("viewport.unavailableFix") },
      { kind: "text", text: t("viewport.technical") },
      { kind: "code", text: `${error.name}: ${error.message}` },
    ],
  };
}
