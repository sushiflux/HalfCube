import { describe, expect, it } from "vitest";
import type { UpdateOffer, UpdatePhase, UpdateState } from "../../../app/src/updates/types.ts";
import { detailError, newerFailure, checkDisabled, checkIsPrimary, downloadPercent, iconKind, isSupported, isVerifying, mainActionIsPrimary, offerOf, slotKind, updateWindowValid, type SlotKind, type SupportedState } from "../../../app/src/updates/view-model.ts";

const offer: UpdateOffer = { id: "v2026.11.12.4.4410", channel: "nightly", display: "v2026.11.12.4.4410 (α)", downloadBytes: 1000, delta: true, notesMarkdown: "" };
const error = { code: "HC-UPDATE-001", detail: "x", at: "2026-11-26T10:00:00.000Z" } as const;
const state = (phase: UpdatePhase, checking = false): SupportedState => ({ supported: true, channel: "nightly", phase, checking });

const phases: Record<string, UpdatePhase> = {
  none: { kind: "none" },
  uptodate: { kind: "up-to-date", checkedAt: "2026-11-26T10:00:00.000Z" },
  found: { kind: "available", offer },
  dl: { kind: "downloading", offer, receivedBytes: 420, percent: 42 },
  ready: { kind: "ready", offer },
  exit: { kind: "on-exit", offer },
  failed: { kind: "check-failed", error },
  faildl: { kind: "download-failed", offer, error: { ...error, code: "HC-UPDATE-002" } },
};

describe("the state of the update slot", () => {
  it.each(Object.entries(phases))("%s has its own slot state", (name, phase) => {
    expect(slotKind(state(phase))).toBe(name);
  });

  it("shows a running check in place of the quiet states only", () => {
    expect(slotKind(state(phases.none!, true))).toBe("checking");
    expect(slotKind(state(phases.uptodate!, true))).toBe("checking");
    expect(slotKind(state(phases.failed!, true))).toBe("checking");
    // With an update known only the check button spins; the slot keeps telling about the update.
    expect(slotKind(state(phases.found!, true))).toBe("found");
    expect(slotKind(state(phases.ready!, true))).toBe("ready");
    expect(slotKind(state(phases.exit!, true))).toBe("exit");
  });

  it("fills the check button only while no other action is the main one", () => {
    expect(checkIsPrimary("none")).toBe(true);
    expect(checkIsPrimary("checking")).toBe(true);
    for (const kind of ["uptodate", "found", "dl", "ready", "exit", "failed", "faildl"] as const) expect(checkIsPrimary(kind)).toBe(false);
  });

  it("fills exactly one button in every state: the check button while nothing is known or a search runs, else the main action", () => {
    const kinds: SlotKind[] = ["none", "checking", "uptodate", "found", "dl", "ready", "exit", "failed", "faildl"];
    const filled = Object.fromEntries(kinds.map((kind) => [kind, Number(checkIsPrimary(kind)) + Number(mainActionIsPrimary(kind))]));
    // Up to date has no main action: no button is filled there; every other state has exactly one.
    expect(filled).toEqual({ none: 1, checking: 1, uptodate: 0, found: 1, dl: 1, ready: 1, exit: 1, failed: 1, faildl: 1 });
    // The main action is filled in the states of the owner's list: downloading ("Fortschritt anzeigen"), on exit ("Jetzt neu starten"), failed ("Details").
    for (const kind of ["found", "dl", "ready", "exit", "failed", "faildl"] as const) expect(mainActionIsPrimary(kind)).toBe(true);
    expect(mainActionIsPrimary("none")).toBe(false);
    expect(mainActionIsPrimary("checking")).toBe(false);
  });

  it("disables the check button while a download runs, and only then", () => {
    expect(checkDisabled(state(phases.dl!))).toBe(true);
    for (const name of ["none", "uptodate", "found", "ready", "exit", "failed", "faildl"]) expect(checkDisabled(state(phases[name]!))).toBe(false);
  });
});

