// Engine client: the only part of the UI that talks to the engine (concept 3.1). Request/reply correlation, cancel,
// interim (progress) messages, dropping of superseded answers, per-command time limits (hang watchdog) and the
// bookkeeping of one engine connection. Starting after a crash is the caller's decision (see session.ts), the client
// only guarantees that every open request ends with an answer or a clear error when the engine goes away.
import {
  CLIENT_MAX_ID,
} from "./ids.ts";
import {
  IMMEDIATE_COMMAND_TYPES,
  PING_TIMEOUT_MS,
  PROTOCOL_VERSION,
  type Command,
  type CommandReplies,
  type CommandType,
  type EngineMessage,
  type EngineMessageType,
  type HelloResult,
} from "./generated/protocol.ts";
import {
  EngineCommandError,
  EngineCrashedError,
  EngineNotRunningError,
  EngineSupersededError,
} from "./errors.ts";
import type { EngineTransport, ExitInfo } from "./transport.ts";
import { CommandWatchdog, realClock, type ExpiredCommand, type WatchdogClock, type WatchdogLane } from "./watchdog.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A command as the caller writes it: everything except the request id, which the client assigns. */
export type CommandInput = DistributiveOmit<Command, "id">;

/** Message type of the successful answer of each command (null: the command never answers on success). */
export const REPLY_TYPE = {
  "hello": "helloResult",
  "ping": "pong",
  "cancel": "cancelResult",
  "shutdown": "bye",
  "diagnostics.kernelSelftest": "kernelSelftestResult",
  "diagnostics.solverSelftest": "solverSelftestResult",
  "diagnostics.crash": null,
  "diagnostics.hang": "hangResult",
} as const satisfies Record<CommandType, EngineMessageType | null>;

export interface Reply<T extends CommandType = CommandType> {
  message: CommandReplies[T];
  payload: ArrayBuffer | null;
}

export interface RequestHandle<T extends CommandType = CommandType> {
  /** The request id; pass it to cancel(). */
  id: number;
  /**
   * Resolves with the answer. Rejects with EngineCommandError (the engine answered with an error, also
   * cancelled), EngineCrashedError (the engine ended, hung or was restarted), EngineSupersededError (a newer request
   * with the same key replaced this one) or EngineNotRunningError.
   */
  reply: Promise<Reply<T>>;
}

export type ProgressHandler = (message: EngineMessage, payload: ArrayBuffer | null) => void;

export interface RequestOptions {
  /**
   * Time limit for this command in ms (0 = none). It starts when the engine starts working on the command, not while
   * the command waits in the queue. On expiry the engine is stopped and counted as hung.
   */
  timeoutMs?: number;
  /**
   * Requests with the same key replace each other: when a newer one is sent, the older one is rejected with
   * EngineSupersededError, its answer is dropped, and the engine is told to cancel it (unless the newer request sets
   * cancelSuperseded to false).
   * Use it for work that is redone on every change, such as a parameter drag.
   */
  supersedeKey?: string;
  /** Whether replacing older requests with the same key also cancels them in the engine. Default true. */
  cancelSuperseded?: boolean;
  /** Called for every message the engine sends for this request before its final answer. Also restarts the time limit. */
  onProgress?: ProgressHandler;
}

export interface EngineClientOptions {
  createTransport: () => EngineTransport;
  /** Names the client in the hello command (diagnostics only). */
  clientName?: string;
  /**
   * Time limit in ms for commands that have no entry in commandTimeoutsMs (0 = none). Default: none for the native
   * engine (the main process pings it), 60 000 for the WebAssembly engine, where nothing else can notice a hang.
   */
  defaultTimeoutMs?: number;
  commandTimeoutsMs?: Partial<Record<CommandType, number>>;
  /** Called with every message from the engine before it is dispatched (tests use it for schema checks). */
  onMessage?: (message: EngineMessage, payload: ArrayBuffer | null) => void;
  /** Messages that belong to no open request (errors about unreadable messages, late answers of unknown ids). */
  onUnsolicited?: (message: EngineMessage, payload: ArrayBuffer | null) => void;
  /** The engine died or hung; open requests are rejected with EngineCrashedError first. Not called for deliberate stops. */
  onExit?: (info: ExitInfo) => void;
  /** Clock and timers of the hang watchdog (tests inject a fake one). */
  clock?: WatchdogClock;
}

