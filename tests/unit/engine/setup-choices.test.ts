import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseSetupChoices } from "../../../app/src/setup-choices.ts";
import { readSetupChoices } from "../../../desktop/src/setup-choices-file.ts";

describe("parseSetupChoices", () => {
  const good = { version: 1, language: "de", colorMode: "dark" };

  it("accepts exactly the documented shape", () => {
    expect(parseSetupChoices(good)).toEqual(good);
    expect(parseSetupChoices({ version: 1, language: "en", colorMode: "light" })).toEqual({ version: 1, language: "en", colorMode: "light" });
  });

  it.each([
    ["null", null],
    ["a string", "de"],
    ["an array", [1, "de", "dark"]],
    ["another version", { ...good, version: 2 }],
    ["a string version", { ...good, version: "1" }],
    ["an unknown language", { ...good, language: "fr" }],
    ["a capitalised language", { ...good, language: "DE" }],
    ["an unknown colour mode", { ...good, colorMode: "auto" }],
    ["a missing field", { version: 1, language: "de" }],
    ["an extra field", { ...good, theme: "x" }],
    ["a non-string language", { ...good, language: 1 }],
  ])("rejects %s", (_name, value) => {
    expect(parseSetupChoices(value)).toBeNull();
  });

  it("rejects a __proto__ key smuggled in through JSON", () => {
    expect(parseSetupChoices(JSON.parse('{"version":1,"language":"de","colorMode":"dark","__proto__":{"x":1}}'))).toBeNull();
  });
});

describe("readSetupChoices", () => {
  const dir = mkdtempSync(join(tmpdir(), "partcraft-setup-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, content: string | Buffer) => {
    const file = join(dir, name);
    writeFileSync(file, content);
    return file;
  };
  const logs: string[] = [];
  const log = (l: string) => logs.push(l);

  it("reads a valid file, also with a UTF-8 byte order mark", () => {
    expect(readSetupChoices(write("ok.json", '{"version":1,"language":"en","colorMode":"light"}'), log)).toEqual({ version: 1, language: "en", colorMode: "light" });
    expect(readSetupChoices(write("bom.json", '﻿{"version":1,"language":"de","colorMode":"dark"}'), log)).toEqual({ version: 1, language: "de", colorMode: "dark" });
    expect(logs).toEqual([]);
  });

  it("returns null silently when there is no file", () => {
    expect(readSetupChoices(join(dir, "absent.json"), log)).toBeNull();
    expect(logs).toEqual([]);
  });

  it("ignores a malformed file with one log line that names the reason", () => {
    logs.length = 0;
    expect(readSetupChoices(write("broken.json", "{not json"), log)).toBeNull();
    expect(readSetupChoices(write("shape.json", '{"version":1,"language":"fr","colorMode":"dark"}'), log)).toBeNull();
    expect(readSetupChoices(write("big.json", Buffer.alloc(5000, 32)), log)).toBeNull();
    const folder = join(dir, "folder.json");
    mkdirSync(folder);
    expect(readSetupChoices(folder, log)).toBeNull();
    expect(logs).toHaveLength(4);
    expect(logs[0]).toMatch(/not valid JSON/);
    expect(logs[1]).toMatch(/does not have exactly the fields/);
    expect(logs[2]).toMatch(/is 5000 bytes, the limit is 4096/);
    expect(logs[3]).toMatch(/is not a file/);
  });
});
