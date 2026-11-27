import { branding } from "../../branding.ts";
// Parsing and formatting for the crash page. Pure and dependency-free: the crash page must work even when the rest of
// the app is what broke.

export interface StackFrame {
  /** The original line, trimmed. */
  raw: string;
  functionName: string | undefined;
  file: string | undefined;
  line: number | undefined;
  column: number | undefined;
  isAsync: boolean;
}

const v8Frame = /^at\s+(?:(async)\s+)?(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/;

/** Parses a JavaScript stack (the Chromium format of the Electron renderer) into frames; lines that are no frames are skipped. */
export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const rawLine of stack.split(/\r?\n/)) {
    const raw = rawLine.trim();
    if (raw === "") continue;
    const v8 = v8Frame.exec(raw);
    if (v8) {
      frames.push({
        raw,
        functionName: v8[2],
        file: v8[3],
        line: Number(v8[4]),
        column: Number(v8[5]),
        isAsync: v8[1] === "async",
      });
      continue;
    }
    // "at <anonymous>" and similar: a frame without a location.
    if (raw.startsWith("at ")) {
      frames.push({ raw, functionName: raw.slice(3), file: undefined, line: undefined, column: undefined, isAsync: false });
    }
  }
  return frames;
}

/** The component names of React's component stack, innermost first. */
export function parseComponentStack(componentStack: string | undefined): string[] {
  return parseStack(componentStack)
    .map((frame) => frame.functionName)
    .filter((name): name is string => name !== undefined && name !== "");
}

/** The function that threw: the first frame with a name. */
export function throwingFunction(frames: readonly StackFrame[]): string | undefined {
  return frames.find((f) => f.functionName !== undefined && f.functionName !== "")?.functionName;
}

/** "src/App.tsx:12:5" from a full URL, for display. */
export function shortLocation(frame: StackFrame): string {
  if (!frame.file) return frame.raw;
  const file = frame.file.replace(/^[a-z]+:\/\/[^/]*\//i, "").replace(/\?.*$/, "");
  return `${file}${frame.line === undefined ? "" : `:${frame.line}`}${frame.column === undefined ? "" : `:${frame.column}`}`;
}

export interface CrashEnvironment {
  version: string;
  channel: string;
  userAgent: string;
  url: string;
  viewport: string;
  platform: string;
  language: string;
  time: string;
}

export interface CrashReport {
  name: string;
  message: string;
  stack: string | undefined;
  componentStack: string | undefined;
  environment: CrashEnvironment;
}

/** Plain-text report with everything the diagnostic console shows. Always English. */
export function buildCrashReport(report: CrashReport): string {
  const { environment: env } = report;
  const lines = [
    `${branding.name} crashed: ${report.name}: ${report.message}`,
    "",
    `Version:   ${env.version}`,
    `Channel:   ${env.channel}`,
    `Time:      ${env.time}`,
    `Platform:  ${env.platform}`,
    `Language:  ${env.language}`,
    `URL:       ${env.url}`,
    `Viewport:  ${env.viewport}`,
    `UserAgent: ${env.userAgent}`,
    "",
    "Stack:",
    report.stack?.trim() || "(no stack)",
    "",
    "Component stack:",
    report.componentStack?.trim() || "(no component stack)",
  ];
  return lines.join("\n");
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

export function collectEnvironment(version: string, channel: string): CrashEnvironment {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    version,
    channel,
    userAgent: safe(() => navigator.userAgent, "unknown"),
    url: safe(() => location.href, "unknown"),
    viewport: safe(() => `${window.innerWidth} x ${window.innerHeight} (devicePixelRatio ${window.devicePixelRatio})`, "unknown"),
    platform: safe(() => navigator.platform, "unknown"),
    language: safe(() => navigator.languages.join(", "), "unknown"),
    time: `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`,
  };
}
