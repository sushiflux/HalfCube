// Engine session: connects the document store to the engine client. It mirrors recipe changes to the engine
// (setParameter when only parameters changed, loadRecipe otherwise), keeps at most one batch of recipe commands in
// flight and coalesces changes made meanwhile, drops stale replies, and recovers from engine crashes by starting a
// new engine and replaying the store's recipe.
import { EngineClient, EngineCrashedError, type Reply, type RequestHandle } from "../../client/engine-client.ts";
import type { EngineTransport, ExitInfo } from "../../client/transport.ts";
import { WorkerTransport, browserWorkerPort } from "../../client/worker-transport.ts";
import type { HelloResult, RebuildResult, Recipe, StepStatus } from "../../protocol/protocol.ts";
import { ElectronTransport } from "./electron-transport.ts";
import { errorText, type NoticeStore } from "./notices.ts";
import type { RecipeStore } from "./recipe-store.ts";

export type EngineKind = "native" | "wasm";
export type SessionStatus = "starting" | "ready" | "busy" | "restarting" | "failed";

export interface RecipeTiming {
  command: "loadRecipe" | "setParameter";
  recipeVersion: number;
  /** Client: from sending the command to having the reply (ms). */
  roundTripMs: number;
  /** Engine's own timings for the rebuild (ms). */
  engineTotalMs: number;
  engineRebuildMs: number;
  engineMeshMs: number;
  engineEncodeMs: number;
  /** roundTripMs - engineTotalMs: transport, queueing and decoding. */
  transportMs: number;
  payloadBytes: number;
  /** Desktop only: main process to UI hop of this reply (approximate, two process clocks). */
  hopMs?: number;
  /** From sending the command until the viewport has drawn the new mesh (next animation frame after render). */
  toFrameMs?: number;
}

export interface Snapshot {
  status: SessionStatus;
  kind: EngineKind;
  hello: HelloResult | null;
  steps: StepStatus[];
  result: RebuildResult | null;
  displayedVersion: number;
  crashes: number;
  staleDiscarded: number;
  supersededIgnored: number;
  startMs: number | null;
  instantiateMs: number | null;
  sharedCancel: boolean;
  lastTiming: RecipeTiming | null;
  lastRecoveryMs: number | null;
}

/** Called with every result that is current; resolves once the viewport has drawn it. */
export type DisplayFn = (result: RebuildResult, payload: ArrayBuffer) => Promise<void>;

export function exitText(info: ExitInfo): string {
  const lines = [info.message, `Kind: ${info.kind}`];
  if (info.code !== undefined && info.code !== null) lines.push(`Exit code: ${info.code}`);
  if (info.signal) lines.push(`Signal: ${info.signal}`);
  if (info.diagnostics && info.diagnostics.trim()) lines.push("", "Engine diagnostics (last output):", info.diagnostics.trimEnd());
  return lines.join("\n");
}

function sameStructure(a: Recipe, b: Readonly<Recipe>): boolean {
  const ka = Object.keys(a.parameters).sort().join("\u0000");
  const kb = Object.keys(b.parameters).sort().join("\u0000");
  return ka === kb && a.format === b.format && a.formatVersion === b.formatVersion && JSON.stringify(a.steps) === JSON.stringify(b.steps);
}

export class EngineSession {
  readonly client: EngineClient;
  readonly kind: EngineKind;
  display: DisplayFn | null = null;
  timings: RecipeTiming[] = [];
  /** Last current result with its payload, for a view that starts after it arrived. */
  lastResult: { result: RebuildResult; payload: ArrayBuffer } | null = null;
  private snap: Snapshot;
  private listeners = new Set<() => void>();
  private syncing = false;
  private dirty = false;
  private restarting = false;
  private transportRef: EngineTransport | null = null;
  private readonly store: RecipeStore;
  private readonly notices: NoticeStore;

  constructor(store: RecipeStore, notices: NoticeStore, kind: EngineKind) {
    this.store = store;
    this.notices = notices;
    this.kind = kind;
    this.snap = {
      status: "starting", kind, hello: null, steps: [], result: null, displayedVersion: -1, crashes: 0,
      staleDiscarded: 0, supersededIgnored: 0, startMs: null, instantiateMs: null, sharedCancel: false,
      lastTiming: null, lastRecoveryMs: null,
    };
    this.client = new EngineClient({
      clientName: "halfcube-architecture-spike-ui",
      createTransport: () => {
        this.transportRef = this.createTransport();
        return this.transportRef;
      },
      onCrash: (info) => this.onCrash(info),
    });
    store.subscribe(() => {
      this.dirty = true;
      void this.pump();
    });
  }

