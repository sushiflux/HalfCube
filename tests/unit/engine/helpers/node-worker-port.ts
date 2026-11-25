// Adapter that lets the browser WorkerTransport run on a Node worker thread (tests).
import { Worker, type Transferable as NodeTransferable } from "node:worker_threads";
import type { WorkerPort } from "../../../../app/src/engine/transports/worker-transport.ts";
import type { FromWorker } from "../../../../app/src/engine/worker/worker-protocol.ts";

export const nodeWorkerEntry = new URL("./node-worker-entry.ts", import.meta.url);

export function nodeWorkerPort(script: URL = nodeWorkerEntry): WorkerPort {
  const worker = new Worker(script);
  const port: WorkerPort = {
    postMessage: (message, transfer) => worker.postMessage(message, (transfer ?? []) as unknown as NodeTransferable[]),
    onmessage: null,
    onerror: null,
    terminate: () => {
      void worker.terminate();
    },
  };
  worker.on("message", (data: FromWorker) => port.onmessage?.(data));
  worker.on("error", (e) => port.onerror?.(e));
  return port;
}