export type ClientState = "idle" | "starting" | "running" | "down";

interface Pending {
  type: CommandType;
  label: string;
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  onProgress: ProgressHandler | undefined;
  key: string | undefined;
  /**
   * The caller no longer waits (superseded, or an internal cancel): the engine's answer is still expected and
   * consumed here, but dropped.
   */
  abandoned: boolean;
}

/** Built-in limits of the quick commands, in ms. */
const QUICK_TIMEOUT_MS: Partial<Record<CommandType, number>> = {
  "hello": 15_000,
  "ping": PING_TIMEOUT_MS,
  "cancel": PING_TIMEOUT_MS,
  "shutdown": PING_TIMEOUT_MS,
};

const DEFAULT_WASM_TIMEOUT_MS = 60_000;

export class EngineClient {
  /** Result of the last successful handshake; null while no engine is running. */
  hello: HelloResult | null = null;
  private transport: EngineTransport | null = null;
  private _state: ClientState = "idle";
  private lastKind: "native" | "wasm" | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly opts: EngineClientOptions;
  private readonly watchdog: CommandWatchdog;

  constructor(opts: EngineClientOptions) {
    this.opts = opts;
    this.watchdog = new CommandWatchdog(opts.clock ?? realClock, (c) => this.onHang(c));
  }

  get state(): ClientState {
    return this._state;
  }

  /** Kind of the current engine connection, null when there is none. */
  get transportKind(): "native" | "wasm" | null {
    return this.transport?.kind ?? null;
  }

  /** Kind of the most recent connection, also after it ended (for problem reports). */
  get lastTransportKind(): "native" | "wasm" | null {
    return this.lastKind;
  }

  /** Requests still waiting for the engine (abandoned ones included, they are still expected to be answered). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Starts an engine and performs the hello handshake. Only allowed while no engine is running; use restart() to
   * replace a running one. Rejects with the complete cause when the engine cannot be started, dies during the
   * handshake or refuses it (EngineCommandError with the engine's own text).
   */
  async start(): Promise<HelloResult> {
    if (this._state === "starting" || this._state === "running") {
      throw new Error("The engine client is already started; call restart() to replace the engine.");
    }
    const transport = this.opts.createTransport();
    this.transport = transport;
    this.lastKind = transport.kind;
    this._state = "starting";
    this.hello = null;
    this.nextId = 1;
    this.watchdog.clear();
    transport.onMessage = (header, payload) => {
      if (this.transport === transport) this.dispatch(header, payload);
    };
    transport.onExit = (info) => {
      if (this.transport === transport) this.fail(info);
    };
    try {
      await transport.start();
      const reply = await this.request({ type: "hello", protocol: PROTOCOL_VERSION, client: this.opts.clientName ?? "partcraft" }).reply;
      if (this.transport !== transport) throw new EngineNotRunningError("The engine was stopped during the handshake.");
      this.hello = reply.message;
      this._state = "running";
      return reply.message;
    } catch (e) {
      if (this.transport === transport) {
        // A refused handshake leaves the engine alive; a failed start may have left a half-started one.
        this.transport = null;
        this._state = "down";
        this.watchdog.clear();
        transport.onMessage = null;
        transport.onExit = null;
        transport.kill();
        this.rejectAll(new EngineCrashedError({ kind: "error", message: "The engine start was aborted." }));
      }
      throw e;
    }
  }

  /** Stops the current engine (if any) without a report, then starts a new one. */
  async restart(): Promise<HelloResult> {
    this.kill("The engine was restarted.");
    return this.start();
  }

