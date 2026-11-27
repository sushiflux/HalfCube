// The channel and category badges are fixed per mode (independent of the colour theme), so one check covers every theme: the word on
// its badge has to reach 7:1, which also meets the High contrast theme.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../../../config/build-info.ts";
import { contrastRatio } from "../../../app/src/theme/contrast.ts";

const css = readFileSync(join(repoRoot, "app/src/updates/updates.css"), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no block ${selector}`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]));
}

const modes = { light: block(":root"), dark: block(':root[data-mode="dark"]') };
const kinds = ["ch-nightly", "ch-beta", "cb-new", "cb-change", "cb-fix", "cb-security", "cb-removed", "cb-deprecated"];

describe("badge colours", () => {
  for (const [mode, vars] of Object.entries(modes)) {
    it.each(kinds)(`${mode}: %s reaches 7:1`, (kind) => {
      const bg = vars[`${kind}-bg`];
      const fg = vars[`${kind}-fg`];
      expect(bg, `${kind}-bg`).toBeDefined();
      expect(fg, `${kind}-fg`).toBeDefined();
      expect(contrastRatio(fg!, bg!)).toBeGreaterThanOrEqual(7);
    });
  }

  it("gives every category its own colour pair in each mode (never the word alone, never the colour alone)", () => {
    for (const vars of Object.values(modes)) {
      const pairs = ["cb-new", "cb-change", "cb-fix", "cb-security", "cb-removed", "cb-deprecated"].map((k) => `${vars[`${k}-bg`]}/${vars[`${k}-fg`]}`);
      expect(new Set(pairs).size).toBe(pairs.length);
    }
  });
});
