// Hang watchdog: a time limit per command. When a command is not answered in time the engine is considered hung and
// the owner (the engine client) stops it and restarts it.
//
// What the limit measures: a command may wait behind others before the engine even starts it, and that waiting must
// not count against it. Commands therefore run in lanes:
//   serial  the engine works them off one at a time in the order they were sent. The budget of a command starts when
//           it becomes the first of its lane (sent into an empty lane, or the one before it was answered).
//           WebAssembly: every command is serial, the single thread answers even ping only between commands.
//   direct  the engine answers at once, also while it computes (native hello, ping, cancel). The budget starts when
//           the command is sent.
// A timeout of 0 or Infinity means "no limit" (the native engine is supervised by pings from the main process).

export interface WatchdogClock {
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const realClock: WatchdogClock = {
  now: () => performance.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type WatchdogLane = "serial" | "direct";

export interface ExpiredCommand {
  id: number;
  /** Human-readable name, e.g. `diagnostics.hang (request 7)`. */
  label: string;
  timeoutMs: number;
  /** Time since the command was sent. */
  sinceSentMs: number;
}

interface Entry {
  id: number;
  label: string;
  timeoutMs: number;
  lane: WatchdogLane;
  sentAt: number;
  /** When the time limit started to run; null while the command still waits behind others in its lane. */
  budgetStart: number | null;
}

const hasLimit = (ms: number) => Number.isFinite(ms) && ms > 0;

export class CommandWatchdog {
  private readonly entries: Entry[] = [];
  private timer: unknown = null;
  private readonly clock: WatchdogClock;
  private readonly onExpire: (command: ExpiredCommand) => void;

  constructor(clock: WatchdogClock, onExpire: (command: ExpiredCommand) => void) {
    this.clock = clock;
    this.onExpire = onExpire;
  }

  /** Number of commands being watched (including those without a limit). */
  get size(): number {
    return this.entries.length;
  }

  add(id: number, label: string, timeoutMs: number, lane: WatchdogLane): void {
    const now = this.clock.now();
    const laneIsEmpty = !this.entries.some((e) => e.lane === lane);
    this.entries.push({
      id,
      label,
      timeoutMs,
      lane,
      sentAt: now,
      budgetStart: lane === "direct" || laneIsEmpty ? now : null,
    });
    this.reschedule();
  }

  /** The command was answered (or failed); the next command of its lane starts its budget now. */
  settle(id: number): void {
    const index = this.entries.findIndex((e) => e.id === id);
    if (index < 0) return;
    const [removed] = this.entries.splice(index, 1);
    if (removed && removed.lane === "serial" && removed.budgetStart !== null) {
      const next = this.entries.find((e) => e.lane === "serial");
      if (next && next.budgetStart === null) next.budgetStart = this.clock.now();
    }
    this.reschedule();
  }

  /** The engine showed a sign of life for this command (an interim message): its budget starts over. */
  touch(id: number): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || entry.budgetStart === null) return;
    entry.budgetStart = this.clock.now();
    this.reschedule();
  }

  clear(): void {
    this.entries.length = 0;
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    this.timer = null;
  }

  private deadline(e: Entry): number {
    return e.budgetStart === null || !hasLimit(e.timeoutMs) ? Infinity : e.budgetStart + e.timeoutMs;
  }

  private reschedule(): void {
    this.cancelTimer();
    let next = Infinity;
    for (const e of this.entries) next = Math.min(next, this.deadline(e));
    if (next === Infinity) return;
    this.timer = this.clock.setTimer(() => this.check(), Math.max(0, next - this.clock.now()));
  }

  private check(): void {
    this.timer = null;
    const now = this.clock.now();
    let expired: Entry | undefined;
    for (const e of this.entries) {
      if (this.deadline(e) <= now && (!expired || this.deadline(e) < this.deadline(expired))) expired = e;
    }
    if (!expired) {
      // The timer fired a little early (coarse timer resolution); wait for the rest.
      this.reschedule();
      return;
    }
    const command: ExpiredCommand = {
      id: expired.id,
      label: expired.label,
      timeoutMs: expired.timeoutMs,
      sinceSentMs: now - expired.sentAt,
    };
    // The owner stops the engine, so nothing is watched any more.
    this.clear();
    this.onExpire(command);
  }
}
