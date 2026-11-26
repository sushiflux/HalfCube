// Format of a recorded engine answer and the comparison used by the contract tests. Timings are never compared.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../../config/build-info.ts";
import type { CommandInput } from "../../../app/src/engine/client.ts";
import type { ModelResult, SketchSolveResult } from "../../../app/src/engine/generated/protocol.ts";

export interface RecordedCase {
  name: string;
  recordedWith: { engine: string; platform: string; os: string };
  command: CommandInput;
  reply: SketchSolveResult | ModelResult;
  /** File name of the payload next to the JSON file, or null. */
  payload: string | null;
}

export const fixtureDir = join(repoRoot, "tests", "fixtures", "engine");

export function loadRecording(name: string): { recorded: RecordedCase; payload: ArrayBuffer | null } {
  const recorded = JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), "utf8")) as RecordedCase;
  if (!recorded.payload) return { recorded, payload: null };
  const bytes = readFileSync(join(fixtureDir, recorded.payload));
  return { recorded, payload: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

/** Every recording in the fixture folder (for the replay stub in Node). */
export function loadAllRecordings(): { recorded: RecordedCase; payload: ArrayBuffer | null }[] {
  return readdirSync(fixtureDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => loadRecording(f.slice(0, -".json".length)));
}

const TIMING_KEYS = new Set(["timeMs", "profilesMs", "ms", "timings", "replyTo", "cached", "revision"]);

/**
 * Differences between two answers: numbers within tolerance (absolute 1e-6 for coordinates, relative 1e-9 for
 * volume and area, as the test plan asks), everything else equal. Timings, cache flags and ids are left out.
 */
export function answerDifferences(actual: unknown, expected: unknown, path = "$"): string[] {
  if (typeof expected === "number" && typeof actual === "number") {
    const key = path.slice(path.lastIndexOf(".") + 1);
    const relative = key === "volume" || key === "area" || key === "expectedVolume";
    const tolerance = relative ? 1e-9 * Math.max(1, Math.abs(expected)) : 1e-6;
    return Math.abs(actual - expected) <= tolerance ? [] : [`${path}: ${actual} instead of ${expected}`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: not an array`];
    if (actual.length !== expected.length) return [`${path}: ${actual.length} entries instead of ${expected.length}`];
    return expected.flatMap((e, i) => answerDifferences(actual[i], e, `${path}[${i}]`));
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return [`${path}: not an object`];
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    const keys = new Set([...Object.keys(a), ...Object.keys(e)].filter((k) => !TIMING_KEYS.has(k)));
    return [...keys].flatMap((k) => answerDifferences(a[k], e[k], `${path}.${k}`));
  }
  return actual === expected ? [] : [`${path}: ${JSON.stringify(actual)} instead of ${JSON.stringify(expected)}`];
}
