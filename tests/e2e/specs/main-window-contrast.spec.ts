// Contrast of the main window in every theme, light and dark: the real, rendered colours (getComputedStyle, composited over
// the real backgrounds) of its texts, plus the new tokens as the page really receives them from the generated stylesheet:
// the function icon accent on the toolbar, and the sketch colour "fully constrained" in green and blue against the view.
// Targets: 4.5:1 for text and 3:1 for meaningful UI parts; the High-contrast theme must reach 7:1 and 4.5:1.
// (The unit tests check the token values; this checks what is painted.)
import { expect, test } from "../support/fixtures.ts";

const THEMES = ["praezision", "skizze", "graphit", "blaupause", "kontrast", "farbsicher", "daemmerung"] as const;
const MODES = ["light", "dark"] as const;

interface Pair {
  name: string;
  kind: "text" | "ui";
  ratio: number;
  foreground: string;
  background: string;
}

/**
 * Accepted: the function accent is chosen in High contrast dark for 3:1, not the 4.5:1 that
 * theme asks of UI parts.
 */
const accepted: Record<string, number> = { "kontrast/dark/function icon accent on the selected surface": 3 };

for (const theme of THEMES) {
  for (const mode of MODES) {
    test(`main window contrast: ${theme} ${mode}`, async ({ app }) => {
      const { page } = app;
      await app.open(`?screen=main&lang=en&theme=${theme}&mode=${mode}`);
      await expect(page.getByTestId("main-window")).toBeVisible();

      const pairs = await page.evaluate((): Pair[] => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("no 2d canvas");
        type Rgba = [number, number, number, number];
        const parse = (css: string): Rgba => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = "#000";
          ctx.fillStyle = css;
          ctx.fillRect(0, 0, 1, 1);
          const d = ctx.getImageData(0, 0, 1, 1).data;
          return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, (d[3] ?? 0) / 255];
        };
        const over = (top: Rgba, bottom: Rgba): Rgba => {
          const a = top[3] + bottom[3] * (1 - top[3]);
          if (a === 0) return [0, 0, 0, 0];
          const mix = (i: 0 | 1 | 2) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a;
          return [mix(0), mix(1), mix(2), a];
        };
        const backgroundOf = (el: Element): Rgba => {
          let acc: Rgba = [0, 0, 0, 0];
          for (let node: Element | null = el; node; node = node.parentElement) {
            acc = over(acc, parse(getComputedStyle(node).backgroundColor));
            if (acc[3] >= 0.999) return acc;
          }
          return over(acc, [255, 255, 255, 1]);
        };
        const lum = (c: Rgba): number => {
          const f = (v: number) => {
            const s = v / 255;
            return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
          };
          return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
        };
        const ratio = (a: Rgba, b: Rgba): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
        const hex = (c: Rgba) => `#${[c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
        const out: Pair[] = [];
        const add = (name: string, kind: "text" | "ui", fgCss: string, bg: Rgba) => {
          const fg = over(parse(fgCss), bg);
          out.push({ name, kind, ratio: ratio(fg, bg), foreground: hex(fg), background: hex(bg) });
        };
        const byId = (id: string): Element => {
          const el = document.querySelector(`[data-testid="${id}"]`);
          if (!el) throw new Error(`contrast target missing: ${id}`);
          return el;
        };
        const text = (name: string, el: Element) => add(name, "text", getComputedStyle(el).color, backgroundOf(el));
        const root = getComputedStyle(document.documentElement);
        const token = (name: string) => root.getPropertyValue(name).trim();

        text("status bar text", byId("status-selection"));
        text("status bar version", byId("version"));
        text("document tab title", byId("document-tab").querySelector("span") as Element);
        text("tree label (on the component band)", byId("tree-row-origin"));
        text("tool label (Sketch)", byId("tool-sketch").querySelector("span:last-child") as Element);
        text("tool tab label", byId("tab-body"));
        text("timeline hint", byId("timeline-track").querySelector("span") as Element);
        text("timeline position", byId("timeline-position"));
        text("context bar path", byId("context-path"));
        text("browser header", byId("browser-tree").firstElementChild as Element);

        const surface = parse(token("--c-surface"));
        const bg = parse(token("--c-bg"));
        const soft = parse(token("--c-primary-soft"));
        const fn = token("--c-fn");
        add("function icon accent on the toolbar", "ui", fn, surface);
        add("function icon accent on the background", "ui", fn, bg);
        add("function icon accent on the selected surface", "ui", fn, soft);
        // The tool glyph really is painted with it (the pulled face of the extrude icon).
        const painted = byId("tool-extrude").querySelector("svg path[style*='--c-fn']");
        if (!painted) throw new Error("the extrude icon does not use the function accent");
        add("extrude icon face colour equals the token", "ui", getComputedStyle(painted).fill, surface);

        // The value fields at the geometry, as the stylesheet really gives the colours: the filled labels of the look "Etikett"
        // (grey, active, red; the text colour is the one the component paints), and the texts and lines that stand directly on the view.
        const muted = parse(token("--c-muted"));
        const error = parse(token("--c-error"));
        const primary = parse(token("--c-primary"));
        add("value label (Etikett), grey: text on the muted fill", "text", token("--c-surface"), muted);
        add("value label (Etikett), red: text on the error fill", "text", token("--c-surface"), error);
        add("value label (Etikett), active: text on the primary fill", "text", token("--c-on-primary"), primary);
        add("value label (Etikett), selected: primary text on the on-primary colour", "text", token("--c-primary"), parse(token("--c-on-primary")));
        add("value unit (muted) on the surface of the active field", "text", token("--c-muted"), parse(token("--c-surface")));
        for (const view of ["--c-viewport", "--c-viewport-2"]) {
          const v = parse(token(view));
          add("value text on the dimension line, on " + view, "text", token("--c-text"), v);
          add("value unit and sign (muted), on " + view, "text", token("--c-muted"), v);
          add("committed dimension text, on " + view, "text", token("--c-dim-text"), v);
          add("message under a value field (error colour), on " + view, "text", token("--c-error"), v);
          add("live dimension line and accent line (primary), on " + view, "ui", token("--c-primary"), v);
          add("live dimension line, quiet (muted), on " + view, "ui", token("--c-muted"), v);
          add("live dimension line, invalid (error), on " + view, "ui", token("--c-error"), v);
        }
        for (const view of ["--c-viewport", "--c-viewport-2"]) {
          const v = parse(token(view));
          add(`sketch fully constrained, green, on ${view}`, "ui", token("--c-sketch-full"), v);
          add(`sketch fully constrained, blue, on ${view}`, "ui", token("--c-sketch-full-blue"), v);
        }
        return out;
      });

      const high = theme === "kontrast";
      const failures: string[] = [];
      for (const p of pairs) {
        const target = p.kind === "text" ? (high ? 7 : 4.5) : high ? 4.5 : 3;
        const need = accepted[`${theme}/${mode}/${p.name}`] ?? target;
        if (p.ratio < need) failures.push(`${p.name}: ${p.ratio.toFixed(2)} (${p.foreground} on ${p.background}), needs ${need}`);
      }
      test.info().annotations.push({ type: "pairs", description: String(pairs.length) });
      expect(failures).toEqual([]);
    });
  }
}
