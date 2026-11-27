// Starts the native engine as a child process and talks frames over its stdin/stdout (Node only: the Electron main
// process and the tests). Anonymous pipes: no port and no name that another process could open.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import { encodeFrame, FrameDecoder } from "../../app/src/engine/frame.ts";
import type { EngineTransport, ExitInfo } from "../../app/src/engine/transport.ts";

export interface NativeTransportOptions {
  /** Path of halfcube-engine(.exe). The OCCT libraries lie next to it. */
  exe: string;
  args?: string[];
  /** Keep at most this many characters of stderr for problem reports. */
  diagnosticsChars?: number;
}

/** Windows exit codes the engine can end with, and what they mean. */
const knownExitCodes: Record<number, string> = {
  0xc0000005: "access violation",
  0xc0000094: "integer division by zero",
  0xc00000fd: "stack overflow",
  0xc0000409: "fast-fail / buffer overrun check",
  0xc0000135: "a required DLL was not found next to the engine",
  0xc000007b: "a DLL has the wrong format (32-bit and 64-bit mixed)",
  0xc0000142: "a DLL failed to initialise",
  3: "abort()",
  2: "broken frame stream",
  64: "unknown command-line argument",
};

export function describeExit(code: number | null, signal: string | null): string {
  if (signal) return `The engine process was ended by signal ${signal}.`;
  if (code === null) return "The engine process ended without an exit code.";
  const hex = `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
  const what = knownExitCodes[code >>> 0];
  return `The engine process ended with exit code ${code} (${hex}${what ? `, ${what}` : ""}).`;
}

export class NativeTransport implements EngineTransport {
  readonly kind = "native" as const;
  onMessage: ((header: string, payload: ArrayBuffer | null) => void) | null = null;
  onExit: ((info: ExitInfo) => void) | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stderr = "";
  private killed = false;
  private reported = false;
  private readonly opts: NativeTransportOptions;

  constructor(opts: NativeTransportOptions) {
    this.opts = opts;
  }

  /** Process id, for diagnostics and tests. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  get diagnostics(): string {
    return this.stderr;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // cwd = the engine's folder, so its DLLs are found first; windowsHide: no console window.
      const child = spawn(this.opts.exe, this.opts.args ?? [], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        cwd: dirname(this.opts.exe),
      });
      this.child = child;
      const decoder = new FrameDecoder();
      const max = this.opts.diagnosticsChars ?? 65536;
      let spawned = false;

      child.stdout.on("data", (chunk: Buffer) => {
        let frames;
        try {
          frames = decoder.push(chunk);
        } catch (e) {
          this.report({ kind: "error", message: `Reading from the engine failed: ${(e as Error).message}` }, true);
          return;
        }
        for (const f of frames) this.onMessage?.(f.header, f.payload);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (text: string) => {
        this.stderr = (this.stderr + text).slice(-max);
      });
      child.once("spawn", () => {
        spawned = true;
        resolve();
      });
      child.on("error", (e) => {
        const message = `The engine could not be started (${this.opts.exe}): ${e.message}`;
        if (!spawned) reject(new Error(message));
        else this.report({ kind: "error", message }, true);
      });
      child.once("exit", (code, signal) => {
        // Let stderr drain before reporting.
        setImmediate(() => this.report({ kind: "exit", message: describeExit(code, signal), code, signal }, false));
      });
      // Writing to a dead process raises EPIPE on stdin; the exit event reports the cause.
      child.stdin.on("error", () => {});
    });
  }

  /** Reports the end of the engine once; nothing after a deliberate kill. */
  private report(info: ExitInfo, killChild: boolean): void {
    if (this.killed || this.reported) return;
    this.reported = true;
    if (killChild) this.child?.kill();
    this.onExit?.({ ...info, diagnostics: this.stderr });
  }

  send(header: string, payload?: ArrayBuffer | null): void {
    if (!this.child || this.killed || this.reported) throw new Error("The engine process is not running.");
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
}
