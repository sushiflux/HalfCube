// Engine host of the Electron main process: starts the native engine as a child process for one window, forwards its
// frames to the page over a MessagePort and supervises it (exit detection and a liveness watchdog).
//
// Supervision: after the page's hello has been answered, the host pings the engine every PING_INTERVAL_MS and expects
// the pong within PING_TIMEOUT_MS. The native engine answers pings while it computes (reader thread, capability
// pingWhileBusy), so a long rebuild does not trip the watchdog; a frozen engine does. The host's ping ids count down
// from MAX_REQUEST_ID, the page's count up from 1 (ids.ts), and pongs for the host's ids are consumed here and never
// reach the page.
//
// Restart: the host never restarts the engine on its own, because the page has to repeat its handshake and decide what
// to redo. After a crash or hang the page gets an "exit" message and the port closes; the page's session (session.ts)
// asks for a new engine through start(), which kills a previous one of the same host first.
//
// This file has no Electron imports: the channel to the page is injected (engine-ipc.ts supplies the Electron one,
// the tests a Node one).
import type { FromMain, StartEngineResult, ToMain } from "../../app/src/engine/bridge.ts";
import { MAX_REQUEST_ID, PING_INTERVAL_MS, PING_TIMEOUT_MS } from "../../app/src/engine/generated/protocol.ts";
import { HOST_ID_FLOOR } from "../../app/src/engine/ids.ts";
import type { ExitInfo } from "../../app/src/engine/transport.ts";
import { NativeTransport } from "./native-transport.ts";

/** Main-process end of the channel to the page. */
export interface HostPort {
  postMessage(message: FromMain): void;
  /** Messages of the page; anything that is not a ToMain message must be handed over as is, the host checks it. */
  onMessage(handler: (message: unknown) => void): void;
  /** The page closed its end (reload, window closed). */
  onClose(handler: () => void): void;
  start(): void;
  close(): void;
}

export interface UiChannel {
  host: HostPort;
  /** Gives the page its end of the channel; generation names this engine start. */
  deliver(generation: number): void;
}

export type EngineLocation = { ok: true; exe: string } | { ok: false; message: string; details?: string };

export interface EngineHostOptions {
  /** Finds the engine program (engine-path.ts); called at every start. */
  locate: () => EngineLocation;
  createChannel: () => UiChannel;
  log?: (line: string) => void;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  /** Delay before the port closes after an exit report, so the report can leave first (ms). */
  closeDelayMs?: number;
}

interface Running {
  generation: number;
  transport: NativeTransport;
  port: HostPort;
  timer: NodeJS.Timeout | null;
  helloDone: boolean;
  /** Outstanding liveness ping: id and send time (performance.now). */
  ping: { id: number; sentAt: number } | null;
  ended: boolean;
}

const isPayload = (v: unknown): v is ArrayBuffer | ArrayBufferView | null => v === null || v instanceof ArrayBuffer || ArrayBuffer.isView(v);

function toArrayBuffer(v: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (v instanceof ArrayBuffer) return v;
  const copy = new Uint8Array(v.byteLength);
  copy.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  return copy.buffer;
}

export class EngineHost {
  private generation = 0;
  private nextPingId = MAX_REQUEST_ID;
  private running: Running | null = null;
  private readonly opts: EngineHostOptions;
  private readonly pingIntervalMs: number;
  private readonly pingTimeoutMs: number;

  constructor(opts: EngineHostOptions) {
    this.opts = opts;
    this.pingIntervalMs = opts.pingIntervalMs ?? PING_INTERVAL_MS;
    this.pingTimeoutMs = opts.pingTimeoutMs ?? PING_TIMEOUT_MS;
  }

