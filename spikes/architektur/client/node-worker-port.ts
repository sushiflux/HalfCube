// Node adapter for WorkerTransport: runs engine-worker.mjs in a worker_thread (tests, benchmarks).
import { Worker } from "node:worker_threads";
import type { WorkerPort } from "./worker-transport.ts";

export function nodeWorkerPort(script: string | URL): WorkerPort {
  const w = new Worker(script);
  const port: WorkerPort = {
    postMessage: (m, t) => w.postMessage(m, (t ?? []) as ArrayBuffer[]),
    onmessage: null,
    onerror: null,
    terminate: () => {
      void w.terminate();
    },
  };
  w.on("message", (d) => port.onmessage?.(d));
  w.on("error", (e) => port.onerror?.(e));
  return port;
}
