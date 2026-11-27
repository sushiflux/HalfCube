// The desktop build must give a preload script that is one self-contained file: a sandboxed preload can only require
// "electron" and a few built-ins, so a shared chunk next to it would make the whole bridge disappear at run time.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { branding } from "../../../app/src/branding.ts";
import { repoRoot } from "../../../config/build-info.ts";

describe("desktop build", () => {
  const out = mkdtempSync(join(tmpdir(), "halfcube-desktop-build-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("writes main.cjs and a self-contained preload.cjs that requires only electron", () => {
    execFileSync(process.execPath, [join(repoRoot, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "vite.desktop.config.ts", "--outDir", out, "--emptyOutDir"], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    expect(existsSync(join(out, "main.cjs"))).toBe(true);
    const preload = readFileSync(join(out, "preload.cjs"), "utf8");
    const required = [...preload.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
    expect(required).toEqual(["electron"]);
    expect(existsSync(join(out, "assets"))).toBe(false);
    // The bridge names the engine channels the main process listens on: "<slug>:<channel>", the slug read from branding.json.
    const main = readFileSync(join(out, "main.cjs"), "utf8");
    for (const bundle of [preload, main]) expect(bundle).toContain(`slug: ${JSON.stringify(branding.slug)}`);
    for (const channel of ["start-engine", "engine-port", "setup-choices"]) {
      expect(preload).toContain(`:${channel}\``);
      expect(main).toContain(`:${channel}\``);
    }
  }, 60_000);
});
