// Command line of the release job (.github/workflows/ci.yml) and of scripts/build-installer.ps1. The logic is in release-lib.ts.
//
//   node scripts/ci/release.ts info    --tag <tag> [--root <repo>]
//        checks the tag against version.txt, reads the platform line of the annotated tag and prints (and appends to $GITHUB_OUTPUT)
//        tag, channel, id, display, title, prerelease, changelog, platforms, windows
//   node scripts/ci/release.ts body    --tag <tag> --out <file> [--root <repo>]
//        the text of the GitHub release: only this version's entry, English then German (neutral text, and a notice line, when there is no entry, no lines or no channel file yet)
//   node scripts/ci/release.ts excerpt --tag <tag> --out <file> [--max-length 204800] [--root <repo>]
//        Velopack's release notes: the channel file's frame with the newest entries, as many as fit --max-length characters (default
//        200 KB; the program cuts at 256 KB), cut only between entries, this version's entry always in (empty frame without a channel file)
//   node scripts/ci/release.ts stage   --dir <vpk output folder> --channel <name> --out <folder>
//        copies the packages of this build and a slim releases.<channel>.json (what the updater reads) into --out
//   node scripts/ci/release.ts verify-bundles --web <folder> --main <file> --id <five-part id> --channel <name> [--on-mismatch fail|report]
//        checks that the web bundle and the desktop main bundle carry exactly this build id and channel (they are shared with the
//        local dev start script). fail (default): exit code 1 and the problem on stderr. report: always exit code 0, prints "match"
//        or "mismatch: <problem>" on stdout
//
// Exit code 1 with a message on stderr for every failure the job should report (missing changelog entry, tag and version.txt
// disagree, unknown platform id, ...).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReleaseNotes,
  changelogFiles,
  checkBundleBuildInfo,
  neutralNotice,
  parsePlatforms,
  parseTag,
  readableVersion,
  readTagMessage,
  ReleaseError,
  releaseBodyFor,
  releaseNotesLimit,
  resolveVersionId,
  stageFeedAssets,
  targetsWindowsDesktop,
} from "./release-lib.ts";

function options(argv: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i] ?? "";
    const value = argv[i + 1];
    if (!key.startsWith("--") || value === undefined) throw new ReleaseError(`Bad arguments near "${key}".`);
    map.set(key.slice(2), value);
  }
  return map;
}

function need(opts: Map<string, string>, name: string): string {
  const v = opts.get(name);
  if (v === undefined || v === "") throw new ReleaseError(`Missing --${name}.`);
  return v;
}

function writeOut(file: string, content: string) {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(file, content, "utf8");
}

/** Everything the commands need to know about the tag: channel, five-segment id and readable version. */
function describeTag(root: string, tag: string) {
  const info = parseTag(tag);
  const id = resolveVersionId(info, readFileSync(join(root, "version.txt"), "utf8"));
  return { info, id, channel: info.channel, readable: readableVersion(id, info.channel), file: changelogFiles[info.channel] };
}

/** The channel's customer changelog, null when the file does not exist yet (first build of the channel without a customer entry). */
function readChannelFile(root: string, file: string): string | null {
  const path = join(root, file);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function main(argv: string[]) {
  const [command, ...rest] = argv;
  const opts = options(rest);
  const root = resolve(opts.get("root") ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
  switch (command) {
    case "info": {
      const tag = need(opts, "tag");
      const d = describeTag(root, tag);
      const tagMessage = readTagMessage(root, tag);
      if (!tagMessage.annotated) {
        console.error(`Note: ${tag} is a lightweight tag (or checkout flattened it): no platform line, so all targets are built.`);
      }
      const platforms = parsePlatforms(tagMessage.message);
      const out: Record<string, string> = {
        tag,
        channel: d.channel,
        id: d.id,
        display: d.readable,
        // The release title is the readable version, never assembled by hand in the workflow
        title: d.readable,
        prerelease: d.channel === "release" ? "false" : "true",
        changelog: d.file,
        platforms: platforms.join(","),
        windows: targetsWindowsDesktop(platforms) ? "true" : "false",
      };
      const lines = Object.entries(out).map(([k, v]) => `${k}=${v}`);
      console.log(lines.join("\n"));
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, "utf8");
      return;
    }
    case "body": {
      const d = describeTag(root, need(opts, "tag"));
      const result = releaseBodyFor(readChannelFile(root, d.file), d.readable, d.file);
      writeOut(need(opts, "out"), result.body);
      const notice = neutralNotice(result.kind, d.readable, d.file);
      if (notice) console.log(`::notice::${notice}`);
      console.log(`Release text for ${d.readable} written to ${opts.get("out")}.`);
      return;
    }
    case "excerpt": {
      const d = describeTag(root, need(opts, "tag"));
      const maxLength = Number(opts.get("max-length") ?? String(releaseNotesLimit));
      if (!Number.isInteger(maxLength) || maxLength < 1) throw new ReleaseError("--max-length must be a positive integer.");
      const notes = buildReleaseNotes(readChannelFile(root, d.file), d.channel, d.readable, maxLength);
      writeOut(need(opts, "out"), notes.text);
      console.log(`Release notes (newest ${notes.entries} entries per language, ${notes.text.length} of ${maxLength} characters) written to ${opts.get("out")}.`);
      if (notes.text.length > maxLength) console.log(`::warning::The entry of ${d.readable} alone is longer than ${maxLength} characters; the release notes carry it anyway.`);
      return;
    }
    case "stage": {
      const files = stageFeedAssets(resolve(need(opts, "dir")), need(opts, "channel"), resolve(need(opts, "out")));
      console.log(`Staged for the updater: ${files.join(", ")}`);
      return;
    }
    case "verify-bundles": {
      const mode = opts.get("on-mismatch") ?? "fail";
      if (mode !== "fail" && mode !== "report") throw new ReleaseError("--on-mismatch must be fail or report.");
      const problem = checkBundleBuildInfo(
        { web: resolve(need(opts, "web")), desktop: resolve(need(opts, "main")) },
        { id: need(opts, "id"), channel: need(opts, "channel") },
      );
      if (mode === "report") {
        console.log(problem === null ? "match" : `mismatch: ${problem}`);
        return;
      }
      if (problem !== null) throw new ReleaseError(problem);
      console.log("The web and desktop bundles carry this build's id and channel.");
      return;
    }
    default:
      throw new ReleaseError("Usage: release.ts <info|body|excerpt|stage|verify-bundles> ...");
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (error instanceof ReleaseError) {
    console.error(`release.ts: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
