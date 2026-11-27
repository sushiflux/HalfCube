// Version handling shared by the UI (the Electron renderer), the Electron main process and the build.
// The version id comes from line 2 of version.txt (five segments), the channel from the environment at build time.
// This is the only place that turns them into the readable form shown to people.

import { windowsLook } from "./dev/look.ts";

export type Channel = "dev" | "nightly" | "beta" | "release";

export const channels: readonly Channel[] = ["dev", "nightly", "beta", "release"];

/** Symbol shown in parentheses after the version. A release has none. */
const channelSymbols: Record<Channel, string> = {
  dev: "</>",
  nightly: "α", // alpha
  beta: "β", // beta
  release: "",
};

/** What the build step bakes into the bundles (see config/build-info.ts). */
export interface BuildInfo {
  /** Five-segment id such as "v2026.11.4.58.26093". */
  id: string;
  channel: Channel;
}

export interface VersionInfo extends BuildInfo {
  /** Readable form with the channel symbol, e.g. "v2026.11.4.58.26093 (</>)". */
  display: string;
}

// Injected by Vite (define) in the app and the desktop build, and by the Vitest config in tests.
declare const __BUILD_INFO__: BuildInfo;

// Plain numbers without zero padding.
const versionIdPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Returns the id unchanged when it is a valid five-segment version, otherwise throws. */
export function parseVersionId(raw: string): string {
  const id = raw.trim();
  if (!versionIdPattern.test(id)) {
    throw new Error(`Invalid version id "${id}": expected five numeric segments like v2026.11.4.58.26093.`);
  }
  return id;
}

/** Reads the five-segment id from the content of version.txt (line 2). */
export function parseVersionFile(content: string): string {
  const line = content.split(/\r?\n/)[1];
  if (line === undefined || line.trim() === "") {
    throw new Error("version.txt has no second line with the five-segment version id.");
  }
  return parseVersionId(line);
}

/** Channel from the value of HALFCUBE_CHANNEL. Missing or empty means dev. */
export function parseChannel(raw: string | undefined): Channel {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return "dev";
  const found = channels.find((c) => c === value);
  if (!found) throw new Error(`Invalid channel "${raw}": expected one of ${channels.join(", ")}.`);
  return found;
}

/** Readable version: all five segments, then the channel symbol in parentheses (none for a release). */
export function formatVersion(id: string, channel: Channel): string {
  const symbol = channelSymbols[channel];
  return symbol === "" ? id : `${id} (${symbol})`;
}

export function describeVersion(info: BuildInfo): VersionInfo {
  return { ...info, display: formatVersion(info.id, info.channel) };
}

/** The version of the running build. */
export function currentVersion(): VersionInfo {
  const info = describeVersion(__BUILD_INFO__);
  // Dev demo only (dev/look.ts): the display reads as on the Nightly channel; the channel itself stays dev.
  return windowsLook() ? { ...info, display: formatVersion(info.id, "nightly") } : info;
}