describe("the mark on the info icon", () => {
  it("has a shape per state and nothing for the quiet ones", () => {
    expect(iconKind(state(phases.none!))).toBe("none");
    expect(iconKind(state(phases.uptodate!))).toBe("none");
    expect(iconKind(state(phases.found!))).toBe("found");
    expect(iconKind(state(phases.dl!))).toBe("dl");
    expect(iconKind(state(phases.ready!))).toBe("ready");
    expect(iconKind(state(phases.exit!))).toBe("exit");
    // The warning triangle: after a failed manual check and after a failed download.
    expect(iconKind(state(phases.failed!))).toBe("failed");
    expect(iconKind(state(phases.faildl!))).toBe("failed");
  });

  it("is plain without an updater (the browser, a dev build)", () => {
    expect(iconKind(null)).toBe("none");
    expect(iconKind({ supported: false, reason: "dev-build" })).toBe("none");
  });

  it("is not changed by a running check", () => {
    expect(iconKind(state(phases.none!, true))).toBe("none");
    expect(iconKind(state(phases.found!, true))).toBe("found");
  });
});

describe("helpers", () => {
  it("knows when an updater exists", () => {
    expect(isSupported(null)).toBe(false);
    expect(isSupported({ supported: false, reason: "portable" } satisfies UpdateState)).toBe(false);
    expect(isSupported(state(phases.none!))).toBe(true);
  });

  it("reads progress and verification", () => {
    expect(downloadPercent(phases.dl!)).toBe(42);
    expect(downloadPercent({ kind: "downloading", offer, receivedBytes: 0, percent: 142 })).toBe(100);
    expect(downloadPercent(phases.found!)).toBe(0);
    expect(isVerifying({ kind: "downloading", offer, receivedBytes: 1000, percent: 100 })).toBe(true);
    expect(isVerifying(phases.dl!)).toBe(false);
  });

  it("opens the update window only when there is an offered update", () => {
    for (const name of ["found", "dl", "ready", "exit", "faildl"]) expect(updateWindowValid(state(phases[name]!))).toBe(true);
    for (const name of ["none", "uptodate", "failed"]) expect(updateWindowValid(state(phases[name]!))).toBe(false);
    expect(updateWindowValid(null)).toBe(false);
    expect(offerOf(phases.faildl!)).toBe(offer);
    expect(offerOf(phases.none!)).toBeNull();
  });
});

describe("a newer update whose download failed", () => {
  const newer = { ...offer, id: "v2026.11.14.1.600", display: "v2026.11.14.1.600 (α)" };
  const failure = { offer: newer, error: { ...error, code: "HC-UPDATE-003" as const } };

  it("is found in the phases ready and on-exit only", () => {
    expect(newerFailure({ kind: "ready", offer, newerDownloadFailed: failure })).toBe(failure);
    expect(newerFailure({ kind: "on-exit", offer, newerDownloadFailed: failure })).toBe(failure);
    expect(newerFailure({ kind: "ready", offer })).toBeNull();
    expect(newerFailure(phases.found!)).toBeNull();
    expect(newerFailure(phases.faildl!)).toBeNull();
  });

  it("does not change the state of the slot or the mark: the older update stays ready", () => {
    const s = state({ kind: "ready", offer, newerDownloadFailed: failure });
    expect(slotKind(s)).toBe("ready");
    expect(iconKind(s)).toBe("ready");
    expect(updateWindowValid(s)).toBe(true);
  });

  it("offers the error of a failed check or of the newer download in the Details view", () => {
    expect(detailError(phases.failed!)).toEqual({ error, source: "check" });
    expect(detailError({ kind: "ready", offer, newerDownloadFailed: failure })).toEqual({ error: failure.error, source: "newer" });
    expect(detailError({ kind: "on-exit", offer })).toBeNull();
    expect(detailError(phases.none!)).toBeNull();
  });
});
