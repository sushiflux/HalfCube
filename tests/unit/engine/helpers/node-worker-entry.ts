// Node worker thread that runs the real engine worker logic (app/src/engine/worker/engine-worker-core.ts) in place of
// the browser's module worker, so the contract tests load the real WebAssembly module through the real code path.
// Node strips the types of this file itself (the sources are erasable TypeScript).
import { parentPort, type Transferable as NodeTransferable } from "node:worker_threads";
import { createEngineWorkerCore } from "../../../../app/src/engine/worker/engine-worker-core.ts";
import type { FromWorker, ToWorker } from "../../../../app/src/engine/worker/worker-protocol.ts";

const port = parentPort;
if (!port) throw new Error("This file must run as a worker thread.");
const core = createEngineWorkerCore({
  post: (message: FromWorker, transfer: Transferable[] = []) => port.postMessage(message, transfer as unknown as NodeTransferable[]),
});
port.on("message", (message: ToWorker) => core.handle(message));
