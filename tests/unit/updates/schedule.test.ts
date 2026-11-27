import { describe, expect, it } from "vitest";
import { isCheckDue, updateCheckModes, type UpdateCheckMode } from "../../../app/src/updates/schedule.ts";

const now = new Date("2026-11-26T12:00:00.000Z");
const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

describe("isCheckDue", () => {
  it("knows the four modes of the settings dialog", () => {
    expect(updateCheckModes).toEqual(["start", "day", "week", "manual"]);
  });

  it("start: only at startup, whatever the last check says", () => {
    expect(isCheckDue("start", null, now, true)).toBe(true);
    expect(isCheckDue("start", ago(1), now, true)).toBe(true);
    expect(isCheckDue("start", null, now, false)).toBe(false);
    expect(isCheckDue("start", ago(500), now, false)).toBe(false);
  });

  it("manual: never", () => {
    expect(isCheckDue("manual", null, now, true)).toBe(false);
    expect(isCheckDue("manual", ago(5000), now, false)).toBe(false);
  });

  it("day: due from 24 hours on, at startup and while running", () => {
    expect(isCheckDue("day", ago(23.9), now, true)).toBe(false);
    expect(isCheckDue("day", ago(23.9), now, false)).toBe(false);
    expect(isCheckDue("day", ago(24), now, true)).toBe(true);
    expect(isCheckDue("day", ago(24), now, false)).toBe(true);
    expect(isCheckDue("day", ago(100), now, false)).toBe(true);
  });

  it("week: due from 7 days on", () => {
    expect(isCheckDue("week", ago(24 * 7 - 1), now, true)).toBe(false);
    expect(isCheckDue("week", ago(24 * 7), now, false)).toBe(true);
    expect(isCheckDue("week", ago(24 * 30), now, true)).toBe(true);
  });

  it("day and week: no last check counts as due", () => {
    expect(isCheckDue("day", null, now, true)).toBe(true);
    expect(isCheckDue("day", null, now, false)).toBe(true);
    expect(isCheckDue("week", null, now, false)).toBe(true);
  });

  it("an unreadable or future last check does not silence the check", () => {
    expect(isCheckDue("day", "not a date", now, false)).toBe(true);
    expect(isCheckDue("week", ago(-48), now, false)).toBe(true);
  });

  it("an unknown mode from an old preferences file behaves like the default", () => {
    expect(isCheckDue("hourly" as UpdateCheckMode, null, now, true)).toBe(true);
    expect(isCheckDue("hourly" as UpdateCheckMode, null, now, false)).toBe(false);
  });
});
