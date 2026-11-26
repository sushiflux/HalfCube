// Replay stub for UI work without an engine: an EngineLink that answers sketch.solve and model.sync with answers
// recorded from the real engine (record.ts). It computes nothing; a request without a recording is refused with
// the list of what is recorded. Test and development use only, never shipped.
//
// Node:    new ReplayLink(loadAllRecordings())
// Browser: build the recordings from the JSON files (Vite imports them) and the .bin files fetched as ArrayBuffer.
import type { CommandInput, Reply, RequestHandle, RequestOptions } from "../../../app/src/engine/client.ts";
import type { EngineLink } from "../../../app/src/model/engine-link.ts";
import type { RecordedCase } from "./recording.ts";

export interface Recording {
  recorded: RecordedCase;
  payload: ArrayBuffer | null;
}

/** Stable text of a value with sorted keys, so key order does not matter for matching. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** What makes two requests the same for the engine (ids and revisions excluded, defaults filled in). */
export function requestKey(command: CommandInput): string | null {
  if (command.type === "sketch.solve") {
    return stable({ t: command.type, s: command.sketch, p: command.plane, d: command.diagnose ?? true, f: command.profiles ?? false, g: command.drag ?? null });
  }
  if (command.type === "model.sync") {
    return stable({ t: command.type, d: command.document, p: command.purpose, f: command.previewFeatures ?? [] });
  }
  return null;
}

export class ReplayLink implements EngineLink {
  private readonly byKey = new Map<string, Recording>();
  private readonly listeners = new Set<() => void>();
  private nextId = 1;
  /** Every request that was answered or refused, for tests. */
  readonly log: { type: string; recorded: string | null }[] = [];

  constructor(recordings: Recording[]) {
    for (const r of recordings) {
      const key = requestKey(r.recorded.command);
      if (key) this.byKey.set(key, r);
    }
  }

  isReady(): boolean {
    return true;
  }

  onReady(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Simulates an engine restart (the model layer sends its state again). */
  restart(): void {
    for (const l of [...this.listeners]) l();
  }

  request<C extends CommandInput>(command: C, _options?: RequestOptions): RequestHandle<C["type"]> {
    const id = this.nextId++;
    const key = requestKey(command);
    const hit = key ? this.byKey.get(key) : undefined;
    this.log.push({ type: command.type, recorded: hit?.recorded.name ?? null });
    if (!hit) {
      const names = [...this.byKey.values()].map((r) => r.recorded.name).join(", ");
      return {
        id,
        reply: Promise.reject(
          new Error(`The replay stub has no recorded answer for this ${command.type} request. Recorded: ${names}. Record new cases with tests/fixtures/engine/record.ts.`),
        ),
      };
    }
    const message = { ...hit.recorded.reply, replyTo: id } as Record<string, unknown>;
    if (command.type === "model.sync") message.revision = command.revision;
    const reply = { message, payload: hit.payload ? hit.payload.slice(0) : null } as unknown as Reply<C["type"]>;
    return { id, reply: Promise.resolve(reply) };
  }

  cancel(): void {}
}