  /** Process id of the running engine, for tests and diagnostics. */
  get pid(): number | undefined {
    return this.running?.transport.pid;
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  /** Starts a fresh engine for the page; an engine that is still running is killed first. */
  async start(): Promise<StartEngineResult> {
    this.killCurrent("replaced by a new start");
    const generation = ++this.generation;
    const where = this.opts.locate();
    if (!where.ok) {
      this.opts.log?.(`engine ${generation} not started: ${where.message}`);
      return where.details ? { ok: false, message: where.message, details: where.details } : { ok: false, message: where.message };
    }
    const transport = new NativeTransport({ exe: where.exe });
    try {
      await transport.start();
    } catch (e) {
      this.opts.log?.(`engine ${generation} could not be started: ${(e as Error).message}`);
      return { ok: false, message: (e as Error).message, details: `Engine program: ${where.exe}` };
    }
    // A newer start() may have run while this one waited for the process to spawn.
    if (generation !== this.generation) {
      transport.kill();
      return { ok: false, message: "A newer engine start replaced this one." };
    }
    const channel = this.opts.createChannel();
    const r: Running = { generation, transport, port: channel.host, timer: null, helloDone: false, ping: null, ended: false };
    this.running = r;

    transport.onMessage = (header, payload) => this.fromEngine(r, header, payload);
    transport.onExit = (info) => this.end(r, info);
    channel.host.onMessage((m) => this.fromUi(r, m));
    // The page went away (reload, window closed): the engine has nobody to serve.
    channel.host.onClose(() => this.end(r, null));
    channel.host.start();
    channel.deliver(generation);
    this.opts.log?.(`engine ${generation} started (pid ${transport.pid}, ${where.exe})`);
    return { ok: true, generation };
  }

  /** Graceful stop for program exit: shutdown command, then a kill after timeoutMs. */
  async stop(timeoutMs = 1500): Promise<void> {
    const r = this.running;
    if (!r || r.ended) return;
    const exited = new Promise<void>((resolve) => {
      r.transport.onExit = () => resolve();
    });
    try {
      r.transport.send(JSON.stringify({ type: "shutdown", id: this.takePingId() }));
    } catch {
      // already gone
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([exited, new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    clearTimeout(timer);
    this.end(r, null);
  }

  /** Kills the engine at once, without a report (program exit, window closed). */
  kill(): void {
    this.killCurrent("killed");
  }

  private takePingId(): number {
    const id = this.nextPingId--;
    if (this.nextPingId < HOST_ID_FLOOR) this.nextPingId = MAX_REQUEST_ID;
    return id;
  }

  private fromUi(r: Running, raw: unknown): void {
    if (r.ended) return;
    const m = raw as Partial<ToMain> | null;
    if (m && m.kind === "kill") {
      this.end(r, null);
      return;
    }
    if (!m || m.kind !== "msg" || typeof m.header !== "string" || !isPayload(m.payload ?? null)) {
      this.opts.log?.(`engine ${r.generation}: ignored a message from the page that is not a valid engine message`);
      return;
    }
    try {
      r.transport.send(m.header, m.payload ? toArrayBuffer(m.payload) : null);
    } catch (e) {
      this.end(r, { kind: "error", message: `Sending to the engine failed: ${(e as Error).message}`, diagnostics: r.transport.diagnostics });
    }
  }

  private fromEngine(r: Running, header: string, payload: ArrayBuffer | null): void {
    if (r.ended) return;
    // Headers are small JSON; only replyTo and type are needed here.
    let replyTo: number | null = null;
    let type = "";
    try {
      const h = JSON.parse(header) as { replyTo?: number | null; type?: string };
      replyTo = h.replyTo ?? null;
      type = h.type ?? "";
    } catch {
      // Forwarded as is; the page's client reports a header that is not JSON.
    }
    if (replyTo !== null && replyTo >= HOST_ID_FLOOR) {
      if (r.ping && replyTo === r.ping.id) r.ping = null;
      return;
    }
    if (type === "helloResult" && !r.helloDone) {
      r.helloDone = true;
      r.timer = setInterval(() => this.watchdog(r), this.pingIntervalMs);
    }
    // MessagePortMain can only transfer ports, so the payload is copied once into the page.
    r.port.postMessage({ kind: "msg", header, payload });
  }

  private watchdog(r: Running): void {
    if (r.ended) return;
    const t = performance.now();
    if (r.ping) {
      if (t - r.ping.sentAt > this.pingTimeoutMs) {
        this.end(r, {
          kind: "hang",
          message:
            `The engine did not answer a liveness check (ping ${r.ping.id}) within ${this.pingTimeoutMs / 1000} s ` +
            `and was stopped. Its process id was ${r.transport.pid ?? "unknown"}.`,
          diagnostics: r.transport.diagnostics,
        });
      }
      return;
    }
    const id = this.takePingId();
    r.ping = { id, sentAt: t };
    try {
      r.transport.send(JSON.stringify({ type: "ping", id }));
    } catch {
      // The exit event reports the cause.
    }
  }

  /** Ends a running engine once. info === null: deliberate stop, no report to the page. */
  private end(r: Running, info: ExitInfo | null): void {
    if (r.ended) return;
    r.ended = true;
    if (r.timer) clearInterval(r.timer);
    r.transport.onExit = null;
    r.transport.onMessage = null;
    r.transport.kill();
    if (this.running === r) this.running = null;
    if (info) {
      this.opts.log?.(`engine ${r.generation} ended: ${info.message}`);
      try {
        r.port.postMessage({ kind: "exit", info });
      } catch {
        // page already gone
      }
      // Give the exit report time to leave before the channel closes.
      setTimeout(() => r.port.close(), this.opts.closeDelayMs ?? 250).unref();
    } else {
      this.opts.log?.(`engine ${r.generation} stopped`);
      r.port.close();
    }
  }

  private killCurrent(reason: string): void {
    const r = this.running;
    if (!r) return;
    this.opts.log?.(`engine ${r.generation}: ${reason}`);
    this.end(r, null);
  }
}
