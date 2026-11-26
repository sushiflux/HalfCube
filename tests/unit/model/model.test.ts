// LatestOnly, ModelSync and the replay stub, without an engine process.
import { describe, expect, it } from "vitest";
import type { Reply } from "../../../app/src/engine/client.ts";
import { EngineCrashedError } from "../../../app/src/engine/errors.ts";
import { DocumentStore } from "../../../app/src/document/store.ts";
import type { EngineLink } from "../../../app/src/model/engine-link.ts";
import { LatestOnly } from "../../../app/src/model/latest-only.ts";
import { ModelSync } from "../../../app/src/model/model-sync.ts";
import { document, rectangle } from "../../fixtures/engine/cases.ts";
import { loadAllRecordings } from "../../fixtures/engine/recording.ts";
import { ReplayLink } from "../../fixtures/engine/replay.ts";
import { ManualClock } from "../engine/helpers/manual-clock.ts";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function lane(clock = new ManualClock()) {
  const sent: { request: string; id: number; answer: ReturnType<typeof deferred<string>> }[] = [];
  const cancelled: number[] = [];
  let id = 0;
  const l = new LatestOnly<string, string>({
    clock,
    send: (request) => {
      const answer = deferred<string>();
      sent.push({ request, id: ++id, answer });
      return { id, reply: answer.promise };
    },
    cancel: (target) => cancelled.push(target),
  });
  return { l, sent, cancelled, clock };
}

describe("LatestOnly", () => {
  it("keeps one request in flight and one waiting; the newest wins and stale answers are dropped", async () => {
    const { l, sent } = lane();
    const a = l.submit("a");
    const b = l.submit("b");
    const c = l.submit("c");
    expect(sent.map((s) => s.request)).toEqual(["a"]);
    expect(await b).toEqual({ kind: "superseded" }); // replaced while waiting, never sent
    sent[0]!.answer.resolve("A");
    expect(await a).toEqual({ kind: "superseded" }); // stale: c waits
    await flush();
    expect(sent.map((s) => s.request)).toEqual(["a", "c"]);
    sent[1]!.answer.resolve("C");
    expect(await c).toEqual({ kind: "done", value: "C" });
    expect(l.busy).toBe(false);
  });

  it("cancels a running request only after 250 ms and only when a newer one waits", async () => {
    const { l, sent, cancelled, clock } = lane();
    void l.submit("a");
    clock.advance(400);
    expect(cancelled).toEqual([]); // nothing waits
    void l.submit("b");
    expect(cancelled).toEqual([1]); // running for 400 ms

    const second = lane();
    void second.l.submit("x");
    second.clock.advance(100);
    void second.l.submit("y");
    expect(second.cancelled).toEqual([]);
    second.clock.advance(149);
    expect(second.cancelled).toEqual([]);
    second.clock.advance(1);
    expect(second.cancelled).toEqual([1]);
    expect(sent).toHaveLength(1);
  });

  it("reports a failure when nothing newer waits, and treats a failed stale request as superseded", async () => {
    const { l, sent } = lane();
    const a = l.submit("a");
    sent[0]!.answer.reject(new Error("engine gone"));
    expect(await a).toMatchObject({ kind: "failed", error: { message: "engine gone" } });
    const b = l.submit("b");
    const c = l.submit("c");
    sent[1]!.answer.reject(new Error("cancelled"));
    expect(await b).toEqual({ kind: "superseded" });
    await flush();
    sent[2]!.answer.resolve("C");
    expect(await c).toEqual({ kind: "done", value: "C" });
  });

  it("reset drops the waiting request and the answer of the running one", async () => {
    const { l, sent } = lane();
    const a = l.submit("a");
    const b = l.submit("b");
    l.reset();
    expect(await a).toEqual({ kind: "superseded" });
    expect(await b).toEqual({ kind: "superseded" });
    sent[0]!.answer.resolve("A");
    await flush();
    expect(sent).toHaveLength(1);
  });
});

