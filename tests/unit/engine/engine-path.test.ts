import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { executableName, resolveEngineExecutable, sessionDataDir, setupChoicesPath } from "../../../desktop/src/engine-path.ts";

const base = {
  packaged: false,
  resourcesPath: "C:\\Programs\\Partcraft\\current\\resources",
  repoRoot: "G:\\work\\partcraft",
  platform: "win32" as const,
  env: {} as Record<string, string | undefined>,
};

describe("resolveEngineExecutable", () => {
  it("packaged: only resources/engine, whatever the environment says", () => {
    const wanted = join(base.resourcesPath, "engine", "partcraft-engine.exe");
    const seen: string[] = [];
    const r = resolveEngineExecutable({ ...base, packaged: true, env: { PARTCRAFT_ENGINE_EXE: "C:\\evil.exe" }, exists: (p) => (seen.push(p), p === wanted) });
    expect(r).toEqual({ ok: true, exe: wanted, source: "installed program" });
    expect(seen).toEqual([wanted]);
  });

  it("packaged: names the expected path when the program is missing", () => {
    const r = resolveEngineExecutable({ ...base, packaged: true, exists: () => false });
    expect(r).toMatchObject({
      ok: false,
      message: expect.stringContaining(join(base.resourcesPath, "engine", "partcraft-engine.exe")),
    });
    expect(r).toMatchObject({ message: expect.stringContaining("Reinstall") });
  });

  it("development: the release build first, the testing build as fallback", () => {
    const release = join(base.repoRoot, "engine", "_build", "windows-release", "bin", "partcraft-engine.exe");
    const testing = join(base.repoRoot, "engine", "_build", "windows-release-testing", "bin", "partcraft-engine.exe");
    expect(resolveEngineExecutable({ ...base, exists: () => true })).toMatchObject({ ok: true, exe: release, source: "release build" });
    expect(resolveEngineExecutable({ ...base, exists: (p) => p === testing })).toMatchObject({ ok: true, exe: testing });
  });

  it("development: PARTCRAFT_ENGINE_EXE wins and is the only candidate", () => {
    const r = resolveEngineExecutable({ ...base, env: { PARTCRAFT_ENGINE_EXE: "D:\\x\\engine.exe" }, exists: (p) => p.endsWith("engine.exe") });
    expect(r).toMatchObject({ ok: true, source: "PARTCRAFT_ENGINE_EXE" });
    const missing = resolveEngineExecutable({ ...base, env: { PARTCRAFT_ENGINE_EXE: "D:\\x\\engine.exe" }, exists: () => false });
    expect(missing.ok).toBe(false);
    expect(missing).toMatchObject({ ok: false, details: `Looked for: ${resolve("D:\\x\\engine.exe")}` });
  });

  it("development: lists everything it looked at when nothing exists", () => {
    const r = resolveEngineExecutable({ ...base, exists: () => false });
    expect(r).toMatchObject({
      ok: false,
      message: expect.stringContaining("build-windows.ps1"),
      details: expect.stringContaining("windows-release-testing"),
    });
    expect(r).toMatchObject({ details: expect.stringContaining(join("engine", "_build", "windows-release", "bin")) });
  });

  it("uses the executable name of the platform", () => {
    expect(executableName("win32")).toBe("partcraft-engine.exe");
    expect(executableName("linux")).toBe("partcraft-engine");
  });
});

describe("sessionDataDir", () => {
  const input = { packaged: true, platform: "win32" as const, env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, productName: "Partcraft" };

  it("is the local product folder on a packaged Windows program", () => {
    expect(sessionDataDir(input)).toBe(join("C:\\Users\\a\\AppData\\Local", "Partcraft", "session"));
  });

  it.each([
    ["not packaged", { ...input, packaged: false }],
    ["another platform", { ...input, platform: "linux" as const }],
    ["an own user data folder (tests)", { ...input, env: { ...input.env, PARTCRAFT_USER_DATA: "D:\\t" } }],
    ["no LOCALAPPDATA", { ...input, env: {} }],
  ])("keeps the default for %s", (_name, value) => {
    expect(sessionDataDir(value)).toBeNull();
  });
});

describe("setupChoicesPath", () => {
  const input = { appData: "C:\\Users\\a\\AppData\\Roaming", productName: "Partcraft", packaged: true, env: {} as Record<string, string | undefined> };

  it("is setup-choices.json in the roaming product folder", () => {
    expect(setupChoicesPath(input)).toBe(join("C:\\Users\\a\\AppData\\Roaming", "Partcraft", "setup-choices.json"));
  });

  it("accepts another file only when the program is not packaged", () => {
    const env = { PARTCRAFT_SETUP_CHOICES_FILE: "D:\\t\\choices.json" };
    expect(setupChoicesPath({ ...input, packaged: false, env })).toBe(join("D:\\t\\choices.json"));
    expect(setupChoicesPath({ ...input, packaged: true, env })).toBe(join("C:\\Users\\a\\AppData\\Roaming", "Partcraft", "setup-choices.json"));
  });
});