  // ------------------------------------------------------------ React binding

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.snap;
  private update(p: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...p };
    for (const l of [...this.listeners]) l();
  }

  // ------------------------------------------------------------ transports

  private createTransport(): EngineTransport {
    if (this.kind === "native") {
      const bridge = window.halfCubeDesktop;
      if (!bridge) throw new Error("The native engine is only available in the desktop program.");
      return new ElectronTransport(bridge);
    }
    return new WorkerTransport({
      createPort: () => browserWorkerPort(new URL("engine/engine-worker.mjs", document.baseURI)),
      moduleUrl: new URL("engine/halfcube-engine.mjs", document.baseURI).href,
      debugCommands: true,
      sharedCancel: true,
    });
  }

  private afterStart() {
    const t = this.transportRef;
    this.update({
      hello: this.client.hello,
      instantiateMs: t instanceof WorkerTransport ? t.instantiateMs : null,
      sharedCancel: t instanceof WorkerTransport ? t.hasSharedCancel : true,
    });
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    const t0 = performance.now();
    try {
      await this.client.start();
    } catch (e) {
      this.update({ status: "failed" });
      this.notices.push("error", "Die Engine konnte nicht gestartet werden", errorText(e));
      return;
    }
    this.update({ startMs: performance.now() - t0, status: "ready" });
    this.afterStart();
    this.dirty = true;
    await this.pump();
  }

  /** Sends the recipe changes the engine has not seen yet; loops until the store is quiet. */
  private async pump(): Promise<void> {
    if (this.syncing || this.restarting || !this.client.hello || !this.client.transport) return;
    this.syncing = true;
    this.update({ status: "busy" });
    try {
      while (this.dirty && !this.restarting && this.client.transport) {
        this.dirty = false;
        const sent = this.planCommands();
        await Promise.all(sent.map((s) => s.reply.then((r) => this.handleReply(r, s.command, s.sentAt, performance.now()))));
      }
    } catch (e) {
      // A crash is reported by onCrash; everything else is shown here.
      if (!(e instanceof EngineCrashedError)) this.notices.push("error", "Fehler beim Senden an die Engine", errorText(e));
    } finally {
      this.syncing = false;
      if (!this.restarting) this.update({ status: this.client.transport ? "ready" : "failed" });
    }
  }

  private planCommands(): { reply: Promise<Reply>; command: RecipeTiming["command"]; sentAt: number }[] {
    const cur = this.store.current;
    const mirror = this.client.recipe;
    const sentAt = performance.now();
    if (!mirror || !sameStructure(mirror, cur)) {
      return [{ reply: this.client.loadRecipe(structuredClone(cur) as Recipe).reply, command: "loadRecipe", sentAt }];
    }
    const out: { reply: Promise<Reply>; command: RecipeTiming["command"]; sentAt: number }[] = [];
    for (const [name, value] of Object.entries(cur.parameters)) {
      if (mirror.parameters[name] !== value) {
        out.push({ reply: this.client.setParameter(name, value).reply, command: "setParameter", sentAt });
      }
    }
    return out;
  }

  private handleReply(r: Reply, command: RecipeTiming["command"], sentAt: number, receivedAt: number) {
    if (r.stale) {
      this.update({ staleDiscarded: this.snap.staleDiscarded + 1 });
      return;
    }
    const m = r.message;
    if (m.type === "error") {
      if (m.code === "superseded" || m.code === "cancelled") {
        this.update({ supersededIgnored: this.snap.supersededIgnored + 1 });
        return;
      }
      this.notices.push("error", `Die Engine hat den Befehl abgelehnt (${m.code})`, m.message);
      return;
    }
    if (m.type !== "result") return;
    const hop = this.transportRef instanceof ElectronTransport ? this.transportRef.lastHop : null;
    const timing: RecipeTiming = {
      command,
      recipeVersion: m.recipeVersion,
      roundTripMs: receivedAt - sentAt,
      engineTotalMs: m.timings.totalMs,
      engineRebuildMs: m.timings.rebuildMs,
      engineMeshMs: m.timings.meshMs,
      engineEncodeMs: m.timings.encodeMs,
      transportMs: receivedAt - sentAt - m.timings.totalMs,
      payloadBytes: m.payloadBytes,
      ...(hop ? { hopMs: hop.ms } : {}),
    };
    this.timings.push(timing);
    if (r.payload) this.lastResult = { result: m, payload: r.payload };
    this.update({ steps: m.steps, result: m, displayedVersion: m.recipeVersion, lastTiming: timing });
    if (r.payload && this.display) {
      this.display(m, r.payload).then(
        () => {
          timing.toFrameMs = performance.now() - sentAt;
          if (this.snap.lastTiming === timing) this.update({ lastTiming: { ...timing } });
        },
        (e) => this.notices.push("error", "Die 3D-Ansicht konnte das Ergebnis nicht zeichnen", errorText(e)),
      );
    }
  }

  // ------------------------------------------------------------ crashes

  private crashAt = 0;

  private onCrash(info: ExitInfo) {
    this.notices.push("error", "Die Engine ist abgestürzt – sie wird neu gestartet", exitText(info));
    if (this.restarting) return; // a crash during recovery is handled by recover()
    this.restarting = true;
    this.crashAt = performance.now();
    this.update({ status: "restarting", crashes: this.snap.crashes + 1 });
    setTimeout(() => void this.recover(), 0);
  }

  private async recover() {
    try {
      // The UI owns the recipe: replay exactly what the store holds now.
      this.client.recipe = structuredClone(this.store.current) as Recipe;
      const sentAt = performance.now();
      const reply = await this.client.restart();
      this.afterStart();
      if (reply) this.handleReply(reply, "loadRecipe", sentAt, performance.now());
      const ms = performance.now() - this.crashAt;
      this.update({ lastRecoveryMs: ms, status: "ready" });
      this.notices.push(
        "info",
        "Engine neu gestartet",
        `Die Engine wurde neu gestartet und das Rezept (Version ${this.client.latestVersion}) neu eingespielt. ` +
          `Dauer vom Absturz bis zur Antwort: ${ms.toFixed(1)} ms.`,
      );
    } catch (e) {
      this.update({ status: "failed" });
      this.notices.push("error", "Die Engine konnte nicht neu gestartet werden", errorText(e));
    } finally {
      this.restarting = false;
    }
    if (this.dirty) void this.pump();
  }

  /** Manual restart after a failed recovery. */
  async restart(): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    this.crashAt = performance.now();
    this.update({ status: "restarting" });
    await this.recover();
  }

  // ------------------------------------------------------------ test commands

  /** Sends the engine's crash command. The reply never comes; the crash is reported through onCrash. */
  crash(mode: "abort" | "nullcall" | "intdiv") {
    if (!this.client.transport) return;
    this.client.request({ type: "debugCrash", mode }).reply.then(
      (r) => {
        if (r.message.type === "error") this.notices.push("error", `Absturz-Test abgelehnt (${r.message.code})`, r.message.message);
      },
      () => {},
    );
  }

  /** Desktop only: makes the main process's watchdog fire (it stops counting liveness answers). */
  simulateHang(): boolean {
    const t = this.transportRef;
    if (!(t instanceof ElectronTransport)) return false;
    t.simulateHang();
    return true;
  }

  /**
   * Test only: sends several setParameter commands back to back without waiting, bypassing coalescing, so that
   * all but the last reply are stale (or superseded). Resolves when all replies are in.
   */
  async burst(name: string, values: number[]): Promise<{ stale: number; shown: number }> {
    const staleBefore = this.snap.staleDiscarded;
    const shownBefore = this.timings.length;
    this.store.setParameterSilently(name, values[values.length - 1]!);
    const sentAt = performance.now();
    const handles: RequestHandle[] = values.map((v) => this.client.setParameter(name, v));
    await Promise.all(handles.map((h) => h.reply.then((r) => this.handleReply(r, "setParameter", sentAt, performance.now()))));
    return { stale: this.snap.staleDiscarded - staleBefore, shown: this.timings.length - shownBefore };
  }
}
