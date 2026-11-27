// Where the update check looks: the public GitHub releases of HalfCube, or, for local tests across skipped versions, a
// folder or a loopback server named in HALFCUBE_UPDATE_FEED. Pure; the file system is injected.
import { isAbsolute, resolve } from "node:path";
import type { Channel } from "../../../app/src/version.ts";

/** The public repository the releases live in. */
export const GITHUB_REPO_URL = "https://github.com/sushiflux/HalfCube";

export type FeedSource =
  /** GitHub releases; `prerelease` is true for nightly and beta, which are published as pre-releases. */
  | { kind: "github"; repoUrl: string; prerelease: boolean }
  /** A local folder with Velopack's release files (the output of `vpk pack`). */
  | { kind: "file"; path: string }
  /** A static file server on this PC, e.g. `npx serve` on the release folder. */
  | { kind: "http"; url: string };

export interface FeedChoice {
  source: FeedSource;
  /** Set when HALFCUBE_UPDATE_FEED was given but not accepted; GitHub is used then. The text is for the operator log. */
  ignored?: string;
}

export function githubFeed(channel: Channel): FeedSource {
  return { kind: "github", repoUrl: GITHUB_REPO_URL, prerelease: channel === "nightly" || channel === "beta" };
}

/** One line for logs and error details, e.g. "GitHub releases https://github.com/sushiflux/HalfCube (pre-releases: yes)". */
export function describeFeed(source: FeedSource): string {
  switch (source.kind) {
    case "github":
      return `GitHub releases ${source.repoUrl} (pre-releases: ${source.prerelease ? "yes" : "no"})`;
    case "file":
      return `local folder ${source.path}`;
    case "http":
      return `local server ${source.url}`;
  }
}

const loopbackUrl = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/;

/**
 * Reads HALFCUBE_UPDATE_FEED. Accepted: an absolute path of an existing local folder, or `http://127.0.0.1:<port>/`.
 * Anything else (a remote address, a network share, a relative path, a missing folder) is ignored and GitHub stays.
 */
export function chooseFeed(raw: string | undefined, channel: Channel, isDirectory: (path: string) => boolean): FeedChoice {
  const fallback = githubFeed(channel);
  if (raw === undefined || raw.trim() === "") return { source: fallback };
  const value = raw.trim();

  const loopback = loopbackUrl.exec(value);
  if (loopback) {
    const port = Number(loopback[1]);
    if (port < 1 || port > 65535) return { source: fallback, ignored: `the port ${port} is not between 1 and 65535` };
    return { source: { kind: "http", url: `http://127.0.0.1:${port}/` } };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return { source: fallback, ignored: "only http://127.0.0.1:<port>/ is accepted as an address" };
  }
  // Windows reads two leading separators in any mix ("\\", "//", "\/", "/\") as a UNC path, and "\??\" hands the rest to the
  // object manager unchanged ("\??\UNC\server\share"). Both are refused before isDirectory runs: a stat of such a path
  // already opens an SMB connection.
  if (/^[\\/]{2}/.test(value) || /^[\\/]\?\?[\\/]/.test(value) || /^[\\/]{2}/.test(resolve(value))) {
    return { source: fallback, ignored: "network paths are not accepted" };
  }
  if (!isAbsolute(value)) return { source: fallback, ignored: "the path is not absolute" };
  if (!isDirectory(value)) return { source: fallback, ignored: "the folder does not exist" };
  return { source: { kind: "file", path: value } };
}
