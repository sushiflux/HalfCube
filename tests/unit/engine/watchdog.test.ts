import { describe, expect, it } from "vitest";
import { CommandWatchdog, type ExpiredCommand } from "../../../app/src/engine/watchdog.ts";
import { ManualClock } from "./helpers/manual-clock.ts";

function setup() {
  const clock = new ManualClock();
  const expired: ExpiredCommand[] = [];
  const dog = new CommandWatchdog(clock, (c) => expired.push(c));
  return { clock, expired, dog };
}

describe("CommandWatchdog", () => {
  it("expires a command that is not answered within its limit", () => {
    const { clock, expired, dog } = setup();
    dog.add(1, "work (request 1)", 1000, "serial");
    clock.advance(999);
    expect(expired).toEqual([]);
    clock.advance(1);
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ id: 1, timeoutMs: 1000, sinceSentMs: 1000 });
    expect(dog.size).toBe(0);
  });

  it("does not expire a command that was answered", () => {
    const { clock, expired, dog } = setup();
    dog.add(1, "work", 1000, "serial");
    clock.advance(900);
    dog.settle(1);
    clock.advance(5000);
    expect(expired).toEqual([]);
  });

  it("starts the budget of a serial command only when the one before it is answered", () => {
    const { clock, expired, dog } = setup();
    dog.add(1, "long", 10_000, "serial");
    dog.add(2, "short", 1000, "serial");
    clock.advance(9000); // the second has waited 9 s but is not running yet
    expect(expired).toEqual([]);
    dog.settle(1);
    clock.advance(999);
    expect(expired).toEqual([]);
    clock.advance(1);
    expect(expired.map((e) => e.id)).toEqual([2]);
    expect(expired[0]!.sinceSentMs).toBe(10_000);
  });

  it("counts direct commands from the moment they are sent, whatever the serial lane does", () => {
    const { clock, expired, dog } = setup();
    dog.add(1, "long", 0, "serial");
    dog.add(2, "ping", 500, "direct");
    clock.advance(500);
    expect(expired.map((e) => e.id)).toEqual([2]);
  });

  it("treats 0 and Infinity as no limit", () => {
    const { clock, expired, dog } = setup();
    dog.add(1, "a", 0, "serial");
    dog.add(2, "b", Infinity, "direct");
    clock.advance(10 ** 9);
    expect(expired).toEqual([]);
    expect(dog.size).toBe(2);
  });

  it("restarts the budget on touch (an interim message shows the engine is alive)", () => {
    const { clock, expired, dog } = setup();
    dog.add(1, "import", 1000, "serial");
    clock.advance(900);
    dog.touch(1);
    clock.advance(900);
    expect(expired).toEqual([]);
    clock.advance(100);
    expect(expired).toHaveLength(1);
  });

  it("lets the next serial command start when the head leaves out of order", () => {
    const { clock, expired, dog } = setup();
    dog.add(1, "a", 5000, "serial");
    dog.add(2, "b", 1000, "serial");
    clock.advance(200);
    dog.settle(1);
    clock.advance(1000);
    expect(expired.map((e) => e.id)).toEqual([2]);
  });

  it("clear drops everything without calling back", () => {
    const { clock, expired, dog } = setup();
    dog.add(1, "a", 100, "serial");
    dog.clear();
    clock.advance(1000);
    expect(expired).toEqual([]);
  });
});
