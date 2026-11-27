#!/usr/bin/env node
// Prints the cache key part for a prebuilt OCCT: the pinned OCCT commit from third_party/manifest.json plus a hash of
// the OCCT configure options of the given platform, read from the engine build scripts. A change to either one
// produces a new key, so a stale OCCT is never reused. Fails when the options block cannot be found (a refactored
// build script must break CI loudly instead of silently keeping an old cache).
//
//   node scripts/ci/occt-key.mjs <windows|linux>           prints "<platform>-<commit8>-<hash12>"
// In GitHub Actions the line "key=<value>" is also appended to $GITHUB_OUTPUT.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const platform = process.argv[2];

// Region of each build script that decides how OCCT is configured.
const regions = {
  windows: { file: "engine/scripts/build-windows.ps1", pattern: /\$occtOptions = @\([\s\S]*?-DUSE_EIGEN=OFF'\)/ },
  linux: { file: "engine/scripts/build-linux.sh", pattern: /occt_stamp=[\s\S]*?-DUSE_EIGEN=OFF/ },
};
const region = regions[platform];
if (!region) {
  console.error(`usage: occt-key.mjs <${Object.keys(regions).join("|")}>`);
  process.exit(64);
}

const manifest = JSON.parse(readFileSync(join(repo, "third_party/manifest.json"), "utf8"));
const occt = manifest.components.find((c) => c.id === "occt");
if (!occt?.fetch?.commit) {
  console.error("occt-key: no OCCT commit in third_party/manifest.json");
  process.exit(1);
}
const text = readFileSync(join(repo, region.file), "utf8").replace(/\r\n/g, "\n");
const match = region.pattern.exec(text);
if (!match) {
  console.error(`occt-key: OCCT options block not found in ${region.file}; update scripts/ci/occt-key.mjs`);
  process.exit(1);
}
const hash = createHash("sha256").update(match[0]).digest("hex").slice(0, 12);
const key = `${platform}-${occt.fetch.commit.slice(0, 8)}-${hash}`;
console.log(key);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\n`);