  /**
   * Sends a command. Never throws; every failure arrives through the promise. Request ids are assigned here.
   */
  request<C extends CommandInput>(command: C, options: RequestOptions = {}): RequestHandle<C["type"]> {
    const transport = this.transport;
    if (!transport || (this._state !== "starting" && this._state !== "running")) {
      return { id: 0, reply: Promise.reject(new EngineNotRunningError()) };
    }
    if (this.nextId > CLIENT_MAX_ID) {
      return {
        id: 0,
        reply: Promise.reject(new EngineNotRunningError("The request ids of this engine connection are used up; restart the engine.")),
      };
    }
    const id = this.nextId++;
    const type: CommandType = command.type;
    const label = `${type} (request ${id})`;
    if (options.supersedeKey !== undefined) this.supersede(options.supersedeKey, options.cancelSuperseded ?? true);

    const reply = new Promise<Reply>((resolve, reject) => {
      this.pending.set(id, { type, label, resolve, reject, onProgress: options.onProgress, key: options.supersedeKey, abandoned: false });
    });
    this.watch(id, type, label, transport.kind, options.timeoutMs);
    try {
      transport.send(JSON.stringify({ ...command, id }));
    } catch (e) {
      this.settleLocal(id, new EngineNotRunningError(`Sending ${label} to the engine failed: ${(e as Error).message}`));
    }
    return { id, reply };
  }

  /**
   * Cancels a queued or running command. The cancelled command itself answers with the error code "cancelled"
   * (its own request rejects with it). For a WebAssembly command that is running right now the shared cancel flag is
   * set first, because that engine cannot read messages while it computes.
   */
  cancel(target: number): RequestHandle<"cancel"> {
    this.transport?.cancelRunning(target);
    return this.request({ type: "cancel", target });
  }

  /** Sends a header exactly as given, for protocol tests (wrong ids, broken JSON). */
  sendRaw(header: string, payload?: ArrayBuffer | null): void {
    if (!this.transport) throw new EngineNotRunningError();
    this.transport.send(header, payload);
  }

