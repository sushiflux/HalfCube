// What the build bakes in for the update function: the channel changelog (vite.config.ts defines __HC_CHANGELOG__; where it is not
// defined, in unit tests and the e2e harness, it reads as empty). The demo switch __HC_UPDATES_DEMO__ is read in runtime.ts.

declare const __HC_CHANGELOG__: string | undefined;

/**
 * The channel's customer changelog as shipped in this bundle (CHANGELOG.nightly.md, CHANGELOG.beta.md or CHANGELOG.md,
 * chosen at build time; a dev build reads the nightly file). Empty when the file does not exist.
 */
export function bundledChangelog(): string {
  return typeof __HC_CHANGELOG__ === "string" ? __HC_CHANGELOG__ : "";
}
