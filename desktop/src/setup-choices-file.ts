// Reads the installer's first-start file (see app/src/setup-choices.ts) in the main process. The page only ever gets the
// validated result; a missing, oversized, unreadable or malformed file yields null and one log line with the reason.
import { readFileSync, statSync } from "node:fs";
import { parseSetupChoices, type SetupChoices } from "../../app/src/setup-choices.ts";

/** The real file has about 60 bytes; anything larger is not ours. */
const MAX_BYTES = 4096;

export function readSetupChoices(file: string, log: (line: string) => void): SetupChoices | null {
  let info;
  try {
    info = statSync(file);
  } catch (e) {
    // No file is the normal case (nothing installed by our setup, or a repeated start).
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log(`setup choices ignored: cannot read ${file}: ${(e as Error).message}`);
    return null;
  }
  if (!info.isFile()) {
    log(`setup choices ignored: ${file} is not a file`);
    return null;
  }
  if (info.size > MAX_BYTES) {
    log(`setup choices ignored: ${file} is ${info.size} bytes, the limit is ${MAX_BYTES}`);
    return null;
  }
  let raw: unknown;
  try {
    // Strip a UTF-8 byte order mark: PowerShell and .NET writers like to add one.
    raw = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    log(`setup choices ignored: ${file} is not valid JSON: ${(e as Error).message}`);
    return null;
  }
  const choices = parseSetupChoices(raw);
  if (!choices) log(`setup choices ignored: ${file} does not have exactly the fields version 1, language de|en, colorMode light|dark`);
  return choices;
}
