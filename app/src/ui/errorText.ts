// The text of an error as the user can copy it: headline with code, the details, then one line with the code, the app
// version, where it happened and when. Pure, so the crash page (which must not depend on anything else) can use it too.

export interface ErrorBlock {
  /** "text" is a sentence or paragraph, "code" is a path, a command or a log line (monospace, no wrapping rules). */
  kind: "text" | "code";
  text: string;
}

export interface ErrorReport {
  headline: string;
  code: string;
  blocks: readonly ErrorBlock[];
  /** Readable app version with channel symbol, e.g. "v2026.11.5.13.12369 (</>)". */
  version: string;
  /** e.g. "Browser" or "Desktop win32". */
  environment: string;
  /** Already formatted time of the error. */
  time: string;
}

export function metaLine(report: Pick<ErrorReport, "code" | "version" | "environment" | "time">): string {
  return `${report.code} · ${report.version} · ${report.environment} · ${report.time}`;
}

/** Everything that belongs to the error, also what is folded away on screen. */
export function buildErrorText(report: ErrorReport): string {
  const parts = [`${report.headline} (${report.code})`];
  const details = report.blocks.map((b) => b.text.trim()).filter((t) => t !== "");
  if (details.length > 0) parts.push(details.join("\n"));
  parts.push(metaLine(report));
  return parts.join("\n\n");
}
