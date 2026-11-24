// Engine client: the only part of the UI that talks to the engine (concept 3.1). Request/reply correlation,
// progress callbacks, stale-version detection, crash handling with restart and recipe replay.
// The document store owns the recipe; the client keeps the last recipe it sent so it can replay it after a crash.
import {
  PROTOCOL_VERSION,
  type CommandWithoutId,
  type EngineMessage,
  type HelloResult,
  type ProgressEvent,
  type Recipe,
} from "../protocol/protocol.ts";
import type { EngineTransport, ExitInfo } from "./transport.ts";

export interface Reply {
  message: Exclude<EngineMessage, ProgressEvent>;
  payload: ArrayBuffer | null;
  /** The reply is for an older recipe version than the newest one sent; the UI must not show it. */
  stale: boolean;
}

export class EngineCrashedError extends Error {
  readonly info: ExitInfo;
  constructor(info: ExitInfo) {
    super(info.message);
    this.name = "EngineCrashedError";
    this.info = info;
  }
}

export interface RequestHandle {
  id: number;
  reply: Promise<Reply>;
}

interface Pending {
  resolve: (r: Reply) => void;
  reject: (e: Error) => void;
  onProgress?: (p: ProgressEvent) => void;
  recipeCommand: boolean;
}

export interface EngineClientOptions {
  createTransport: () => EngineTransport;
  clientName?: string;
  /** Called with every message from the engine, before it is dispatched (tests use it for schema checks). */
  onAnyMessage?: (message: EngineMessage, payload: ArrayBuffer | null) => void;
  /** Messages that cannot be matched to a request (errors about unreadable messages). */
  onUnsolicited?: (message: EngineMessage) => void;
  /** The engine died; pending requests are rejected with EngineCrashedError. */
  onCrash?: (info: ExitInfo) => void;
}

export class EngineClient {
  transport: EngineTransport | null = null;
  hello: HelloResult | null = null;
  /** Highest recipe version sent so far; replies for lower versions are stale. */
  latestVersion = -1;
  /** Copy of the recipe as last sent (with parameter changes applied), for replay after a crash. */
  recipe: Recipe | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private readonly opts: EngineClientOptions;

  constructor(opts: EngineClientOptions) {
    this.opts = opts;
  }

  async start(): Promise<HelloResult> {
    const t = this.opts.createTransport();
    this.transport = t;
    t.onMessage = (h, p) => this.dispatch(h, p);
    t.onExit = (info) => this.handleExit(info);
    await t.start();
    const r = await this.request({ type: "hello", protocol: PROTOCOL_VERSION, client: this.opts.clientName ?? "partcraft" }).reply;
    if (r.message.type !== "helloResult") {
      const text = r.message.type === "error" ? `${r.message.code}: ${r.message.message}` : JSON.stringify(r.message);
      throw new Error(`The engine refused the handshake: ${text}`);
    }
    this.hello = r.message;
    return r.message;
  }

  request(cmd: CommandWithoutId, onProgress?: (p: ProgressEvent) => void): RequestHandle {
    const t = this.transport;
    const id = this.nextId++;
    const recipeCommand = cmd.type === "loadRecipe" || cmd.type === "setParameter";
    const reply = new Promise<Reply>((resolve, reject) => {
      if (!t) { reject(new Error("The engine is not started.")); return; }
      this.pending.set(id, { resolve, reject, onProgress, recipeCommand });
      try {
        t.send(JSON.stringify({ ...cmd, id }));
      } catch (e) {
        this.pending.delete(id);
        reject(e as Error);
      }
    });
    return { id, reply };
  }

  /** Sends a header as given, for protocol tests (wrong ids, broken JSON). The reply arrives via onUnsolicited or the id. */
  sendRaw(header: string): void {
    this.transport?.send(header);
  }

  loadRecipe(recipe: Recipe, onProgress?: (p: ProgressEvent) => void): RequestHandle {
    this.recipe = structuredClone(recipe);
    const recipeVersion = ++this.latestVersion;
    return this.request({ type: "loadRecipe", recipeVersion, recipe }, onProgress);
  }

  setParameter(name: string, value: number, onProgress?: (p: ProgressEvent) => void): RequestHandle {
    if (this.recipe && name in this.recipe.parameters) this.recipe.parameters[name] = value;
    const recipeVersion = ++this.latestVersion;
    return this.request({ type: "setParameter", recipeVersion, name, value }, onProgress);
  }

  /** Cancels a request; for a WebAssembly rebuild that is running it also sets the shared cancel flag. */
  cancel(target: number): RequestHandle {
    this.transport?.cancelRunning(target);
    return this.request({ type: "cancel", target });
  }

  /** Throws away the engine (if any), starts a new one and replays the last recipe. */
  async restart(): Promise<Reply | null> {
    this.transport?.kill();
    this.rejectAll(new EngineCrashedError({ kind: "error", message: "The engine was restarted." }));
    this.transport = null;
    await this.start();
    if (!this.recipe) return null;
    return this.loadRecipe(this.recipe).reply;
  }

  /** Asks the engine to exit; kills it if it does not answer within timeoutMs. */
  async stop(timeoutMs = 2000): Promise<void> {
    const t = this.transport;
    if (!t) return;
    const bye = this.request({ type: "shutdown" }).reply.catch(() => null);
    await Promise.race([bye, new Promise((r) => setTimeout(r, timeoutMs))]);
    t.onExit = null;
    t.kill();
    this.transport = null;
  }

  private dispatch(header: string, payload: ArrayBuffer | null) {
    let msg: EngineMessage;
    try {
      msg = JSON.parse(header) as EngineMessage;
    } catch (e) {
      this.handleExit({ kind: "error", message: `The engine sent a header that is not JSON: ${(e as Error).message}` });
      return;
    }
    this.opts.onAnyMessage?.(msg, payload);
    const p = msg.replyTo !== null ? this.pending.get(msg.replyTo) : undefined;
    if (!p) { this.opts.onUnsolicited?.(msg); return; }
    if (msg.type === "progress") { p.onProgress?.(msg); return; }
    this.pending.delete(msg.replyTo!);
    p.resolve({ message: msg, payload, stale: p.recipeCommand && msg.recipeVersion < this.latestVersion });
  }

  private handleExit(info: ExitInfo) {
    this.transport = null;
    this.rejectAll(new EngineCrashedError(info));
    this.opts.onCrash?.(info);
  }

  private rejectAll(e: Error) {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(e);
  }
}
