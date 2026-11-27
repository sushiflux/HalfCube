// Build-time information shared by the Vite configs and the tests: version id from version.txt, channel from the
// environment, ports from config/dev-ports.json. Node only; the UI never imports this file.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseChannel, parseVersionFile, parseVersionId, type BuildInfo } from "../app/src/version.ts";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Reads version.txt (line 2) and HALFCUBE_CHANNEL. Fails loudly when either is invalid.
 * HALFCUBE_VERSION_ID replaces the id of version.txt; only scripts/build-installer.ps1 sets it (-VersionId, local update tests).
 */
export function readBuildInfo(root: string = repoRoot, env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const override = (env.HALFCUBE_VERSION_ID ?? "").trim();
  const id = override === "" ? parseVersionFile(readFileSync(join(root, "version.txt"), "utf8")) : parseVersionId(override);
  return { id, channel: parseChannel(env.HALFCUBE_CHANNEL) };
}

export type DevPortName = "web-dev" | "web-preview" | "e2e-cdp";

/** The dev ports from config/dev-ports.json, the single source for Vite, the start script and the tests. */
export function readDevPorts(root: string = repoRoot): Record<DevPortName, number> {
  const raw = JSON.parse(readFileSync(join(root, "config", "dev-ports.json"), "utf8")) as Record<string, unknown>;
  const ports = {} as Record<DevPortName, number>;
  for (const name of ["web-dev", "web-preview", "e2e-cdp"] as const) {
    const value = raw[name];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1024 || value > 65535) {
      throw new Error(`config/dev-ports.json: "${name}" must be an integer port between 1024 and 65535.`);
    }
    ports[name] = value;
  }
  return ports;
}
