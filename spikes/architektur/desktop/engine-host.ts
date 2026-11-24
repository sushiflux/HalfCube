// Electron main process: owns the native engine process of one window, forwards its frames to the UI over a
// MessagePort and supervises it (exit detection and a liveness watchdog).
//
// Watchdog: after the UI's hello has been answered, the host sends its own ping every WATCHDOG_INTERVAL_MS and
// expects the pong within WATCHDOG_TIMEOUT_MS. The native engine answers pings while it computes (reader
// thread, capability pingWhileBusy), so a long rebuild does not trip it; a hang does. The host's ping ids count
// down from MAX_REQUEST_ID while the UI's ids count up from 1, so both stay unique on the one connection, and
// pongs for the host's ids are consumed here and never reach the UI.
import { MessageChannelMain, type MessagePortMain, type WebContents } from "electron";
import { NativeTransport } from "../client/native-transport.ts";
import type { ExitInfo } from "../client/transport.ts";
import { MAX_REQUEST_ID } from "../protocol/protocol.ts";
import type { FromMain, StartEngineResult, ToMain } from "../app/src/desktop-bridge.ts";

export interface EngineHostOptions {
  exe: string;
  debugCommands: boolean;
  watchdogIntervalMs?: number;
  watchdogTimeoutMs?: number;
  log?: (line: string) => void;
}

const WATCHDOG_ID_FLOOR = MAX_REQUEST_ID - 100_000_000;
const now = () => performance.timeOrigin + performance.now();

interface Running {
  generation: number;
  transport: NativeTransport;
  port: MessagePortMain;
  timer: NodeJS.Timeout | null;
  helloDone: boolean;
  /** Outstanding watchdog ping: id and send time (ms, performance.now). */
  ping: { id: number; sentAt: number } | null;
  ignorePongs: boolean;
  ended: boolean;
}

export class EngineHost {
  private generation = 0;
  private nextPingId = MAX_REQUEST_ID;
  private running: Running | null = null;
  private readonly opts: Required<Omit<EngineHostOptions, "log">> & Pick<EngineHostOptions, "log">;

  constructor(opts: EngineHostOptions) {
    this.opts = { watchdogIntervalMs: 1000, watchdogTimeoutMs: 5000, ...opts };
  }

  /** Starts a fresh engine for this window; an engine that is still running is killed first. */
  async start(target: WebContents): Promise<StartEngineResult> {
    this.killCurrent("replaced by a new start");
    const generation = ++this.generation;
    const transport = new NativeTransport({
      exe: this.opts.exe,
      args: this.opts.debugCommands ? ["--debug-commands"] : [],
    });
    try {
      await transport.start();
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    const { port1, port2 } = new MessageChannelMain();
    const r: Running = {
      generation, transport, port: port1, timer: null, helloDone: false, ping: null, ignorePongs: false, ended: false,
    };
    this.running = r;

    transport.onMessage = (header, payload) => this.fromEngine(r, header, payload);
    transport.onExit = (info) => this.end(r, info);
    port1.on("message", (e) => this.fromUi(r, e.data as ToMain));
    // The UI went away (reload, window closed): the engine has nobody to serve.
    port1.on("close", () => this.end(r, null));
    port1.start();
    target.postMessage("partcraft:engine-port", generation, [port2]);
    this.opts.log?.(`engine ${generation} started (pid ${transport.pid})`);
    return { ok: true, generation };
  }

  /** Graceful stop for app quit: shutdown command, then kill after timeoutMs. */
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
    await Promise.race([exited, new Promise((res) => setTimeout(res, timeoutMs))]);
    this.end(r, null);
  }

  private takePingId(): number {
    const id = this.nextPingId--;
    if (this.nextPingId < WATCHDOG_ID_FLOOR) this.nextPingId = MAX_REQUEST_ID;
    return id;
  }

  private fromUi(r: Running, m: ToMain) {
    if (r.ended) return;
    if (m.kind === "msg") {
      try {
        r.transport.send(m.header, m.payload);
      } catch (e) {
        this.end(r, { kind: "error", message: `Sending to the engine failed: ${(e as Error).message}` });
      }
    } else if (m.kind === "kill") {
      this.end(r, null);
    } else if (m.kind === "debugSimulateHang" && this.opts.debugCommands) {
      r.ignorePongs = true;
      this.opts.log?.(`engine ${r.generation}: watchdog test, ignoring liveness answers from now on`);
    }
  }

  private fromEngine(r: Running, header: string, payload: ArrayBuffer | null) {
    if (r.ended) return;
    // Headers are small JSON; only replyTo and type are needed here.
    let replyTo: number | null = null;
    let type = "";
    try {
      const h = JSON.parse(header) as { replyTo: number | null; type: string };
      replyTo = h.replyTo;
      type = h.type;
    } catch {
      // Forward as is; the client reports a header that is not JSON.
    }
    if (replyTo !== null && replyTo >= WATCHDOG_ID_FLOOR) {
      if (r.ping && replyTo === r.ping.id && !r.ignorePongs) r.ping = null;
      return;
    }
    if (type === "helloResult" && !r.helloDone) {
      r.helloDone = true;
      r.timer = setInterval(() => this.watchdog(r), this.opts.watchdogIntervalMs);
    }
    const msg: FromMain = { kind: "msg", header, payload, tMain: now() };
    // MessagePortMain can only transfer ports, so the payload is copied once into the renderer.
    r.port.postMessage(msg);
  }

  private watchdog(r: Running) {
    if (r.ended) return;
    const t = performance.now();
    if (r.ping) {
      if (t - r.ping.sentAt > this.opts.watchdogTimeoutMs) {
        this.end(r, {
          kind: "error",
          message:
            `The engine did not answer a liveness check (ping ${r.ping.id}) within ${this.opts.watchdogTimeoutMs} ms ` +
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

  /** Ends a running engine once. info === null: deliberate stop, no report to the UI. */
  private end(r: Running, info: ExitInfo | null) {
    if (r.ended) return;
    r.ended = true;
    if (r.timer) clearInterval(r.timer);
    r.transport.onExit = null;
    r.transport.onMessage = null;
    r.transport.kill();
    if (info) {
      this.opts.log?.(`engine ${r.generation} ended: ${info.message}`);
      const msg: FromMain = { kind: "exit", info };
      try {
        r.port.postMessage(msg);
      } catch {
        // UI already gone
      }
      // Give the exit report time to leave before the channel closes.
      setTimeout(() => r.port.close(), 250);
    } else {
      this.opts.log?.(`engine ${r.generation} stopped`);
      r.port.close();
    }
    if (this.running === r) this.running = null;
  }

  private killCurrent(reason: string) {
    const r = this.running;
    if (!r) return;
    this.opts.log?.(`engine ${r.generation}: ${reason}`);
    this.end(r, null);
  }
}
