// The version the build shows: line 2 of version.txt plus the dev channel symbol, as app/src/version.ts formats it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./paths.ts";

export function expectedVersionId(): string {
  const id = readFileSync(join(repoRoot, "version.txt"), "utf8").split(/\r?\n/)[1]?.trim();
  if (!id) throw new Error("version.txt has no second line.");
  return id;
}

/** "v2026.11.5.13.12369 (</>)": the suite builds the dev channel. */
export function expectedVersionDisplay(): string {
  return `${expectedVersionId()} (</>)`;
}