/** A link whose model.sync answers the test plays by hand. */
function fakeLink() {
  const requests: { revision: number; purpose: string; features?: string[]; answer: ReturnType<typeof deferred<Reply<"model.sync">>> }[] = [];
  const listeners = new Set<() => void>();
  let ready = true;
  const link: EngineLink = {
    isReady: () => ready,
    onReady: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    request: ((command: { type: string; revision: number; purpose: string; previewFeatures?: string[] }) => {
      const answer = deferred<Reply<"model.sync">>();
      requests.push({ revision: command.revision, purpose: command.purpose, ...(command.previewFeatures ? { features: command.previewFeatures } : {}), answer });
      return { id: requests.length, reply: answer.promise };
    }) as unknown as EngineLink["request"],
    cancel: () => {},
  };
  const answer = (i: number) => {
    const r = requests[i]!;
    r.answer.resolve({
      message: { type: "modelResult", replyTo: i + 1, revision: r.revision, purpose: r.purpose as "commit", outcome: "ok", steps: [], bodies: [], timings: { rebuildMs: 0, meshMs: 0, encodeMs: 0, totalMs: 0 } },
      payload: null,
    });
  };
  return {
    link,
    requests,
    answer,
    crash: (i: number) => requests[i]!.answer.reject(new EngineCrashedError({ kind: "exit", message: "The engine process ended with exit code 3." })),
    setReady: (v: boolean) => {
      ready = v;
      if (v) for (const l of [...listeners]) l();
    },
  };
}

describe("ModelSync", () => {
  it("sends every committed change and undo, with growing revisions, and holds while a sketch is open", async () => {
    const f = fakeLink();
    const store = new DocumentStore(document(rectangle(3)));
    const sync = new ModelSync(f.link, store);
    expect(f.requests.map((r) => [r.revision, r.purpose])).toEqual([[1, "commit"]]);
    f.answer(0);
    await flush();
    expect(sync.getView().revision).toBe(1);

    const release = sync.hold();
    store.commit((d) => ({ ...d, components: [{ ...d.components[0]!, name: "Halter" }] }));
    expect(f.requests).toHaveLength(1);
    release();
    expect(f.requests.map((r) => r.revision)).toEqual([1, 2]);
    f.answer(1);
    await flush();
    store.undo();
    expect(f.requests.map((r) => r.revision)).toEqual([1, 2, 3]);
  });

  it("sends a preview with its steps and returns to the committed state when it ends", async () => {
    const f = fakeLink();
    const store = new DocumentStore(document(rectangle(3)));
    const sync = new ModelSync(f.link, store);
    f.answer(0);
    await flush();
    const preview = sync.setPreview({ build: (d) => d, features: ["f2"] });
    expect(f.requests[1]).toMatchObject({ revision: 2, purpose: "preview", features: ["f2"] });
    f.answer(1);
    expect(await preview).toMatchObject({ kind: "done" });
    void sync.clearPreview();
    expect(f.requests[2]).toMatchObject({ revision: 3, purpose: "commit" });
  });

  it("after an engine crash sends the current state again with a new revision once the engine is ready", async () => {
    const f = fakeLink();
    const store = new DocumentStore(document(rectangle(3)));
    const sync = new ModelSync(f.link, store);
    void sync.setPreview({ build: (d) => d, features: ["f2"] });
    f.answer(0);
    await flush();
    f.crash(1);
    await flush();
    expect(sync.getView().error).toBeInstanceOf(EngineCrashedError);
    f.setReady(false);
    store.commit((d) => ({ ...d, components: [{ ...d.components[0]!, name: "Halter" }] }));
    expect(f.requests).toHaveLength(2); // not ready: nothing sent
    f.setReady(true);
    expect(f.requests[2]).toMatchObject({ revision: 3, purpose: "preview", features: ["f2"] }); // the open preview again
    f.answer(2);
    await flush();
    expect(sync.getView().error).toBeUndefined();
    expect(sync.getView().revision).toBe(3);
  });
});

describe("replay stub", () => {
  it("plays the recorded engine answer for a known document and refuses an unknown one", async () => {
    const link = new ReplayLink(loadAllRecordings());
    const store = new DocumentStore(document(rectangle(3)));
    const sync = new ModelSync(link, store);
    await new Promise<void>((resolve) => {
      const stop = sync.subscribe(() => {
        if (sync.getView().bodies.length) {
          stop();
          resolve();
        }
      });
    });
    const body = sync.getView().bodies[0]!;
    expect(body.volume).toBeCloseTo(24000, 6);
    expect(body.mesh.indices).toHaveLength(36);
    expect(body.faces.map((f) => f.name)).toContain("f2:side:l1");
    const unknown = await link.request({ type: "sketch.solve", sketch: rectangle(2, 61), plane: { kind: "originPlane", plane: "xy" } }).reply.catch((e: unknown) => e);
    expect((unknown as Error).message).toMatch(/no recorded answer .* Recorded: /);
    sync.dispose();
  });
});
