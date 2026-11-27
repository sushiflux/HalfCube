// When the page asks the main process for an automatic update check. Pure, so the rules are unit-tested.

/** The setting in Einstellungen › Updates: at every start (default), once a day, once a week, manually only. */
export const updateCheckModes = ["start", "day", "week", "manual"] as const;
export type UpdateCheckMode = (typeof updateCheckModes)[number];

const HOUR_MS = 60 * 60 * 1000;
const periodMs = { day: 24 * HOUR_MS, week: 7 * 24 * HOUR_MS } as const;

/**
 * True when an automatic check is due. `atStartup` is true for the check right after the program started; later calls
 * (a timer while the program runs) pass false. `lastCheckAt` is the ISO time of the last successful check, or null.
 */
export function isCheckDue(mode: UpdateCheckMode, lastCheckAt: string | null, now: Date, atStartup: boolean): boolean {
  switch (mode) {
    case "start":
      // Only the check right after the start; a running program never checks by itself in this mode.
      return atStartup;
    case "manual":
      return false;
    case "day":
    case "week": {
      if (lastCheckAt === null) return true;
      const last = Date.parse(lastCheckAt);
      // A stored time that cannot be read, or one in the future (the clock was set back), must not silence the check.
      if (Number.isNaN(last)) return true;
      const age = now.getTime() - last;
      return age < 0 || age >= periodMs[mode];
    }
    default:
      // A value from an old or hand-edited preferences file: behave like the default.
      return atStartup;
  }
}
