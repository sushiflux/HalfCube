// Desktop transport: starts the native engine as a child process and talks frames over its stdin/stdout.
// Node only (Electron main process or tests). Anonymous pipes: no port, no name other processes could open.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { encodeFrame, FrameDecoder } from "../protocol/frame.ts";
import type { EngineTransport, ExitInfo } from "./transport.ts";

export interface NativeTransportOptions {
  /** Path of partcraft-engine(.exe). The OCCT DLLs lie next to it. */
  exe: string;
  args?: string[];
  /** Keep at most this many characters of stderr for crash reports. */
  diagnosticsChars?: number;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `The engine process was ended by signal ${signal}.`;
  if (code === null) return "The engine process ended without an exit code.";
  const hex = "0x" + (code >>> 0).toString(16).toUpperCase().padStart(8, "0");
  const known: Record<number, string> = {
    0xc0000005: "access violation",
    0xc0000094: "integer division by zero",
    0xc00000fd: "stack overflow",
    0xc0000409: "fast-fail / buffer overrun check",
    3: "abort()",
    2: "broken frame stream",
  };
  const what = known[code >>> 0];
  return `The engine process ended with exit code ${code} (${hex}${what ? ", " + what : ""}).`;
}

export class NativeTransport implements EngineTransport {
  readonly kind = "native" as const;
  onMessage: ((header: string, payload: ArrayBuffer | null) => void) | null = null;
  onExit: ((info: ExitInfo) => void) | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stderr = "";
  private killed = false;
  private readonly opts: NativeTransportOptions;

  constructor(opts: NativeTransportOptions) {
    this.opts = opts;
  }

  /** Process id, for tests and diagnostics. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.exe, this.opts.args ?? [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      this.child = child;
      const decoder = new FrameDecoder();
      const max = this.opts.diagnosticsChars ?? 65536;
      child.stdout.on("data", (chunk: Buffer) => {
        let frames;
        try {
          frames = decoder.push(chunk);
        } catch (e) {
          this.kill();
          this.onExit?.({ kind: "error", message: `Reading from the engine failed: ${(e as Error).message}`, diagnostics: this.stderr });
          return;
        }
        for (const f of frames) this.onMessage?.(f.header, f.payload);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (t: string) => {
        this.stderr = (this.stderr + t).slice(-max);
      });
      child.once("spawn", () => resolve());
      child.once("error", (e) => reject(new Error(`The engine could not be started (${this.opts.exe}): ${e.message}`)));
      child.once("exit", (code, signal) => {
        if (this.killed) return;
        // Let stderr drain before reporting.
        setImmediate(() =>
          this.onExit?.({ kind: "exit", message: describeExit(code, signal), code, signal, diagnostics: this.stderr }),
        );
      });
      // Writing to a dead process raises EPIPE on stdin; the exit event reports the cause.
      child.stdin.on("error", () => {});
    });
  }

  send(header: string, payload?: ArrayBuffer | null): void {
    if (!this.child) throw new Error("The engine transport is not started.");
    this.child.stdin.write(encodeFrame(header, payload));
  }

  /** Ends the engine's input; the engine cancels what is running and exits with code 0. */
  closeInput(): void {
    this.child?.stdin.end();
  }

  kill(): void {
    this.killed = true;
    this.child?.kill();
  }

  cancelRunning(): boolean {
    return false; // the native engine reads cancel messages while it computes
  }

  get diagnostics(): string {
    return this.stderr;
  }
}
