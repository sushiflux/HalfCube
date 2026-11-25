// Contrast in every theme: the real, rendered colours (getComputedStyle, composited over the real backgrounds) of the
// main text/background and UI-part pairs in the component gallery, in all seven colour themes, light and dark.
// Targets: 4.5:1 for text and 3:1 for meaningful UI parts; the High-contrast theme must reach 7:1 and 4.5:1.
// (Unit tests check the theme tokens themselves; this checks what is really painted.)
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures.ts";

const THEMES = ["praezision", "skizze", "graphit", "blaupause", "kontrast", "farbsicher", "daemmerung"] as const;
const MODES = ["light", "dark"] as const;

interface PairResult {
  name: string;
  kind: "text" | "ui";
  foreground: string;
  background: string;
  ratio: number;
}

/** Reads the rendered colour pairs of the gallery. Runs in the page. */
async function readPairs(page: Page): Promise<PairResult[]> {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d canvas");
    type Rgba = [number, number, number, number];

    /** Any CSS colour (rgb, oklch, color-mix, ...) as sRGB: the canvas converts it. */
    const parse = (css: string): Rgba => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      // getImageData returns straight (not premultiplied) values.
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, (d[3] ?? 0) / 255];
    };
    const over = (top: Rgba, bottom: Rgba): Rgba => {
      const a = top[3] + bottom[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      const mix = (i: 0 | 1 | 2) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a;
      return [mix(0), mix(1), mix(2), a];
    };
    /** The colour a point of this element's background really has: its own and its ancestors' layers composited. */
    const backgroundOf = (el: Element): Rgba => {
      let acc: Rgba = [0, 0, 0, 0];
      for (let node: Element | null = el; node; node = node.parentElement) {
        acc = over(acc, parse(getComputedStyle(node).backgroundColor));
        if (acc[3] >= 0.999) return acc;
      }
      return over(acc, [255, 255, 255, 1]); // the page itself has no background colour: white
    };
    const lum = (c: Rgba): number => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const ratio = (a: Rgba, b: Rgba): number => {
      const la = lum(a);
      const lb = lum(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    const hex = (c: Rgba) => `#${[c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

    const out: { name: string; kind: "text" | "ui"; foreground: string; background: string; ratio: number }[] = [];
    const text = (name: string, el: Element | null) => {
      if (!el) throw new Error(`contrast target missing: ${name}`);
      const bg = backgroundOf(el);
      const fg = over(parse(getComputedStyle(el).color), bg);
      out.push({ name, kind: "text", foreground: hex(fg), background: hex(bg), ratio: ratio(fg, bg) });
    };
    const border = (name: string, el: Element | null, behind: Element | null) => {
      if (!el || !behind) throw new Error(`contrast target missing: ${name}`);
      const bg = backgroundOf(behind);
      const fg = over(parse(getComputedStyle(el).borderTopColor), bg);
      out.push({ name, kind: "ui", foreground: hex(fg), background: hex(bg), ratio: ratio(fg, bg) });
    };

    /** A filled part (a switch track) against the card behind it. */
    const fill = (name: string, el: Element | null, behind: Element | null) => {
      if (!el || !behind) throw new Error(`contrast target missing: ${name}`);
      const bg = backgroundOf(behind);
      const fg = over(parse(getComputedStyle(el).backgroundColor), bg);
      out.push({ name, kind: "ui", foreground: hex(fg), background: hex(bg), ratio: ratio(fg, bg) });
    };
    const section = (title: string) => Array.from(document.querySelectorAll("section")).find((s) => s.querySelector("h2")?.textContent === title) ?? null;
    const buttons = section("Buttons");
    const button = (label: string) => Array.from(buttons?.querySelectorAll("button") ?? []).find((b) => b.textContent?.trim() === label) ?? null;
    const form = section("Fields with live validation");
    const nameInput = form?.querySelector("input") ?? null;
    const slot = nameInput?.nextElementSibling ?? null;

    text("section title (primary colour on card)", section("Buttons")?.querySelector("h2") ?? null);
    const toggles = section("Toggle and checkbox");
    const labelled = (label: string) => Array.from(toggles?.querySelectorAll("span") ?? []).find((el) => el.textContent === label) ?? null;
    text("body text on card (switch label)", labelled("Switched on"));
    text("muted text on card (field hint)", slot?.querySelector("[id]") ?? null);
    text("text in a field", nameInput);
    text("primary button label", button("Primary"));
    text("create button label", button("Create"));
    text("destructive button label", button("Destructive"));
    text("neutral button label", button("Neutral"));
    text("quiet button label", button("Quiet"));
    border(nameInput?.getAttribute("aria-invalid") === "true" ? "field border, invalid, on card" : "field border on card", nameInput, form);
    border("neutral button border on card", button("Neutral"), buttons);
    const switches = Array.from(toggles?.querySelectorAll('button[role="switch"]') ?? []);
    fill("switch track (on) on card", switches[0] ?? null, toggles);
    fill("switch track (off) on card", switches[1] ?? null, toggles);
    // The symbol on the thumb (check or dash) against the thumb.
    for (const [index, name] of [[0, "on"], [1, "off"]] as const) {
      const thumb = switches[index]?.querySelector("span") ?? null;
      if (!thumb) throw new Error("contrast target missing: switch thumb");
      const bg = backgroundOf(thumb);
      const fg = over(parse(getComputedStyle(thumb).color), bg);
      out.push({ name: `switch symbol (${name}) on thumb`, kind: "ui", foreground: hex(fg), background: hex(bg), ratio: ratio(fg, bg) });
    }
    border("checkbox border on card", toggles?.querySelector('input[type="checkbox"] + span') ?? null, toggles);
    text("checkbox label text on card", toggles?.querySelector('input[type="checkbox"]')?.parentElement?.lastElementChild ?? null);
    const error = form?.querySelector('[role="alert"]') ?? null;
    if (error) text("error message on card", error.querySelector("span:last-child") ?? error);
    return out;
  });
}

for (const mode of MODES) {
  for (const theme of THEMES) {
    test(`contrast: theme ${theme}, ${mode}`, async ({ app }, testInfo) => {
      const { page } = app;
      await app.open(`?demo=gallery&lang=en&theme=${theme}&mode=${mode}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
      await expect(page.getByRole("heading", { name: "Error notice" })).toBeVisible();
      const settle = () =>
        page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
        });
      await settle();

      const need = theme === "kontrast" ? { text: 7, ui: 4.5 } : { text: 4.5, ui: 3 };
      const pairs = await readPairs(page);
      // A message in the field, so the colours of the invalid state are checked too (the hint is replaced by the message).
      await page.getByLabel("Name", { exact: true }).pressSequentially("ab");
      await expect(page.getByRole("alert").first()).toBeVisible();
      await settle();
      pairs.push(...(await readPairs(page)).filter((p) => p.name === "error message on card" || p.name === "field border, invalid, on card"));
      expect(pairs.length, "all pairs were found").toBeGreaterThanOrEqual(16);
      const table = pairs.map((p) => `${p.name}: ${p.foreground} on ${p.background} = ${p.ratio.toFixed(2)}:1 (needs ${need[p.kind]}:1)`);
      testInfo.annotations.push({ type: "contrast", description: `${theme} ${mode}: lowest ${Math.min(...pairs.map((p) => p.ratio)).toFixed(2)}:1 of ${pairs.length} pairs` });
      await testInfo.attach("contrast-pairs.txt", { body: table.join("\n"), contentType: "text/plain" });
      const failing = pairs.filter((p) => p.ratio < need[p.kind]).map((p) => `${p.name}: ${p.foreground} on ${p.background} = ${p.ratio.toFixed(2)}:1, needs ${need[p.kind]}:1`);
      expect(failing, `pairs below the target in ${theme} ${mode}`).toEqual([]);
    });
  }
}
