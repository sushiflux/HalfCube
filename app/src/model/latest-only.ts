// LatestOnly: for work that is redone on every change (typing a dimension, moving an extrude distance) the UI never
// piles up requests. Per work area at most one request is in flight and one waits; a newer request replaces the
// waiting one, which is never sent. When the running one answers and a newer one waits, the answer is stale: it is
// dropped and the waiting one goes out. Desktop and browser behave the same, although the WebAssembly engine cannot
// read a cancel while it computes.
//
// No cancel per keystroke: cancelling the running request on every change would mean a fast drag never shows a
// picture. Only a request that has been running for cancelAfterMs (default 250 ms) while a newer one waits is
// cancelled.
import { realClock, type WatchdogClock } from "../engine/watchdog.ts";

export type LatestResult<T> =
  | { kind: "done"; value: T }
  /** A newer request replaced this one; its answer (if any) was dropped. */
  | { kind: "superseded" }
  | { kind: "failed"; error: Error };

export interface LatestOnlyOptions<Req, Res> {
  /** Sends one request. id is used for cancel. */
  send(request: Req): { id: number; reply: Promise<Res> };
  cancel(id: number): void;
  clock?: WatchdogClock;
  /** Default 250. */
  cancelAfterMs?: number;
}

interface Slot<Req, Res> {
  request: Req;
  resolve: (result: LatestResult<Res>) => void;
}

interface Running<Req, Res> extends Slot<Req, Res> {
  id: number;
  sentAt: number;
  cancelled: boolean;
}

export class LatestOnly<Req, Res> {
  private running: Running<Req, Res> | null = null;
  private waiting: Slot<Req, Res> | null = null;
  private timer: unknown = null;
  private generation = 0;
  private readonly opts: LatestOnlyOptions<Req, Res>;
  private readonly clock: WatchdogClock;
  private readonly cancelAfterMs: number;

  constructor(opts: LatestOnlyOptions<Req, Res>) {
    this.opts = opts;
    this.clock = opts.clock ?? realClock;
    this.cancelAfterMs = opts.cancelAfterMs ?? 250;
  }

  /** A request is in flight or waiting. */
  get busy(): boolean {
    return this.running !== null || this.waiting !== null;
  }

  /** Submits a request; resolves when its answer is current, or when a newer request replaced it. Never rejects. */
  submit(request: Req): Promise<LatestResult<Res>> {
    return new Promise((resolve) => {
      if (!this.running) {
        this.start({ request, resolve });
        return;
      }
      this.waiting?.resolve({ kind: "superseded" });
      this.waiting = { request, resolve };
      this.armCancel();
    });
  }

  /** Drops the waiting request and the answer of the running one (both resolve as superseded). */
  reset(): void {
    this.generation++;
    this.clearTimer();
    this.waiting?.resolve({ kind: "superseded" });
    this.waiting = null;
    this.running?.resolve({ kind: "superseded" });
    this.running = null;
  }

  private start(slot: Slot<Req, Res>): void {
    const generation = this.generation;
    let handle: { id: number; reply: Promise<Res> };
    try {
      handle = this.opts.send(slot.request);
    } catch (e) {
      slot.resolve({ kind: "failed", error: e instanceof Error ? e : new Error(String(e)) });
      return;
    }
    const running: Running<Req, Res> = { ...slot, id: handle.id, sentAt: this.clock.now(), cancelled: false };
    this.running = running;
    handle.reply.then(
      (value) => this.settle(generation, running, { kind: "done", value }),
      (error: unknown) => this.settle(generation, running, { kind: "failed", error: error instanceof Error ? error : new Error(String(error)) }),
    );
  }

  private settle(generation: number, running: Running<Req, Res>, result: LatestResult<Res>): void {
    if (generation !== this.generation || this.running !== running) return; // reset in between
    this.running = null;
    this.clearTimer();
    const next = this.waiting;
    this.waiting = null;
    // A newer request waits: this answer is stale. A failure of a superseded request (often "cancelled") is too.
    running.resolve(next ? { kind: "superseded" } : result);
    if (next) this.start(next);
  }

  private armCancel(): void {
    const running = this.running;
    if (!running || running.cancelled || this.timer !== null) return;
    const left = running.sentAt + this.cancelAfterMs - this.clock.now();
    const fire = () => {
      this.timer = null;
      if (this.running === running && this.waiting && !running.cancelled) {
        running.cancelled = true;
        this.opts.cancel(running.id);
      }
    };
    if (left <= 0) fire();
    else this.timer = this.clock.setTimer(fire, left);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    this.timer = null;
  }
}
