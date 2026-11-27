import { describe, expect, it } from "vitest";
import { UpdatesController, knownOffer, lastCheckPreferenceKey } from "../../../app/src/updates/controller.ts";
import { isCheckDue, type UpdateCheckMode } from "../../../app/src/updates/schedule.ts";
import type { UpdateCheckResult, UpdateError, UpdateOffer, UpdatePhase, UpdateState, UpdatesBridge } from "../../../app/src/updates/types.ts";
import { githubFeed } from "../../../desktop/src/updates/feed.ts";
import { UpdateService, type FoundUpdate, type VelopackAdapter } from "../../../desktop/src/updates/service.ts";

const offer: UpdateOffer = { id: "v2026.11.12.4.4410", channel: "nightly", display: "v2026.11.12.4.4410 (α)", downloadBytes: 1000, delta: true, notesMarkdown: "" };
const idle: UpdateState = { supported: true, channel: "nightly", phase: { kind: "none" }, checking: false };
const error: UpdateError = { code: "HC-UPDATE-001", detail: "timeout", at: "2026-11-26T10:00:00.000Z" };

class FakeBridge implements UpdatesBridge {
  state: UpdateState = idle;
  listeners = new Set<(s: UpdateState) => void>();
  calls: string[] = [];
  checkResult: () => Promise<UpdateCheckResult> = () => Promise.resolve({ ok: true, state: this.state });
  restartResult: () => Promise<{ ok: false; error: UpdateError }> = () => Promise.resolve({ ok: false, error });
  get = () => Promise.resolve(this.state);
  onState = (l: (s: UpdateState) => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  check = (manual: boolean) => {
    this.calls.push(`check:${manual}`);
    return this.checkResult();
  };
  download = () => {
    this.calls.push("download");
    return Promise.resolve();
  };
  restartNow = () => {
    this.calls.push("restart");
    return this.restartResult();
  };
  setInstallOnExit = (on: boolean) => {
    this.calls.push(`exit:${on}`);
    return Promise.resolve(this.state);
  };
  push(state: UpdateState) {
    this.state = state;
    for (const l of this.listeners) l(state);
  }
}

function setup(options: { mode?: UpdateCheckMode; stored?: Record<string, string>; now?: string } = {}) {
  const data = new Map(Object.entries(options.stored ?? {}));
  const bridge = new FakeBridge();
  const clock = { at: new Date(options.now ?? "2026-11-26T12:00:00.000Z") };
  const controller = new UpdatesController({
    preferences: { get: (k) => data.get(k), set: (k, v) => void data.set(k, v) },
    getMode: () => options.mode ?? "start",
    now: () => clock.at,
  });
  return { data, bridge, controller, clock };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("attaching the updater", () => {
  it("takes the first state and every pushed one, and stops listening on detach", async () => {
    const { bridge, controller } = setup();
    const detach = controller.attach(bridge);
    await settle();
    expect(controller.getSnapshot().state).toEqual(idle);
    expect(controller.supported).toBe(true);
    const found: UpdateState = { ...idle, phase: { kind: "available", offer } };
    bridge.push(found);
    expect(controller.getSnapshot().state).toBe(found);
    detach();
    bridge.push(idle);
    expect(controller.getSnapshot().state).toBe(found);
  });

  it("has no state and no updater without a bridge (a bare dev page)", () => {
    const { controller } = setup();
    expect(controller.getSnapshot().state).toBeNull();
    expect(controller.supported).toBe(false);
  });

  it("does not treat an unsupported updater as supported", async () => {
    const { bridge, controller } = setup();
    bridge.state = { supported: false, reason: "dev-build" };
    controller.attach(bridge);
    await settle();
    expect(controller.supported).toBe(false);
  });
});

describe("automatic checks", () => {
  it("checks once at the start in the default mode and remembers the time of a successful check", async () => {
    const { bridge, controller, data } = setup();
    controller.attach(bridge);
    await settle();
    await controller.autoCheck(true);
    expect(bridge.calls).toEqual(["check:false"]);
    expect(data.get(lastCheckPreferenceKey)).toBe("2026-11-26T12:00:00.000Z");
    expect(controller.getSnapshot().lastCheckAt).toBe("2026-11-26T12:00:00.000Z");
  });

  it("does not check from the timer in the default mode, and never in manual mode", async () => {
    const a = setup();
    a.controller.attach(a.bridge);
    await settle();
    await a.controller.autoCheck(false);
    expect(a.bridge.calls).toEqual([]);
    const b = setup({ mode: "manual" });
    b.controller.attach(b.bridge);
    await settle();
    await b.controller.autoCheck(true);
    expect(b.bridge.calls).toEqual([]);
  });

  it("once a day checks only when the last check is a day old", async () => {
    const recent = setup({ mode: "day", stored: { [lastCheckPreferenceKey]: "2026-11-26T01:00:00.000Z" } });
    recent.controller.attach(recent.bridge);
    await settle();
    await recent.controller.autoCheck(true);
    expect(recent.bridge.calls).toEqual([]);
    const old = setup({ mode: "day", stored: { [lastCheckPreferenceKey]: "2026-11-25T11:00:00.000Z" } });
    old.controller.attach(old.bridge);
    await settle();
    await old.controller.autoCheck(true);
    expect(old.bridge.calls).toEqual(["check:false"]);
  });

  it("stays silent when the check fails: no error, no stored time", async () => {
    const { bridge, controller, data } = setup();
    controller.attach(bridge);
    await settle();
    bridge.checkResult = () => Promise.resolve({ ok: false, error, state: idle });
    await controller.autoCheck(true);
    expect(controller.getSnapshot().manual).toBeNull();
    expect(data.has(lastCheckPreferenceKey)).toBe(false);
    bridge.checkResult = () => Promise.reject(new Error("ipc gone"));
    await expect(controller.autoCheck(true)).resolves.toBeUndefined();
    expect(controller.getSnapshot().manual).toBeNull();
  });

  it("does not check while a download runs or a check is running", async () => {
    const downloading = setup();
    downloading.bridge.state = { ...idle, phase: { kind: "downloading", offer, receivedBytes: 1, percent: 1 } };
    downloading.controller.attach(downloading.bridge);
    await settle();
    await downloading.controller.autoCheck(true);
    expect(downloading.bridge.calls).toEqual([]);
    const running = setup();
    running.bridge.state = { ...idle, checking: true };
    running.controller.attach(running.bridge);
    await settle();
    await running.controller.autoCheck(true);
    expect(running.bridge.calls).toEqual([]);
  });

  it("still checks while an update waits for its restart, so a newer one can be found", async () => {
    for (const phase of [{ kind: "ready", offer }, { kind: "on-exit", offer }, { kind: "download-failed", offer, error }] as const) {
      const { bridge, controller } = setup();
      bridge.state = { ...idle, phase };
      controller.attach(bridge);
      await settle();
      await controller.autoCheck(true);
      expect(bridge.calls).toEqual(["check:false"]);
    }
  });
});

describe("checking by hand", () => {
  it("reports an update, the news that there is none, and a failure with its code", async () => {
    const { bridge, controller } = setup();
    controller.attach(bridge);
    await settle();
    const found: UpdateState = { ...idle, phase: { kind: "available", offer } };
    bridge.checkResult = () => Promise.resolve({ ok: true, state: found });
    await controller.checkNow();
    expect(bridge.calls).toEqual(["check:true"]);
    expect(controller.getSnapshot().manual).toEqual({ kind: "found", version: offer.display });

    bridge.checkResult = () => Promise.resolve({ ok: true, state: idle });
    await controller.checkNow();
    expect(controller.getSnapshot().manual).toEqual({ kind: "uptodate" });

    bridge.checkResult = () => Promise.resolve({ ok: false, error, state: idle });
    await controller.checkNow();
    expect(controller.getSnapshot().manual).toEqual({ kind: "error", error });
  });

  it("reports found for every phase that carries an offer, since the download starts by itself", async () => {
    const newer: UpdateOffer = { ...offer, id: "v2026.11.13.5.1", display: "v2026.11.13.5.1 (α)" };
    const phases: UpdatePhase[] = [
      { kind: "downloading", offer, receivedBytes: 0, percent: 0 },
      { kind: "ready", offer },
      { kind: "on-exit", offer },
      { kind: "download-failed", offer, error },
      { kind: "ready", offer, newerDownloadFailed: { offer: newer, error } },
    ];
    for (const phase of phases) {
      const { bridge, controller } = setup();
      controller.attach(bridge);
      await settle();
      bridge.checkResult = () => Promise.resolve({ ok: true, state: { ...idle, phase } });
      await controller.checkNow();
      expect(controller.getSnapshot().manual).toEqual({ kind: "found", version: offer.display });
    }
    for (const phase of [{ kind: "none" }, { kind: "up-to-date", checkedAt: "2026-11-26T12:00:00.000Z" }] as const) {
      expect(knownOffer(phase)).toBeNull();
    }
  });

  it("shows the spinner at once and takes it back when the main process never answers", async () => {
    const { bridge, controller } = setup();
    controller.attach(bridge);
    await settle();
    let release: (r: UpdateCheckResult) => void = () => undefined;
    bridge.checkResult = () => new Promise((r) => (release = r));
    const running = controller.checkNow();
    const spinning = controller.getSnapshot().state;
    expect(spinning?.supported && spinning.checking).toBe(true);
    release({ ok: true, state: idle });
    await running;
    const after = controller.getSnapshot().state;
    expect(after?.supported && after.checking).toBe(false);

    bridge.checkResult = () => Promise.reject(new Error("ipc gone"));
    await controller.checkNow();
    const snap = controller.getSnapshot();
    expect(snap.state?.supported && snap.state.checking).toBe(false);
    expect(snap.manual?.kind).toBe("error");
  });
});

describe("downloading, restarting, installing on exit", () => {
  it("forwards the steps to the main process", async () => {
    const { bridge, controller } = setup();
    controller.attach(bridge);
    await settle();
    await controller.download();
    await controller.setInstallOnExit(true);
    await controller.setInstallOnExit(false);
    expect(bridge.calls).toEqual(["download", "exit:true", "exit:false"]);
  });

  it("keeps a restart that did not start as an error with its code, and lets it be dismissed", async () => {
    const { bridge, controller } = setup();
    controller.attach(bridge);
    await settle();
    const e4: UpdateError = { ...error, code: "HC-UPDATE-004" };
    bridge.restartResult = () => Promise.resolve({ ok: false, error: e4 });
    await controller.restart();
    expect(controller.getSnapshot().restarting).toBe(false);
    expect(controller.getSnapshot().restartError).toEqual(e4);
    controller.dismissRestartError();
    expect(controller.getSnapshot().restartError).toBeNull();
  });

  it("stays in the restarting state while the program is about to close (the promise never settles)", async () => {
    const { bridge, controller } = setup();
    controller.attach(bridge);
    await settle();
    bridge.restartResult = () => new Promise(() => undefined);
    void controller.restart();
    expect(controller.getSnapshot().restarting).toBe(true);
  });

  it("turns a download that rejected into the failed phase with a complete error", async () => {
    const { bridge, controller } = setup();
    bridge.state = { ...idle, phase: { kind: "available", offer } };
    controller.attach(bridge);
    await settle();
    bridge.download = () => Promise.reject(new Error("disk full"));
    await controller.download();
    const state = controller.getSnapshot().state;
    const failed = state?.supported && state.phase.kind === "download-failed" ? state.phase.error : null;
    expect(failed?.code).toBe("HC-UPDATE-003");
    expect(failed?.detail).toContain("disk full");
  });
});

describe("with the real update service of the main process", () => {
  const found: FoundUpdate = { handle: { token: "v12" }, version: "2026.11.12-alpha.13.557", notesMarkdown: "", downloadBytes: 1000, delta: false };

  /** A Velopack stand-in for UpdateService, scripted per test. */
  function adapterWith(overrides: Partial<VelopackAdapter> = {}): VelopackAdapter {
    return {
      currentVersion: () => "2026.11.5-alpha.4.4410",
      check: () => Promise.resolve(found),
      // A download that takes a while, as a real one does: the check answers while it runs.
      download: () => new Promise<void>(() => undefined),
      pending: () => null,
      applyAfterExit: () => undefined,
      ...overrides,
    };
  }

  /** The bridge the preload script builds, here straight onto the service (what updates-ipc.ts forwards). */
  function bridgeOn(service: UpdateService): UpdatesBridge {
    return {
      get: () => Promise.resolve(service.getState()),
      onState: (listener) => service.onChange(listener),
      check: (manual) => service.check(manual),
      download: () => service.download(),
      restartNow: () => service.restartNow(),
      setInstallOnExit: (on) => Promise.resolve(service.setInstallOnExit(on)),
    };
  }

  function wire(adapter: VelopackAdapter, options: Parameters<typeof setup>[0] = {}) {
    const service = new UpdateService({
      channel: "nightly",
      feed: githubFeed("nightly"),
      loadAdapter: () => ({ ok: true, adapter }),
      quit: () => undefined,
      log: () => undefined,
      now: () => new Date("2026-11-26T12:00:00.000Z"),
    });
    const s = setup(options);
    s.controller.attach(bridgeOn(service));
    return { ...s, service };
  }

  it("a manual check that finds an update reports it as found while the download already runs", async () => {
    const { controller } = wire(adapterWith());
    await settle();
    await controller.checkNow();
    const state = controller.getSnapshot().state;
    expect(state?.supported && state.phase.kind).toBe("downloading");
    expect(controller.getSnapshot().manual).toEqual({ kind: "found", version: "v2026.11.12.13.557 (α)" });
  });

  it("a manual check with an update already waiting reports that one as found", async () => {
    const { controller } = wire(adapterWith({ pending: () => found }));
    await settle();
    await controller.checkNow();
    expect(controller.getSnapshot().manual).toEqual({ kind: "found", version: "v2026.11.12.13.557 (α)" });
  });

  it("a failed automatic check stays silent and is not stored as a check, so the next start tries again", async () => {
    const { controller, data, clock } = wire(adapterWith({ check: () => Promise.reject(new Error("Network error: offline")) }), {
      mode: "week",
      stored: { [lastCheckPreferenceKey]: "2026-11-10T12:00:00.000Z" },
    });
    await settle();
    await controller.autoCheck(true);
    const snap = controller.getSnapshot();
    expect(snap.state?.supported && snap.state.phase.kind).toBe("none");
    expect(snap.manual).toBeNull();
    expect(data.get(lastCheckPreferenceKey)).toBe("2026-11-10T12:00:00.000Z");
    expect(snap.lastCheckAt).toBe("2026-11-10T12:00:00.000Z");
    // A moment later the check is still due (a week since the last successful one).
    clock.at = new Date("2026-11-26T12:05:00.000Z");
    expect(isCheckDue("week", snap.lastCheckAt, clock.at, true)).toBe(true);
  });

  it("an update waiting from an earlier session does not stop a newer one from being found and downloaded", async () => {
    const newest: FoundUpdate = { ...found, handle: { token: "v15" }, version: "2026.11.15-alpha.20.900" };
    const downloads: string[] = [];
    const { controller } = wire(
      adapterWith({
        pending: () => found,
        check: () => Promise.resolve(newest),
        download: (update) => {
          downloads.push(update.version);
          return Promise.resolve();
        },
      }),
    );
    await settle();
    const before = controller.getSnapshot().state;
    expect(before?.supported && before.phase.kind).toBe("ready");
    await controller.autoCheck(true);
    await settle();
    expect(downloads).toEqual(["2026.11.15-alpha.20.900"]);
    const after = controller.getSnapshot().state;
    expect(after?.supported && after.phase.kind === "ready" && after.phase.offer.display).toBe("v2026.11.15.20.900 (α)");
  });
});
