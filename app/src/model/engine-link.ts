// What the model layer needs from the engine: send a command, cancel one, and learn when an engine is ready (at the
// first start and after every automatic restart). The real link wraps the engine session; tests and the UI's replay
// stub provide their own.
import type { CommandInput, RequestHandle, RequestOptions } from "../engine/client.ts";
import type { EngineSession } from "../engine/session.ts";

export interface EngineLink {
  isReady(): boolean;
  /** Called every time an engine becomes ready (first start and each restart). Returns the function that removes it. */
  onReady(listener: () => void): () => void;
  request<C extends CommandInput>(command: C, options?: RequestOptions): RequestHandle<C["type"]>;
  cancel(id: number): void;
}

/** The link to a running engine session. */
export function linkSession(session: EngineSession): EngineLink {
  return {
    isReady: () => session.getStatus().phase === "ready",
    onReady(listener) {
      let wasReady = session.getStatus().phase === "ready";
      return session.subscribe(() => {
        const ready = session.getStatus().phase === "ready";
        if (ready && !wasReady) listener();
        wasReady = ready;
      });
    },
    request: (command, options) => session.client.request(command, options),
    cancel: (id) => {
      session.client.cancel(id).reply.catch(() => undefined);
    },
  };
}

/** Time limits against a hung engine (the WebAssembly engine has nothing else that notices one). */
export const SKETCH_SOLVE_TIMEOUT_MS = 10_000;
export const MODEL_SYNC_TIMEOUT_MS = 60_000;
