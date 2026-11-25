// A worker thread that never answers (stands in for a module whose download hangs).
import { parentPort } from "node:worker_threads";

parentPort?.on("message", () => {});
setInterval(() => {}, 1 << 30);
