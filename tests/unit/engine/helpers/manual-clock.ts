// A clock and timer set the test moves by hand; timers fire in order of their time.
import type { WatchdogClock } from "../../../../app/src/engine/watchdog.ts";

export class ManualClock implements WatchdogClock {
  time = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private next = 1;

  now = (): number => this.time;

  setTimer = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.timers.push({ at: this.time + ms, fn, id });
    return id;
  };

  clearTimer = (handle: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== handle);
  };

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = due.at;
      due.fn();
    }
    this.time = target;
  }
}
