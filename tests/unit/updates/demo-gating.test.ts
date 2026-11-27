// The update demo (?updates-demo=...) must not be reachable in nightly, beta or release builds: the demo module has to be absent from
// their bundles, not only switched off. This builds the web bundle for each channel and looks into it. The changelog of the channel is
// baked in as well: a missing file must not break the build.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { build } from "vite";
import { repoRoot } from "../../../config/build-info.ts";

const out = mkdtempSync(join(tmpdir(), "halfcube-gating-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

async function bundleText(channel: string): Promise<string> {
  const previous = process.env.HALFCUBE_CHANNEL;
  process.env.HALFCUBE_CHANNEL = channel;
  const dir = join(out, channel);
  try {
    await build({ configFile: join(repoRoot, "vite.config.ts"), logLevel: "silent", build: { outDir: dir, emptyOutDir: true } });
  } finally {
    if (previous === undefined) delete process.env.HALFCUBE_CHANNEL;
    else process.env.HALFCUBE_CHANNEL = previous;
  }
  const assets = join(dir, "assets");
  return readdirSync(assets)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(assets, f), "utf8"))
    .join("\n");
}

// Strings that only the demo module contains.
const demoMarkers = ["updates-demo", "updates-restart", "Kreise zeichnest du über drei Punkte", "updates-look", "did not answer within 10000 ms"];

describe("the update demo is part of dev builds only", () => {
  it("is in the dev bundle", async () => {
    const text = await bundleText("dev");
    expect(demoMarkers.filter((m) => !text.includes(m))).toEqual([]);
  }, 120_000);

  it.each(["nightly", "beta", "release"])("is not in the %s bundle", async (channel) => {
    const text = await bundleText(channel);
    expect(demoMarkers.filter((m) => text.includes(m))).toEqual([]);
    // The real update views are there.
    expect(text).toContain("HC-UPDATE-001");
  }, 120_000);
});
