// Desktop transport for the page: the native engine runs as a child process of the Electron main process; its frames
// reach the page on a MessagePort that the main process creates and the preload script hands over (bridge.ts).
import type { EngineBridge, EnginePortEnvelope, FromMain, ToMain } from "../bridge.ts";
import type { EngineTransport, ExitInfo } from "../transport.ts";

/** Ports that arrived before anyone asked for them, and askers that arrived before their port, by generation. */
const ports = new Map<number, MessagePort>();
const waiters = new Map<number, (port: MessagePort) => void>();
let listening = false;

function listenForPorts(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as Partial<EnginePortEnvelope> | null;
    // Only the preload script of this very window may hand over a port.
    if (event.source !== window || !data || data.partcraft !== "engine-port" || typeof data.generation !== "number") return;
    const port = event.ports[0];
    if (!port) return;
    const waiter = waiters.get(data.generation);
    if (waiter) {
      waiters.delete(data.generation);
      waiter(port);
    } else {
      ports.set(data.generation, port);
    }
  });
}

function portFor(generation: number, timeoutMs: number): Promise<MessagePort> {
  const ready = ports.get(generation);
  if (ready) {
    ports.delete(generation);
    return Promise.resolve(ready);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(generation);
      reject(new Error(`The main process did not hand over the engine connection within ${timeoutMs} ms.`));
    }, timeoutMs);
    waiters.set(generation, (port) => {
      clearTimeout(timer);
      resolve(port);
    });
  });
}

/** Delivers the MessagePort of an engine start; the default waits for the preload script's hand-over. */
export type PortSource = (generation: number) => Promise<MessagePort>;

export class DesktopTransport implements EngineTransport {
  readonly kind = "native" as const;
  onMessage: ((header: string, payload: ArrayBuffer | null) => void) | null = null;
  onExit: ((info: ExitInfo) => void) | null = null;
  private port: MessagePort | null = null;
  private dead = false;
  private readonly bridge: EngineBridge;
  private readonly portSource: PortSource;

  /** portSource: tests supply the port directly; the program uses the default hand-over by the preload script. */
  constructor(bridge: EngineBridge, portSource?: PortSource) {
    this.bridge = bridge;
    this.portSource = portSource ?? ((generation) => portFor(generation, 10_000));
    if (!portSource) listenForPorts();
  }

  async start(): Promise<void> {
    const result = await this.bridge.startEngine();
    if (!result.ok) throw new Error(result.details ? `${result.message}\n${result.details}` : result.message);
    const port = await this.portSource(result.generation);
    this.port = port;
    port.onmessage = (event: MessageEvent) => {
      const message = event.data as FromMain;
      if (message.kind === "msg") {
        this.onMessage?.(message.header, message.payload);
      } else if (message.kind === "exit") {
        if (this.dead) return;
        this.dead = true;
        port.close();
        this.onExit?.(message.info);
      }
    };
    port.start();
  }

  send(header: string, payload?: ArrayBuffer | null): void {
    if (!this.port || this.dead) throw new Error("The engine connection is closed.");
    const message: ToMain = { kind: "msg", header, payload: payload ?? null };
    this.port.postMessage(message, payload ? [payload] : []);
  }

  kill(): void {
    if (!this.port || this.dead) return;
    this.dead = true;
    const message: ToMain = { kind: "kill" };
    this.port.postMessage(message);
    this.port.close();
  }

  cancelRunning(): boolean {
    return false; // the native engine reads cancel messages while it computes
  }
}
