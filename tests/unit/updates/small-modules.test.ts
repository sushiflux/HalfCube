import { describe, expect, it } from "vitest";
import { catalogues } from "../../../app/src/i18n/core.ts";
import { describeUpdateError } from "../../../app/src/updates/errors.ts";
import { describeWhen, formatIsoDate, formatProgressSize, formatSize } from "../../../app/src/updates/format.ts";
import { createUpdateUiStore, updateUiFromUrl, updateUiToPatch } from "../../../app/src/updates/ui-state.ts";
import { createWorkStore, restartNeedsWarning } from "../../../app/src/updates/work.ts";
import { formatMessage } from "../../../app/src/i18n/core.ts";
import { parseUrlState } from "../../../app/src/screens/main/url-state.ts";

describe("sizes", () => {
  it("writes megabytes with the language's decimal sign and small sizes in KB", () => {
    expect(formatSize(19_293_798, "de")).toBe("18,4 MB");
    expect(formatSize(19_293_798, "en")).toBe("18.4 MB");
    expect(formatSize(300 * 1024, "en")).toBe("300 KB");
    expect(formatSize(-1, "en")).toBe("?");
    expect(formatProgressSize(8_000_000, 19_293_798, "de")).toBe("7,6 / 18,4 MB");
  });
});

describe("the time of the last check", () => {
  const now = new Date(2026, 10, 26, 15, 0);
  it("says today, yesterday, or the date", () => {
    expect(describeWhen(new Date(2026, 10, 26, 14, 32).toISOString(), now, "de")).toEqual({ key: "updates.whenToday", params: { time: "14:32", date: "26.11.2026" } });
    expect(describeWhen(new Date(2026, 10, 25, 23, 59).toISOString(), now, "de")?.key).toBe("updates.whenYesterday");
    expect(describeWhen(new Date(2026, 10, 20, 9, 5).toISOString(), now, "en")).toEqual({ key: "updates.whenDate", params: { time: "09:05", date: "2026-11-20" } });
    expect(describeWhen("not a date", now, "en")).toBeNull();
  });
});

describe("the date of a changelog entry", () => {
  it("is written as the UI language writes dates, with the same formatter as the time of a check", () => {
    expect(formatIsoDate("2026-11-27", "de")).toBe("27.11.2026");
    expect(formatIsoDate("2026-11-27", "en")).toBe("2026-11-27");
    expect(formatIsoDate("2026-01-05", "de")).toBe("05.01.2026");
    expect(formatIsoDate("27.11.2026", "de")).toBeNull();
    expect(formatIsoDate("", "en")).toBeNull();
    // The date of a check older than yesterday reads the same way.
    const now = new Date(2026, 10, 27, 15, 0);
    expect(describeWhen(new Date(2026, 10, 20, 9, 5).toISOString(), now, "de")?.params.date).toBe(formatIsoDate("2026-11-20", "de"));
    expect(describeWhen(new Date(2026, 10, 20, 9, 5).toISOString(), now, "en")?.params.date).toBe(formatIsoDate("2026-11-20", "en"));
  });
});

describe("update errors", () => {
  it.each(["HC-UPDATE-001", "HC-UPDATE-002", "HC-UPDATE-003", "HC-UPDATE-004"] as const)("%s has a specific headline, an explanation and the untranslated cause in both languages", (code) => {
    for (const language of ["de", "en"] as const) {
      const messages = catalogues[language];
      const tr = (key: string, params?: Record<string, string | number>) => {
        let node: unknown = messages;
        for (const part of key.split(".")) node = (node as Record<string, unknown>)[part];
        return formatMessage(node as string, params);
      };
      const view = describeUpdateError({ code, detail: "SHA-256 expected 9f2c", at: "2026-11-26T10:00:00.000Z" }, tr, "nightly");
      expect(view.code).toBe(code);
      expect(view.headline.length).toBeGreaterThan(15);
      expect(view.details[0]?.kind).toBe("text");
      expect(view.details[1]).toEqual({ kind: "code", text: expect.stringContaining("SHA-256 expected 9f2c") });
      expect(view.details[1]?.text).toContain("nightly");
      expect(view.occurredAt.toISOString()).toBe("2026-11-26T10:00:00.000Z");
    }
  });
});

describe("the state of the update views in the address", () => {
  it("opens one view at a time, writes it to the address and closes it", () => {
    const written: string[] = [];
    const store = createUpdateUiStore({ view: null, news: false, changes: null }, (s) => written.push(JSON.stringify(updateUiToPatch(s))));
    store.openWindow();
    expect(store.get()).toEqual({ view: "window", news: false, changes: null });
    store.openRestart();
    expect(store.get().view).toBe("restart");
    store.openNews();
    expect(store.get()).toEqual({ view: "restart", news: true, changes: null });
    // "Alle Änderungen" is its own dialog on top: it does not disturb the others and carries its source in the address.
    store.openChanges("update");
    expect(store.get()).toEqual({ view: "restart", news: true, changes: "update" });
    expect(updateUiToPatch(store.get())).toEqual({ update: "restart", news: "1", changes: "update" });
    store.closeChanges();
    store.closeView();
    store.closeNews();
    expect(store.get()).toEqual({ view: null, news: false, changes: null });
    expect(written.at(-1)).toBe('{"update":null,"news":null,"changes":null}');
    // Setting the same state again writes nothing.
    const n = written.length;
    store.closeView();
    expect(written).toHaveLength(n);
  });

  it("restores the view from the address after a reload", () => {
    expect(updateUiFromUrl(parseUrlState("?update=restart&news=1"))).toEqual({ view: "restart", news: true, changes: null });
    expect(updateUiFromUrl(parseUrlState("?changes=update"))).toEqual({ view: null, news: false, changes: "update" });
    expect(updateUiFromUrl(parseUrlState(""))).toEqual({ view: null, news: false, changes: null });
  });
});

describe("the work a restart would lose", () => {
  it("asks for the warning only when the design has steps", () => {
    expect(restartNeedsWarning(null)).toBe(false);
    expect(restartNeedsWarning({ name: "Teil", steps: 0 })).toBe(false);
    expect(restartNeedsWarning({ name: "Teil", steps: 1 })).toBe(true);
  });

  it("notifies only when the work changes", () => {
    const store = createWorkStore();
    let n = 0;
    store.subscribe(() => n++);
    store.set({ name: "Teil", steps: 2 });
    store.set({ name: "Teil", steps: 2 });
    store.set({ name: "Teil", steps: 3 });
    store.set(null);
    expect(n).toBe(3);
    expect(store.get()).toBeNull();
  });
});
