import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { chooseFeed, describeFeed, githubFeed, GITHUB_REPO_URL } from "../../../desktop/src/updates/feed.ts";

const folder = mkdtempSync(join(tmpdir(), "halfcube-feed-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
const isDirectory = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

describe("githubFeed", () => {
  it("asks for pre-releases on nightly and beta only", () => {
    expect(githubFeed("nightly")).toEqual({ kind: "github", repoUrl: GITHUB_REPO_URL, prerelease: true });
    expect(githubFeed("beta")).toMatchObject({ prerelease: true });
    expect(githubFeed("release")).toMatchObject({ prerelease: false });
  });

  it("points at the public HalfCube repository without a token", () => {
    expect(GITHUB_REPO_URL).toBe("https://github.com/sushiflux/HalfCube");
    expect(Object.keys(githubFeed("beta")).sort()).toEqual(["kind", "prerelease", "repoUrl"]);
  });
});

describe("chooseFeed (HALFCUBE_UPDATE_FEED)", () => {
  it("uses GitHub when the variable is unset or empty", () => {
    expect(chooseFeed(undefined, "nightly", isDirectory)).toEqual({ source: githubFeed("nightly") });
    expect(chooseFeed("", "nightly", isDirectory)).toEqual({ source: githubFeed("nightly") });
    expect(chooseFeed("   ", "release", isDirectory)).toEqual({ source: githubFeed("release") });
  });

  it("accepts an absolute path of an existing folder", () => {
    expect(chooseFeed(folder, "nightly", isDirectory)).toEqual({ source: { kind: "file", path: folder } });
  });

  it("accepts the loopback address with a port", () => {
    expect(chooseFeed("http://127.0.0.1:8080/", "beta", isDirectory).source).toEqual({ kind: "http", url: "http://127.0.0.1:8080/" });
    expect(chooseFeed("http://127.0.0.1:8080", "beta", isDirectory).source).toEqual({ kind: "http", url: "http://127.0.0.1:8080/" });
  });

  it.each([
    ["a remote address", "https://example.com/updates/"],
    ["a plain http address of another host", "http://192.168.0.5:8080/"],
    ["localhost by name", "http://localhost:8080/"],
    ["the loopback address without a port", "http://127.0.0.1/"],
    ["the loopback address with a path", "http://127.0.0.1:8080/feed/"],
    ["https on the loopback address", "https://127.0.0.1:8080/"],
    ["a port out of range", "http://127.0.0.1:99999/"],
    ["a file address", "file:///C:/feed"],
    ["a UNC path", "\\\\server\\share\\feed"],
    ["a relative path", "feed/releases"],
    ["a folder that does not exist", resolve(folder, "missing")],
  ])("ignores %s and stays with GitHub", (_name, raw) => {
    const choice = chooseFeed(raw, "nightly", isDirectory);
    expect(choice.source).toEqual(githubFeed("nightly"));
    expect(choice.ignored).toBeTruthy();
  });

  // Windows treats any two leading separators as a UNC path and "\??\" as an NT path; the folder check must not even run for
  // them (a stat of a UNC path already connects to the share). isDirectory says yes to everything here, so only the shape decides.
  it.each([
    ["backslash then slash", "\\/server\\share\\feed"],
    ["slash then backslash", "/\\server\\share\\feed"],
    ["two slashes", "//server/share/feed"],
    ["the NT prefix with UNC", "\\??\\UNC\\server\\share\\feed"],
    ["the NT prefix with slashes", "/??/UNC/server/share"],
    ["a verbatim UNC path", "\\\\?\\UNC\\server\\share"],
    ["a device path", "\\\\.\\pipe\\feed"],
  ])("refuses a network path written as %s without touching it", (_name, raw) => {
    const seen: string[] = [];
    const choice = chooseFeed(raw, "nightly", (path) => {
      seen.push(path);
      return true;
    });
    expect(choice.source).toEqual(githubFeed("nightly"));
    expect(choice.ignored).toBe("network paths are not accepted");
    expect(seen).toEqual([]);
  });

  it("describes every source for the log and the error details", () => {
    expect(describeFeed(githubFeed("nightly"))).toBe("GitHub releases https://github.com/sushiflux/HalfCube (pre-releases: yes)");
    expect(describeFeed({ kind: "file", path: "C:\\feed" })).toBe("local folder C:\\feed");
    expect(describeFeed({ kind: "http", url: "http://127.0.0.1:5/" })).toBe("local server http://127.0.0.1:5/");
  });
});
