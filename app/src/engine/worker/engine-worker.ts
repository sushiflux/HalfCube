// Entry point of the browser engine worker (a module worker; Vite bundles it, see transports/worker-transport.ts for
// how the page starts it). All logic lives in engine-worker-core.ts.
import { createEngineWorkerCore } from "./engine-worker-core.ts";
import type { FromWorker, ToWorker } from "./worker-protocol.ts";

/** The part of the worker global scope this file uses (the DOM library types `self` as a window). */
interface WorkerScope {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const core = createEngineWorkerCore({
  post: (message: FromWorker, transfer: Transferable[] = []) => scope.postMessage(message, transfer),
});
scope.onmessage = (event) => core.handle(event.data);
