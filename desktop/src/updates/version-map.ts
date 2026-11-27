// Velopack accepts only three-part SemVer2 versions, so the installer script (scripts/build-installer.ps1, Get-PackVersion)
// packs the five-segment id like this:
//   release  2026.11.12                    (id v2026.11.12.13.557)
//   beta     2026.11.12-beta.13.557
//   nightly  2026.11.12-alpha.13.557
// This module maps a package version from the feed back to the id the program shows. Pure, no Electron, no Velopack.
import type { Channel } from "../../../app/src/version.ts";

export interface MappedVersion {
  /** "v2026.11.12.13.557", or "v2026.11.12" when the last two segments are unknown (a release without stamped notes). */
  id: string;
  /** True when all five segments are known. */
  complete: boolean;
}

const packVersion = /^v?(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta)\.(\d+)\.(\d+))?$/i;
const stampedHeading = /^##\s+v(\d+)\.(\d+)\.(\d+)\.(\d+)\.(\d+)(?![\d.])/m;

/**
 * The first stamped "## v..." heading of the release notes, as "v2026.11.12.13.557"; null when there is none or when its
 * first three segments do not belong to this release (a stale or foreign note must never rename a version).
 */
export function stampedIdFromNotes(notes: string, year: string, month: string, commit: string): string | null {
  const match = stampedHeading.exec(notes);
  if (!match) return null;
  if (Number(match[1]) !== Number(year) || Number(match[2]) !== Number(month) || Number(match[3]) !== Number(commit)) return null;
  return `v${Number(match[1])}.${Number(match[2])}.${Number(match[3])}.${Number(match[4])}.${Number(match[5])}`;
}

/** Maps a package version of the feed back to the five-segment id; null when it is not one of the shapes above. */
export function mapPackVersion(version: string, channel: Exclude<Channel, "dev">, notesMarkdown: string): MappedVersion | null {
  const match = packVersion.exec(version.trim());
  if (!match) return null;
  const [, year, month, commit, label, prompts, lines] = match;
  if (year === undefined || month === undefined || commit === undefined) return null;
  const core = `v${Number(year)}.${Number(month)}.${Number(commit)}`;

  if (label === undefined) {
    // A release: the last two segments are not part of the SemVer, take them from the release notes if they say so.
    const stamped = channel === "release" ? stampedIdFromNotes(notesMarkdown, year, month, commit) : null;
    return stamped ? { id: stamped, complete: true } : { id: core, complete: false };
  }
  // The label must belong to the channel the program follows (nightly packs "alpha", beta packs "beta").
  const expected = channel === "nightly" ? "alpha" : channel === "beta" ? "beta" : null;
  if (expected === null || label.toLowerCase() !== expected) return null;
  if (prompts === undefined || lines === undefined) return null;
  return { id: `${core}.${Number(prompts)}.${Number(lines)}`, complete: true };
}
