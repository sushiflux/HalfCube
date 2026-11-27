// The loading screen shows the slogan from branding.json, in every UI language, and nothing else carries a copy of it.
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { branding } from "../../../app/src/branding.ts";
import type { LoadingProgress } from "../../../app/src/ui/loading/types.ts";

// The component is loaded through a variable path: the node project of the tests has no JSX setting, Vitest compiles the file itself.
const path = "../../../app/src/ui/loading/LoadingScreen.tsx";
const { LoadingScreen } = (await import(/* @vite-ignore */ path)) as { LoadingScreen: ComponentType<{ progress: LoadingProgress }> };

const progress: LoadingProgress = { steps: [{ id: "engine", label: "Engine", state: "active" }] };

describe("loading screen slogan", () => {
  it("renders the slogan from branding under the wordmark", () => {
    const html = renderToStaticMarkup(createElement(LoadingScreen, { progress }));
    expect(branding.slogan).not.toBe("");
    expect(html).toContain(`data-testid="loading-slogan"`);
    expect(html).toContain(`>${branding.slogan}</div>`);
    expect(html.indexOf("data-wordmark")).toBeLessThan(html.indexOf("loading-slogan"));
  });

  it("stays in the layout while an error replaces the progress", () => {
    const failed: LoadingProgress = {
      steps: [{ id: "engine", label: "Engine", state: "failed" }],
      error: { headline: "Failed", code: "HC-ENGINE-001", details: [], actions: [] },
    };
    expect(renderToStaticMarkup(createElement(LoadingScreen, { progress: failed }))).toContain(branding.slogan);
  });
});