  /**
   * Asks the engine to exit and waits for its goodbye; kills it when it does not answer within timeoutMs.
   * Open requests are rejected. No exit report is made.
   */
  async stop(timeoutMs = 2000): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    if (this._state === "running") {
      const bye = this.request({ type: "shutdown" }, { timeoutMs: 0 }).reply.catch(() => null);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([bye, timeout]);
      clearTimeout(timer);
    }
    if (this.transport === transport) this.kill("The engine was stopped.");
  }

  /** Hard stop without a report: kills the engine and rejects every open request. */
  kill(reason = "The engine was stopped."): void {
    const transport = this.transport;
    this.transport = null;
    this._state = "idle";
    this.hello = null;
    this.watchdog.clear();
    if (transport) {
      transport.onMessage = null;
      transport.onExit = null;
      transport.kill();
    }
    this.rejectAll(new EngineCrashedError({ kind: "error", message: reason }));
  }

  // ---------------------------------------------------------------------------------------------------- internals

  private timeoutFor(type: CommandType, kind: "native" | "wasm", requested: number | undefined): number {
    if (requested !== undefined) return requested;
    const own = this.opts.commandTimeoutsMs?.[type];
    if (own !== undefined) return own;
    const quick = QUICK_TIMEOUT_MS[type];
    if (quick !== undefined) return quick;
    return this.opts.defaultTimeoutMs ?? (kind === "wasm" ? DEFAULT_WASM_TIMEOUT_MS : 0);
  }

  private watch(id: number, type: CommandType, label: string, kind: "native" | "wasm", requested: number | undefined): void {
    // The WebAssembly engine works every message off in order; the native one answers hello, ping and cancel at once.
    const direct = kind === "native" && (IMMEDIATE_COMMAND_TYPES as readonly string[]).includes(type);
    const lane: WatchdogLane = direct ? "direct" : "serial";
    this.watchdog.add(id, label, this.timeoutFor(type, kind, requested), lane);
  }

  /** Abandons every open request with this key and tells the engine to stop working on it. */
  private supersede(key: string, cancelOld: boolean): void {
    for (const [id, p] of this.pending) {
      if (p.key !== key || p.abandoned) continue;
      p.abandoned = true;
      p.reject(new EngineSupersededError(id, key));
      if (cancelOld && this._state === "running") this.sendInternalCancel(id);
    }
  }

  private sendInternalCancel(target: number): void {
    const transport = this.transport;
    if (!transport || this.nextId > CLIENT_MAX_ID) return;
    transport.cancelRunning(target);
    const id = this.nextId++;
    const label = `cancel of request ${target} (request ${id})`;
    this.pending.set(id, {
      type: "cancel",
      label,
      resolve: () => {},
      reject: () => {},
      onProgress: undefined,
      key: undefined,
      abandoned: true,
    });
    this.watch(id, "cancel", label, transport.kind, undefined);
    try {
      transport.send(JSON.stringify({ type: "cancel", id, target }));
    } catch {
      this.settleLocal(id, undefined);
    }
  }

  /** Ends one request on the client side only (the engine never saw it). */
  private settleLocal(id: number, error: Error | undefined): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.watchdog.settle(id);
    if (error && !p.abandoned) p.reject(error);
  }

  private dispatch(header: string, payload: ArrayBuffer | null): void {
    let message: EngineMessage;
    try {
      message = JSON.parse(header) as EngineMessage;
      if (typeof message !== "object" || message === null || typeof message.type !== "string") {
        throw new Error("the header is not an object with a type");
      }
    } catch (e) {
      this.breakConnection({
        kind: "error",
        message: `The engine sent a message header that cannot be read (${(e as Error).message}). The connection was closed.`,
        diagnostics: header.slice(0, 500),
      });
      return;
    }
    this.opts.onMessage?.(message, payload);
    const id = message.replyTo;
    const entry = typeof id === "number" ? this.pending.get(id) : undefined;
    if (!entry || typeof id !== "number") {
      this.opts.onUnsolicited?.(message, payload);
      return;
    }
    const isError = message.type === "error";
    const isFinal = isError || message.type === REPLY_TYPE[entry.type];
    if (!isFinal) {
      // Interim message of a running command: the engine is alive, so the time limit starts over.
      this.watchdog.touch(id);
      if (!entry.abandoned) entry.onProgress?.(message, payload);
      return;
    }
    this.pending.delete(id);
    this.watchdog.settle(id);
    if (entry.abandoned) return; // a superseded answer or the answer of an internal cancel
    if (message.type === "error") entry.reject(new EngineCommandError(message, id));
    else entry.resolve({ message, payload });
  }

  private onHang(command: ExpiredCommand): void {
    const transport = this.transport;
    const seconds = (command.timeoutMs / 1000).toFixed(command.timeoutMs % 1000 === 0 ? 0 : 1);
    this.breakConnection({
      kind: "hang",
      message:
        `The engine did not answer ${command.label} within ${seconds} s (waited ${(command.sinceSentMs / 1000).toFixed(1)} s) ` +
        `and was stopped.` +
        (transport?.kind === "wasm" ? " The engine worker was terminated." : ""),
      diagnostics: transport?.diagnostics,
    });
  }

  /** The connection is unusable (hang, broken stream): stop the engine and report like a crash. */
  private breakConnection(info: ExitInfo): void {
    const transport = this.transport;
    if (!transport) return;
    const diagnostics = info.diagnostics ?? transport.diagnostics;
    transport.onMessage = null;
    transport.onExit = null;
    transport.kill();
    this.fail(diagnostics ? { ...info, diagnostics } : info);
  }

  /** The engine is gone for a reason nobody asked for. */
  private fail(info: ExitInfo): void {
    this.transport = null;
    this._state = "down";
    this.hello = null;
    this.watchdog.clear();
    this.rejectAll(new EngineCrashedError(info));
    this.opts.onExit?.(info);
  }

  private rejectAll(error: Error): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) if (!p.abandoned) p.reject(error);
  }
}
