// Desktop transport for the UI: the native engine runs as a child process of the Electron main process; its
// frames reach the UI on a MessagePort the main process hands over through the preload bridge.
import type { EngineTransport, ExitInfo } from "../../client/transport.ts";
import type { DesktopBridge, EnginePortEnvelope, FromMain, ToMain } from "./desktop-bridge.ts";

const ports = new Map<number, MessagePort>();
const waiters = new Map<number, (p: MessagePort) => void>();
let listening = false;

function listenForPorts() {
  if (listening) return;
  listening = true;
  window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as Partial<EnginePortEnvelope> | null;
    if (e.source !== window || !d || d.halfcube !== "engine-port" || typeof d.generation !== "number") return;
    const port = e.ports[0];
    if (!port) return;
    const w = waiters.get(d.generation);
    if (w) {
      waiters.delete(d.generation);
      w(port);
    } else ports.set(d.generation, port);
  });
}

function portFor(generation: number, timeoutMs: number): Promise<MessagePort> {
  const ready = ports.get(generation);
  if (ready) {
    ports.delete(generation);
    return Promise.resolve(ready);
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      waiters.delete(generation);
      reject(new Error(`The main process did not hand over the engine connection within ${timeoutMs} ms.`));
    }, timeoutMs);
    waiters.set(generation, (p) => {
      clearTimeout(t);
      resolve(p);
    });
  });
}

/** Last measured main-process-to-UI hop (epoch clock of both processes; sub-millisecond values are approximate). */
export interface HopSample {
  ms: number;
  payloadBytes: number;
}

export class ElectronTransport implements EngineTransport {
  readonly kind = "native" as const;
  onMessage: ((header: string, payload: ArrayBuffer | null) => void) | null = null;
  onExit: ((info: ExitInfo) => void) | null = null;
  lastHop: HopSample | null = null;
  private port: MessagePort | null = null;
  private dead = false;
  private readonly bridge: DesktopBridge;

  constructor(bridge: DesktopBridge) {
    this.bridge = bridge;
    listenForPorts();
  }

  async start(): Promise<void> {
    const r = await this.bridge.startEngine();
    if (!r.ok) throw new Error(r.message);
    const port = await portFor(r.generation, 10_000);
    this.port = port;
    port.onmessage = (e: MessageEvent) => {
      const m = e.data as FromMain;
      if (m.kind === "msg") {
        this.lastHop = {
          ms: performance.timeOrigin + performance.now() - m.tMain,
          payloadBytes: m.payload ? m.payload.byteLength : 0,
        };
        this.onMessage?.(m.header, m.payload);
      } else if (m.kind === "exit") {
        if (this.dead) return;
        this.dead = true;
        port.close();
        this.onExit?.(m.info);
      }
    };
    port.start();
  }

  send(header: string, payload?: ArrayBuffer | null): void {
    if (!this.port || this.dead) throw new Error("The engine connection is closed.");
    const m: ToMain = { kind: "msg", header, payload: payload ?? null };
    this.port.postMessage(m, payload ? [payload] : []);
  }

  kill(): void {
    if (!this.port || this.dead) return;
    this.dead = true;
    const m: ToMain = { kind: "kill" };
    this.port.postMessage(m);
    this.port.close();
  }

  cancelRunning(): boolean {
    return false; // the native engine reads cancel messages while it computes
  }

  /** Test only: asks the main process to ignore liveness answers so its watchdog fires. */
  simulateHang(): void {
    const m: ToMain = { kind: "debugSimulateHang" };
    this.port?.postMessage(m);
  }
}
