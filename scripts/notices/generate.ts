// Writes or checks the third-party notices of the info view.
//
//   node scripts/notices/generate.ts           write app/src/about/third-party.generated.ts and app/public/licenses/*.txt
//   node scripts/notices/generate.ts --check   exit 1 when a generated file is missing or out of date (for CI)
//
// Exit codes: 0 fine, 1 generated files differ from the real inputs, 2 an input is missing or inconsistent. A missing
// licence file is never skipped: the run stops with a message that names the file and how to get it.
// No dependencies besides Node itself.
import { mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNotices, compareWithDisk, NoticesError, readSources } from "./notices.ts";
import { checkVcRuntime } from "./vc-runtime.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const check = process.argv.includes("--check");

try {
  const sources = readSources(root);
  const result = buildNotices(root, sources);
  const vcrt = sources.entries.find((e) => e.id === "vcrt")?.from;
  if (vcrt?.kind === "static") {
    const vc = checkVcRuntime(vcrt.version);
    console.log(vc.message);
    if (vc.problems && vc.problems.length > 0) throw new NoticesError(vc.problems);
  }
  if (check) {
    const differences = compareWithDisk(root, sources, result);
    if (differences.length > 0) {
      console.error(`Third-party notices are out of date:\n- ${differences.join("\n- ")}\nRun "npm run notices" and commit the result.`);
      process.exit(1);
    }
    console.log(`Third-party notices are up to date (${result.entries.length} components, ${result.files.size} files).`);
  } else {
    for (const [rel, content] of result.files) {
      const file = join(root, ...rel.split("/"));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    // Remove texts of components that no longer exist.
    const dir = join(root, ...sources.output.textDir.split("/"));
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!result.files.has(`${sources.output.textDir}/${name}`)) rmSync(join(dir, name));
      }
    }
    console.log(`Wrote ${result.files.size} files for ${result.entries.length} components.`);
  }
} catch (error) {
  if (error instanceof NoticesError) {
    console.error(error.message);
    process.exit(2);
  }
  throw error;
}
