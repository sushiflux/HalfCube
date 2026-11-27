import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { UpdateError, UpdatePhase, UpdateState } from "../../../app/src/updates/types.ts";
import type { Channel } from "../../../app/src/version.ts";
import { githubFeed } from "../../../desktop/src/updates/feed.ts";
import {
  compareSemVer,
  MAX_NOTES_LENGTH,
  truncateNotes,
  UpdateService,
  type AdapterLoad,
  type FoundUpdate,
  type UpdateServiceOptions,
  type VelopackAdapter,
} from "../../../desktop/src/updates/service.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const nightlyUpdate: FoundUpdate = {
  handle: { token: "nightly" },
  version: "2026.11.12-alpha.13.557",
  notesMarkdown: "",
  downloadBytes: 1000,
  delta: false,
};

/** One release of the fake feed: its version and the checksum the feed states for it ("bad" never verifies). */
interface FakeRelease {
  version: string;
  sha: "good" | "bad";
}

/** A scripted stand-in for Velopack: every call is recorded, every answer can be set per test. */
class FakeAdapter implements VelopackAdapter {
  checkCalls = 0;
  downloadCalls = 0;
  applied: { update: FoundUpdate; restart: boolean }[] = [];
  checkImpl: () => Promise<FoundUpdate | null> = () => Promise.resolve(nightlyUpdate);
  downloadImpl: (update: FoundUpdate, onPercent: (percent: number) => void) => Promise<void> = () => Promise.resolve();
  pendingImpl: () => FoundUpdate | null = () => null;
  applyImpl: (update: FoundUpdate, restart: boolean) => void = () => undefined;

  /**
   * When set, check() answers like Velopack 1.2.161 does (manager.rs, check_for_updates): the newest full release of this
   * feed when it is newer than the installed version, also when exactly that one is already downloaded and waiting (Velopack
   * compares with the installed version only). Every answer is a fresh object, as every real check builds a new UpdateInfo
   * with the checksum the feed carries at that moment.
   */
  feed: FakeRelease[] | null = null;

  currentVersion = () => "2026.11.5-alpha.4.4410";
  check = () => {
    this.checkCalls++;
    if (this.feed !== null) {
      const installed = this.currentVersion();
      const newest = [...this.feed].sort((a, b) => compareSemVer(b.version, a.version) ?? 0)[0];
      if (!newest || (compareSemVer(newest.version, installed) ?? 0) <= 0) return Promise.resolve(null);
      return Promise.resolve<FoundUpdate>({
        handle: { version: newest.version, sha: newest.sha },
        version: newest.version,
        notesMarkdown: "",
        downloadBytes: 1000,
        delta: false,
      });
    }
    return this.checkImpl();
  };
  download = (update: FoundUpdate, onPercent: (percent: number) => void) => {
    this.downloadCalls++;
    return this.downloadImpl(update, onPercent);
  };
  pending = () => this.pendingImpl();
  applyAfterExit = (update: FoundUpdate, restart: boolean) => {
    this.applied.push({ update, restart });
    this.applyImpl(update, restart);
  };
}

interface Harness {
  service: UpdateService;
  adapter: FakeAdapter;
  states: UpdateState[];
  logs: string[];
  quit: Mock<() => void>;
  loadAdapter: Mock<() => AdapterLoad>;
  clock: { ms: number };
}

function build(options: Partial<UpdateServiceOptions> & { prepare?: (adapter: FakeAdapter) => void; load?: AdapterLoad } = {}): Harness {
  const adapter = new FakeAdapter();
  options.prepare?.(adapter);
  const channel = options.channel ?? "nightly";
  const logs: string[] = [];
  const quit = vi.fn<() => void>();
  const loadAdapter = vi.fn<() => AdapterLoad>(() => options.load ?? ({ ok: true, adapter } satisfies AdapterLoad));
  const clock = { ms: Date.parse("2026-11-26T12:00:00.000Z") };
  const service = new UpdateService({
    channel,
    feed: options.feed ?? githubFeed(channel),
    loadAdapter,
    quit,
    log: (line) => logs.push(line),
    now: () => new Date(clock.ms),
    progressIntervalMs: 200,
    ...(options.checkTimeoutMs === undefined ? {} : { checkTimeoutMs: options.checkTimeoutMs }),
  });
  const states: UpdateState[] = [];
  service.onChange((state) => states.push(state));
  return { service, adapter, states, logs, quit, loadAdapter, clock };
}

function phaseOf(state: UpdateState): UpdatePhase {
  if (!state.supported) throw new Error(`expected a supported state, got ${state.reason}`);
  return state.phase;
}

async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
}

/** The pushed states without the ones of a running check (a retry reads the source first, see download()). */
function settledStates(h: Harness): UpdateState[] {
  return h.states.filter((s) => s.supported && !s.checking);
}

/** Lets the work that is already scheduled (a background download, its follow-ups) run to its end. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("unsupported builds", () => {
  it("a dev build says dev-build and never loads Velopack", () => {
    const h = build({ channel: "dev" });
    expect(h.loadAdapter).not.toHaveBeenCalled();
    expect(h.service.getState()).toEqual({ supported: false, reason: "dev-build" });
  });

  it("a build that is not installed says not-installed", () => {
    const h = build({ load: { ok: false, reason: "not-installed", detail: "This application is not properly installed: x" } });
    expect(h.service.getState()).toEqual({ supported: false, reason: "not-installed" });
    expect(h.logs.join("\n")).toContain("This application is not properly installed: x");
  });

  it("a portable copy says portable", () => {
    const h = build({ load: { ok: false, reason: "portable", detail: "portable" } });
    expect(h.service.getState()).toEqual({ supported: false, reason: "portable" });
  });

  it("every call on an unsupported build answers with that state and does nothing", async () => {
    const h = build({ channel: "dev" });
    const result = await h.service.check(true);
    expect(result).toEqual({ ok: true, state: { supported: false, reason: "dev-build" } });
    await h.service.download();
    expect(h.service.setInstallOnExit(true)).toEqual({ supported: false, reason: "dev-build" });
    const restart = await h.service.restartNow();
    expect(restart.error.code).toBe("HC-UPDATE-004");
    expect(h.quit).not.toHaveBeenCalled();
    h.service.onBeforeQuit();
    expect(h.states).toEqual([]);
  });
});

describe("start", () => {
  it("starts with phase none, not checking, in the channel of the build", () => {
    const h = build({ channel: "beta" });
    expect(h.service.getState()).toEqual({ supported: true, channel: "beta", phase: { kind: "none" }, checking: false });
    expect(h.adapter.checkCalls).toBe(0);
  });

  it("an update an earlier session downloaded shows as ready", () => {
    const h = build({ prepare: (a) => (a.pendingImpl = () => ({ ...nightlyUpdate, downloadBytes: 5000 })) });
    const phase = phaseOf(h.service.getState());
    expect(phase).toMatchObject({ kind: "ready", offer: { id: "v2026.11.12.13.557", display: "v2026.11.12.13.557 (α)", downloadBytes: 5000 } });
  });

  it("a pending update that cannot be read leaves the phase at none", () => {
    const h = build({
      prepare: (a) =>
        (a.pendingImpl = () => {
          throw new Error("packages folder unreadable");
        }),
    });
    expect(phaseOf(h.service.getState())).toEqual({ kind: "none" });
    expect(h.logs.join("\n")).toContain("packages folder unreadable");
  });

  it("a pending update can be installed on exit and restarted into", async () => {
    const h = build({ prepare: (a) => (a.pendingImpl = () => nightlyUpdate) });
    expect(phaseOf(h.service.setInstallOnExit(true)).kind).toBe("on-exit");
    h.service.onBeforeQuit();
    expect(h.adapter.applied).toEqual([{ update: nightlyUpdate, restart: false }]);
  });
});

describe("check", () => {
  it("finds an update: checking is pushed while it runs, then the offer is downloaded by itself", async () => {
    const gate = deferred<FoundUpdate | null>();
    const h = build({
      prepare: (a) => {
        a.checkImpl = () => gate.promise;
        a.downloadImpl = () => new Promise<void>(() => undefined);
      },
    });
    const pending = h.service.check(true);
    expect(h.service.getState()).toMatchObject({ checking: true, phase: { kind: "none" } });
    gate.resolve({ ...nightlyUpdate, downloadBytes: 321, delta: true, notesMarkdown: "notes" });
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(phaseOf(result.state)).toEqual({
      kind: "downloading",
      receivedBytes: 0,
      percent: 0,
      offer: { id: "v2026.11.12.13.557", channel: "nightly", display: "v2026.11.12.13.557 (α)", downloadBytes: 321, delta: true, notesMarkdown: "notes" },
    });
    const pushed = h.states.map((s) => (s.supported ? [s.checking, s.phase.kind] : []));
    expect(pushed[0]).toEqual([true, "none"]);
    expect(pushed.at(-1)).toEqual([false, "downloading"]);
  });

  it("finds nothing: up-to-date with the time of the check", async () => {
    const h = build({ prepare: (a) => (a.checkImpl = () => Promise.resolve(null)) });
    const result = await h.service.check(false);
    expect(phaseOf(result.state)).toEqual({ kind: "up-to-date", checkedAt: "2026-11-26T12:00:00.000Z" });
  });

  it("maps the version of every channel and builds the display with formatVersion", async () => {
    const cases: [Exclude<Channel, "dev">, string, string, string][] = [
      ["nightly", "2026.11.12-alpha.13.557", "", "v2026.11.12.13.557 (α)"],
      ["beta", "2026.11.12-beta.13.557", "", "v2026.11.12.13.557 (β)"],
      ["release", "2026.11.12", "## v2026.11.12.13.557\n- x", "v2026.11.12.13.557"],
      ["release", "2026.11.12", "", "v2026.11.12"],
    ];
    for (const [channel, version, notes, display] of cases) {
      const h = build({
        channel,
        prepare: (a) => {
          a.checkImpl = () => Promise.resolve({ ...nightlyUpdate, version, notesMarkdown: notes });
          a.downloadImpl = () => new Promise<void>(() => undefined);
        },
      });
      const phase = phaseOf((await h.service.check(true)).state);
      expect(phase.kind === "downloading" && phase.offer.display).toBe(display);
    }
  });

  it("only one check at a time: a second call waits for the same answer", async () => {
    const gate = deferred<FoundUpdate | null>();
    const h = build({
      prepare: (a) => {
        a.checkImpl = () => gate.promise;
        a.downloadImpl = () => new Promise<void>(() => undefined);
      },
    });
    const first = h.service.check(false);
    const second = h.service.check(true);
    gate.resolve(nightlyUpdate);
    const [a, b] = await Promise.all([first, second]);
    expect(h.adapter.checkCalls).toBe(1);
    expect(a.ok && b.ok).toBe(true);
    expect(phaseOf(b.state).kind).toBe("downloading");
  });

  it("an automatic check that fails changes nothing visible, only logs, and says it did not get through", async () => {
    const h = build({ prepare: (a) => (a.checkImpl = () => Promise.reject(new Error("Network error: offline"))) });
    const result = await h.service.check(false);
    // ok:false so the page does not record it as the last successful check; the phase stays as it was.
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("HC-UPDATE-001");
    expect(phaseOf(result.state)).toEqual({ kind: "none" });
    expect(h.states.map((s) => phaseOf(s).kind)).not.toContain("check-failed");
    expect(h.logs.join("\n")).toContain("Network error: offline");
  });

  it("an automatic failure keeps every known phase, download-failed included", async () => {
    const h = build();
    h.adapter.downloadImpl = () => Promise.reject(new Error("disk full"));
    await h.service.check(false);
    await flush();
    const before = h.service.getState();
    expect(phaseOf(before).kind).toBe("download-failed");
    h.adapter.checkImpl = () => Promise.reject(new Error("offline"));
    const result = await h.service.check(false);
    expect(result.ok).toBe(false);
    expect(result.state).toEqual(before);
  });

  it("an automatic failure keeps up-to-date as it was", async () => {
    const h = build();
    h.adapter.checkImpl = () => Promise.resolve(null);
    await h.service.check(false);
    const before = h.service.getState();
    h.adapter.checkImpl = () => Promise.reject(new Error("boom"));
    const result = await h.service.check(false);
    expect(result.ok).toBe(false);
    expect(result.state).toEqual(before);
  });

  it("a manual check that fails becomes check-failed with HC-UPDATE-001 and the full cause", async () => {
    const h = build({ prepare: (a) => (a.checkImpl = () => Promise.reject(new Error("Network error: HTTP 403 rate limit exceeded"))) });
    const result = await h.service.check(true);
    expect(result.ok).toBe(false);
    const error = !result.ok ? result.error : undefined;
    expect(error?.code).toBe("HC-UPDATE-001");
    expect(error?.detail).toContain("Channel: nightly");
    expect(error?.detail).toContain("GitHub releases https://github.com/sushiflux/HalfCube (pre-releases: yes)");
    expect(error?.detail).toContain("Network error: HTTP 403 rate limit exceeded");
    expect(error?.at).toBe("2026-11-26T12:00:00.000Z");
    expect(phaseOf(result.state)).toEqual({ kind: "check-failed", error });
  });

  it("names the local feed in the error when HALFCUBE_UPDATE_FEED is in use", async () => {
    const h = build({
      feed: { kind: "file", path: "C:\\feed" },
      prepare: (a) => (a.checkImpl = () => Promise.reject(new Error("File does not exist: C:\\feed\\releases.nightly.json"))),
    });
    const result = await h.service.check(true);
    expect(!result.ok && result.error.detail).toContain("local folder C:\\feed");
  });

  it("a manual check that fails keeps a known update: the phase stays, the error only comes back", async () => {
    for (const setup of ["ready", "on-exit"] as const) {
      const h = build();
      await h.service.check(true);
      await flush();
      if (setup === "on-exit") h.service.setInstallOnExit(true);
      const before = phaseOf(h.service.getState());
      h.adapter.checkImpl = () => Promise.reject(new Error("offline"));
      const result = await h.service.check(true);
      expect(result.ok).toBe(false);
      expect(phaseOf(result.state)).toEqual(before);
      expect(before.kind).toBe(setup);
    }
  });

  it("a manual check that fails keeps download-failed: the offer and the retry stay", async () => {
    const h = build();
    h.adapter.downloadImpl = () => Promise.reject(new Error("disk full"));
    await h.service.check(false);
    await flush();
    const before = phaseOf(h.service.getState());
    expect(before.kind).toBe("download-failed");
    h.adapter.checkImpl = () => Promise.reject(new Error("offline"));
    const result = await h.service.check(true);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.detail).toContain("offline");
    expect(phaseOf(result.state)).toEqual(before);
    // "Erneut versuchen" still works once the source answers again.
    h.adapter.checkImpl = () => Promise.resolve(nightlyUpdate);
    h.adapter.downloadImpl = () => Promise.resolve();
    await h.service.download();
    expect(phaseOf(h.service.getState()).kind).toBe("ready");
  });

  it("a later successful check clears check-failed", async () => {
    const h = build();
    h.adapter.checkImpl = () => Promise.reject(new Error("offline"));
    await h.service.check(true);
    h.adapter.checkImpl = () => Promise.resolve(null);
    expect(phaseOf((await h.service.check(true)).state).kind).toBe("up-to-date");
  });

  describe("timeout", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("a feed that does not answer within 10 seconds counts as failed", async () => {
      const h = build({ prepare: (a) => (a.checkImpl = () => new Promise<never>(() => undefined)) });
      const pending = h.service.check(true);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(h.service.getState()).toMatchObject({ checking: true });
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe("HC-UPDATE-001");
      expect(!result.ok && result.error.detail).toContain("did not answer within 10 s");
      expect(h.service.getState()).toMatchObject({ checking: false });
    });

    it("a check that answers late is ignored and the next check starts fresh", async () => {
      const slow = deferred<FoundUpdate | null>();
      const h = build({ prepare: (a) => (a.checkImpl = () => slow.promise) });
      const pending = h.service.check(false);
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
      slow.resolve(nightlyUpdate);
      await vi.advanceTimersByTimeAsync(0);
      expect(phaseOf(h.service.getState())).toEqual({ kind: "none" });
      h.adapter.checkImpl = () => Promise.resolve(null);
      await h.service.check(false);
      expect(h.adapter.checkCalls).toBe(2);
    });
  });
});

describe("download", () => {
  const newerUpdate: FoundUpdate = {
    handle: { token: "newer" },
    version: "2026.11.13-alpha.14.600",
    notesMarkdown: "",
    downloadBytes: 2000,
    delta: false,
  };

  /** A harness whose first download fails ("disk full"), after an automatic check: phase download-failed. */
  async function failedOnce(options: Parameters<typeof build>[0] = {}): Promise<Harness> {
    const h = build(options);
    h.adapter.downloadImpl = () => Promise.reject(new Error("disk full"));
    await h.service.check(false);
    await flush();
    expect(phaseOf(h.service.getState()).kind).toBe("download-failed");
    return h;
  }

  it("starts by itself after an automatic check: downloading, then ready, without a click", async () => {
    const gate = deferred<void>();
    const h = build({ prepare: (a) => (a.downloadImpl = () => gate.promise) });
    const result = await h.service.check(false);
    expect(phaseOf(result.state)).toMatchObject({ kind: "downloading", receivedBytes: 0, percent: 0, offer: { id: "v2026.11.12.13.557" } });
    expect(h.adapter.downloadCalls).toBe(1);
    gate.resolve();
    await flush();
    expect(phaseOf(h.service.getState())).toMatchObject({ kind: "ready", offer: { id: "v2026.11.12.13.557" } });
    expect(h.adapter.downloadCalls).toBe(1);
  });

  it("starts by itself after a manual check too", async () => {
    const gate = deferred<void>();
    const h = build({ prepare: (a) => (a.downloadImpl = () => gate.promise) });
    expect(phaseOf((await h.service.check(true)).state).kind).toBe("downloading");
    gate.resolve();
    await flush();
    expect(phaseOf(h.service.getState()).kind).toBe("ready");
  });

  it("starts only one download when two checks overlap", async () => {
    const gate = deferred<FoundUpdate | null>();
    const h = build({ prepare: (a) => (a.checkImpl = () => gate.promise) });
    const both = Promise.all([h.service.check(false), h.service.check(true)]);
    gate.resolve(nightlyUpdate);
    await both;
    await flush();
    expect(h.adapter.downloadCalls).toBe(1);
  });

  it("starts no download when nothing newer is there", async () => {
    const h = build({ prepare: (a) => (a.checkImpl = () => Promise.resolve(null)) });
    await h.service.check(true);
    await flush();
    expect(h.adapter.downloadCalls).toBe(0);
  });

  it("a verification failure is HC-UPDATE-002 and keeps the offer for a retry", async () => {
    const h = build({
      prepare: (a) => (a.downloadImpl = () => Promise.reject(new Error("Checksum did not match for C:\\x.nupkg (expected AA, actual BB)"))),
    });
    await h.service.check(true);
    await flush();
    const phase = phaseOf(h.service.getState());
    expect(phase).toMatchObject({ kind: "download-failed", error: { code: "HC-UPDATE-002" }, offer: { id: "v2026.11.12.13.557" } });
    expect(phase.kind === "download-failed" && phase.error.detail).toContain("Checksum did not match for C:\\x.nupkg (expected AA, actual BB)");
  });

  it.each(["Size did not match for x (expected 1, actual 2)", "This update package is invalid: missing manifest."])(
    "the Velopack wording %j is a verification failure",
    async (text) => {
      const h = build({ prepare: (a) => (a.downloadImpl = () => Promise.reject(new Error(text))) });
      await h.service.check(true);
      await flush();
      expect(phaseOf(h.service.getState())).toMatchObject({ kind: "download-failed", error: { code: "HC-UPDATE-002" } });
    },
  );

  it("any other failure is HC-UPDATE-003 with channel, source and the original text", async () => {
    const h = build({ prepare: (a) => (a.downloadImpl = () => Promise.reject(new Error("Network error: connection reset"))) });
    await h.service.check(true);
    await flush();
    const phase = phaseOf(h.service.getState());
    expect(phase).toMatchObject({ kind: "download-failed", error: { code: "HC-UPDATE-003" } });
    const detail = phase.kind === "download-failed" ? phase.error.detail : "";
    expect(detail).toContain("Channel: nightly");
    expect(detail).toContain("Source: GitHub releases");
    expect(detail).toContain("Network error: connection reset");
  });

  it("a failure is not retried in a loop: one attempt per check", async () => {
    const h = await failedOnce();
    await flush();
    await flush();
    expect(h.adapter.downloadCalls).toBe(1);
  });

  it("the next check retries the failed download by itself", async () => {
    const h = await failedOnce();
    h.adapter.downloadImpl = () => Promise.resolve();
    await h.service.check(false);
    await flush();
    expect(h.adapter.downloadCalls).toBe(2);
    expect(phaseOf(h.service.getState()).kind).toBe("ready");
  });

  it("a manual retry through download() works after a failure", async () => {
    const h = await failedOnce();
    h.adapter.downloadImpl = () => Promise.resolve();
    await h.service.download();
    expect(phaseOf(h.service.getState())).toMatchObject({ kind: "ready", offer: { id: "v2026.11.12.13.557" } });
    expect(h.adapter.downloadCalls).toBe(2);
  });

  it("a failed retry stays download-failed and can be retried again", async () => {
    const h = await failedOnce();
    await h.service.download();
    expect(phaseOf(h.service.getState()).kind).toBe("download-failed");
    h.adapter.downloadImpl = () => Promise.resolve();
    await h.service.download();
    expect(phaseOf(h.service.getState()).kind).toBe("ready");
  });

  it("download() is a no-op without a failed or available update, and while a download runs", async () => {
    const gate = deferred<void>();
    const h = build({ prepare: (a) => (a.downloadImpl = () => gate.promise) });
    await h.service.download(); // none
    expect(h.adapter.downloadCalls).toBe(0);
    await h.service.check(true); // starts the download
    await h.service.download(); // running
    expect(h.adapter.downloadCalls).toBe(1);
    gate.resolve();
    await flush();
    await h.service.download(); // ready
    h.service.setInstallOnExit(true);
    await h.service.download(); // on-exit
    expect(h.adapter.downloadCalls).toBe(1);
  });

  it("pushes progress with bytes computed from the percent, throttled, and always the last step", async () => {
    const h = await failedOnce();
    h.adapter.downloadImpl = (_update, onPercent) => {
      onPercent(10);
      onPercent(20); // same instant: swallowed by the throttle
      return Promise.resolve();
    };
    h.states.length = 0;
    await h.service.download();
    const phases = settledStates(h).map(phaseOf);
    expect(phases.map((p) => p.kind)).toEqual(["downloading", "downloading", "ready"]);
    expect(phases[1]).toMatchObject({ kind: "downloading", percent: 10, receivedBytes: 100 });
  });

  it("pushes again once the throttle interval has passed, and 100 percent at once", async () => {
    const h = await failedOnce();
    h.adapter.downloadImpl = (_update, onPercent) => {
      onPercent(10);
      h.clock.ms += 250;
      onPercent(50);
      onPercent(100);
      return Promise.resolve();
    };
    h.states.length = 0;
    await h.service.download();
    const percents = settledStates(h).map(phaseOf).map((p) => (p.kind === "downloading" ? p.percent : p.kind));
    expect(percents).toEqual([0, 10, 50, 100, "ready"]);
  });

  it("clamps a percent outside 0 to 100", async () => {
    const h = await failedOnce();
    h.adapter.downloadImpl = (_update, onPercent) => {
      onPercent(150);
      return Promise.resolve();
    };
    h.states.length = 0;
    await h.service.download();
    expect(phaseOf(settledStates(h)[1] as UpdateState)).toMatchObject({ percent: 100, receivedBytes: 1000 });
  });

  it("a check during the download returns the state without checking", async () => {
    const gate = deferred<void>();
    const h = build({ prepare: (a) => (a.downloadImpl = () => gate.promise) });
    await h.service.check(true);
    const result = await h.service.check(true);
    expect(h.adapter.checkCalls).toBe(1);
    expect(result.ok && phaseOf(result.state).kind).toBe("downloading");
    gate.resolve();
    await flush();
  });

  it("a check that finishes during a retry does not disturb it", async () => {
    const h = await failedOnce();
    const gate = deferred<void>();
    const checkGate = deferred<FoundUpdate | null>();
    h.adapter.downloadImpl = () => gate.promise;
    h.adapter.checkImpl = () => checkGate.promise;
    const check = h.service.check(false);
    const running = h.service.download();
    checkGate.resolve(nightlyUpdate);
    await check;
    expect(phaseOf(h.service.getState()).kind).toBe("downloading");
    expect(h.adapter.downloadCalls).toBe(2);
    gate.resolve();
    await running;
    expect(phaseOf(h.service.getState()).kind).toBe("ready");
  });

  it("progress that arrives after the download ended is ignored", async () => {
    const h = await failedOnce();
    let late: ((percent: number) => void) | undefined;
    h.adapter.downloadImpl = (_update, onPercent) => {
      late = onPercent;
      return Promise.resolve();
    };
    await h.service.download();
    late?.(50);
    expect(phaseOf(h.service.getState()).kind).toBe("ready");
  });

  describe("a newer update while one is ready or scheduled", () => {
    async function readyWith(onExit: boolean): Promise<Harness> {
      const h = build();
      await h.service.check(true);
      await flush();
      expect(phaseOf(h.service.getState()).kind).toBe("ready");
      if (onExit) h.service.setInstallOnExit(true);
      h.adapter.checkImpl = () => Promise.resolve(newerUpdate);
      return h;
    }

    it("is downloaded too and replaces the ready one", async () => {
      const h = await readyWith(false);
      const gate = deferred<void>();
      h.adapter.downloadImpl = () => gate.promise;
      const result = await h.service.check(false);
      expect(phaseOf(result.state)).toMatchObject({ kind: "downloading", offer: { id: "v2026.11.13.14.600" } });
      gate.resolve();
      await flush();
      expect(phaseOf(h.service.getState())).toMatchObject({ kind: "ready", offer: { id: "v2026.11.13.14.600" } });
      expect(h.adapter.downloadCalls).toBe(2);
      // The newer package is the one that gets installed.
      void h.service.restartNow();
      expect(h.adapter.applied).toEqual([{ update: newerUpdate, restart: true }]);
    });

    it("keeps the wish to install on exit: the newer one lands in on-exit and is applied at quit", async () => {
      const h = await readyWith(true);
      await h.service.check(false);
      await flush();
      expect(phaseOf(h.service.getState())).toMatchObject({ kind: "on-exit", offer: { id: "v2026.11.13.14.600" } });
      h.service.onBeforeQuit();
      expect(h.adapter.applied).toEqual([{ update: newerUpdate, restart: false }]);
    });

    it("a failed newer download keeps the scheduled one: on-exit with the error, applied at quit", async () => {
      const h = await readyWith(true);
      h.adapter.downloadImpl = () => Promise.reject(new Error("Network error: reset"));
      await h.service.check(false);
      await flush();
      const phase = phaseOf(h.service.getState());
      expect(phase).toMatchObject({
        kind: "on-exit",
        offer: { id: "v2026.11.12.13.557" },
        newerDownloadFailed: { offer: { id: "v2026.11.13.14.600" }, error: { code: "HC-UPDATE-003" } },
      });
      expect(phase.kind === "on-exit" && phase.newerDownloadFailed?.error.detail).toContain("Network error: reset");
      h.service.onBeforeQuit();
      expect(h.adapter.applied).toEqual([{ update: nightlyUpdate, restart: false }]);
    });

    it("a failed newer download keeps the ready one: restart installs it", async () => {
      const h = await readyWith(false);
      h.adapter.downloadImpl = () => Promise.reject(new Error("Checksum did not match for x"));
      await h.service.check(false);
      await flush();
      expect(phaseOf(h.service.getState())).toMatchObject({
        kind: "ready",
        offer: { id: "v2026.11.12.13.557" },
        newerDownloadFailed: { offer: { id: "v2026.11.13.14.600" }, error: { code: "HC-UPDATE-002" } },
      });
      void h.service.restartNow();
      expect(h.adapter.applied).toEqual([{ update: nightlyUpdate, restart: true }]);
    });

    it("the failed newer one is retried by download() and replaces the ready one once verified", async () => {
      const h = await readyWith(true);
      h.adapter.downloadImpl = () => Promise.reject(new Error("Network error: reset"));
      await h.service.check(false);
      await flush();
      // A retry that fails again goes back to the scheduled older one.
      await h.service.download();
      expect(phaseOf(h.service.getState())).toMatchObject({ kind: "on-exit", offer: { id: "v2026.11.12.13.557" }, newerDownloadFailed: {} });
      const gate = deferred<void>();
      h.adapter.downloadImpl = () => gate.promise;
      const retry = h.service.download();
      await flush();
      expect(phaseOf(h.service.getState())).toMatchObject({ kind: "downloading", offer: { id: "v2026.11.13.14.600" } });
      gate.resolve();
      await retry;
      const done = phaseOf(h.service.getState());
      expect(done).toEqual({ kind: "on-exit", offer: expect.objectContaining({ id: "v2026.11.13.14.600" }) });
      h.service.onBeforeQuit();
      expect(h.adapter.applied).toEqual([{ update: newerUpdate, restart: false }]);
      expect(h.adapter.downloadCalls).toBe(4);
    });

    it("the next check retries the failed newer one by itself", async () => {
      const h = await readyWith(false);
      h.adapter.downloadImpl = () => Promise.reject(new Error("Network error: reset"));
      await h.service.check(false);
      await flush();
      h.adapter.downloadImpl = () => Promise.resolve();
      await h.service.check(false);
      await flush();
      expect(phaseOf(h.service.getState())).toEqual({ kind: "ready", offer: expect.objectContaining({ id: "v2026.11.13.14.600" }) });
    });

    it("a check that finds nothing any more forgets the failed newer one and keeps the ready one", async () => {
      const h = await readyWith(false);
      h.adapter.downloadImpl = () => Promise.reject(new Error("Network error: reset"));
      await h.service.check(false);
      await flush();
      h.adapter.checkImpl = () => Promise.resolve(null);
      await h.service.check(false);
      expect(phaseOf(h.service.getState())).toEqual({ kind: "ready", offer: expect.objectContaining({ id: "v2026.11.12.13.557" }) });
      await h.service.download();
      expect(h.adapter.downloadCalls).toBe(2);
    });

    it("quitting while the newer one downloads installs the scheduled older one, once", async () => {
      const h = await readyWith(true);
      h.adapter.downloadImpl = () => new Promise<void>(() => undefined);
      await h.service.check(false);
      expect(phaseOf(h.service.getState())).toMatchObject({ kind: "downloading", offer: { id: "v2026.11.13.14.600" } });
      h.service.onBeforeQuit();
      h.service.onBeforeQuit();
      expect(h.adapter.applied).toEqual([{ update: nightlyUpdate, restart: false }]);
      expect(h.logs.join("\n")).toContain("abgebrochen");
    });

    it("quitting while the newer one downloads installs nothing when nothing was scheduled", async () => {
      const h = await readyWith(false);
      h.adapter.downloadImpl = () => new Promise<void>(() => undefined);
      await h.service.check(false);
      h.service.onBeforeQuit();
      expect(h.adapter.applied).toEqual([]);
    });

    it("the scheduled wish can be cancelled while the newer one keeps the error, and set again", async () => {
      const h = await readyWith(true);
      h.adapter.downloadImpl = () => Promise.reject(new Error("Network error: reset"));
      await h.service.check(false);
      await flush();
      expect(phaseOf(h.service.setInstallOnExit(false))).toMatchObject({ kind: "ready", newerDownloadFailed: {} });
      h.service.onBeforeQuit();
      expect(h.adapter.applied).toEqual([]);
      expect(phaseOf(h.service.setInstallOnExit(true))).toMatchObject({ kind: "on-exit", newerDownloadFailed: {} });
    });

    it("the same update found again is not downloaded again", async () => {
      const h = await readyWith(true);
      h.adapter.checkImpl = () => Promise.resolve(nightlyUpdate);
      await h.service.check(false);
      await flush();
      expect(h.adapter.downloadCalls).toBe(1);
      expect(phaseOf(h.service.getState()).kind).toBe("on-exit");
    });

    it("an older update is ignored, and finding nothing keeps the ready one", async () => {
      const h = await readyWith(false);
      h.adapter.checkImpl = () => Promise.resolve({ ...nightlyUpdate, version: "2026.11.2-alpha.1.1" });
      await h.service.check(false);
      h.adapter.checkImpl = () => Promise.resolve(null);
      await h.service.check(false);
      await flush();
      expect(h.adapter.downloadCalls).toBe(1);
      expect(phaseOf(h.service.getState())).toMatchObject({ kind: "ready", offer: { id: "v2026.11.12.13.557" } });
    });
  });
});

describe("install on exit", () => {
  async function ready(): Promise<Harness> {
    const h = build();
    await h.service.check(true);
    await flush();
    return h;
  }

  it("is set from ready and can be cancelled again", async () => {
    const h = await ready();
    h.states.length = 0;
    expect(phaseOf(h.service.setInstallOnExit(true)).kind).toBe("on-exit");
    expect(phaseOf(h.service.setInstallOnExit(true)).kind).toBe("on-exit");
    expect(phaseOf(h.service.setInstallOnExit(false)).kind).toBe("ready");
    expect(phaseOf(h.service.setInstallOnExit(false)).kind).toBe("ready");
    expect(h.states.map((s) => phaseOf(s).kind)).toEqual(["on-exit", "ready"]);
  });

  it("changes nothing in any other phase", async () => {
    const h = build({ prepare: (a) => (a.downloadImpl = () => new Promise<void>(() => undefined)) });
    expect(phaseOf(h.service.setInstallOnExit(true)).kind).toBe("none");
    await h.service.check(true);
    expect(phaseOf(h.service.setInstallOnExit(true)).kind).toBe("downloading");
    expect(h.states.map((s) => phaseOf(s).kind)).not.toContain("on-exit");
  });

  it("applies without restart when HalfCube quits with the flag set, once", async () => {
    const h = await ready();
    h.service.setInstallOnExit(true);
    h.service.onBeforeQuit();
    h.service.onBeforeQuit();
    expect(h.adapter.applied).toEqual([{ update: nightlyUpdate, restart: false }]);
    expect(h.quit).not.toHaveBeenCalled();
  });

  it("applies nothing when it was cancelled, or never set", async () => {
    const h = await ready();
    h.service.onBeforeQuit();
    h.service.setInstallOnExit(true);
    h.service.setInstallOnExit(false);
    h.service.onBeforeQuit();
    expect(h.adapter.applied).toEqual([]);
  });

  it("a failing updater at quit is logged and does not throw", async () => {
    const h = await ready();
    h.adapter.applyImpl = () => {
      throw new Error("Update.exe not found");
    };
    h.service.setInstallOnExit(true);
    expect(() => h.service.onBeforeQuit()).not.toThrow();
    expect(h.logs.join("\n")).toContain("Update.exe not found");
  });
});

describe("restartNow", () => {
  async function ready(): Promise<Harness> {
    const h = build();
    await h.service.check(true);
    await flush();
    return h;
  }

  it("starts the updater with a restart, quits, and never settles", async () => {
    const h = await ready();
    const promise = h.service.restartNow();
    expect(h.adapter.applied).toEqual([{ update: nightlyUpdate, restart: true }]);
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(await settled(promise)).toBe(false);
  });

  it("works from on-exit too, and the quit that follows does not start the updater a second time", async () => {
    const h = await ready();
    h.service.setInstallOnExit(true);
    void h.service.restartNow();
    h.service.onBeforeQuit();
    expect(h.adapter.applied).toEqual([{ update: nightlyUpdate, restart: true }]);
  });

  it("a failing updater gives HC-UPDATE-004 in the result, does not quit and leaves the phase", async () => {
    const h = await ready();
    h.adapter.applyImpl = () => {
      throw new Error("The updater could not be started: access denied");
    };
    const result = await h.service.restartNow();
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("HC-UPDATE-004");
    expect(result.error.detail).toContain("access denied");
    expect(result.error.detail).toContain("Channel: nightly");
    expect(h.quit).not.toHaveBeenCalled();
    expect(phaseOf(h.service.getState()).kind).toBe("ready");
    // And a quit afterwards must not retry in the background.
    h.service.onBeforeQuit();
    expect(h.adapter.applied).toHaveLength(1);
  });

  it("without a downloaded update it answers HC-UPDATE-004 and does nothing", async () => {
    // Nothing known yet, and an update that is still downloading.
    for (const download of [false, true]) {
      const h = build({ prepare: (a) => (a.downloadImpl = () => new Promise<void>(() => undefined)) });
      if (download) await h.service.check(true);
      const result: { ok: false; error: UpdateError } = await h.service.restartNow();
      expect(result.error.code).toBe("HC-UPDATE-004");
      expect(h.adapter.applied).toEqual([]);
      expect(h.quit).not.toHaveBeenCalled();
    }
  });
});

describe("against a feed that answers like Velopack", () => {
  const v12: FakeRelease = { version: "2026.11.12-alpha.13.557", sha: "good" };
  const v13bad: FakeRelease = { version: "2026.11.13-alpha.14.600", sha: "bad" };
  const v13good: FakeRelease = { ...v13bad, sha: "good" };
  const v14: FakeRelease = { version: "2026.11.14-alpha.15.700", sha: "good" };

  /** Downloads verify against the checksum in the handle, i.e. the feed state of the check that built it. */
  function velopackLike(feed: FakeRelease[]): Harness & { downloaded: unknown[] } {
    const downloaded: unknown[] = [];
    const h = build({
      prepare: (a) => {
        a.feed = feed;
        a.downloadImpl = (update) => {
          downloaded.push(update.handle);
          const sha = (update.handle as { sha?: string }).sha;
          return sha === "good" ? Promise.resolve() : Promise.reject(new Error("Checksum did not match for HalfCube-x.nupkg"));
        };
      },
    });
    return { ...h, downloaded };
  }

  /** v12 ready, then v13 found with a broken checksum: ready v12 with the notice about v13. */
  async function readyWithFailedNewer(onExit: boolean) {
    const h = velopackLike([v12]);
    await h.service.check(false);
    await flush();
    if (onExit) h.service.setInstallOnExit(true);
    h.adapter.feed = [v12, v13bad];
    await h.service.check(false);
    await flush();
    expect(phaseOf(h.service.getState())).toMatchObject({
      kind: onExit ? "on-exit" : "ready",
      offer: { id: "v2026.11.12.13.557" },
      newerDownloadFailed: { offer: { id: "v2026.11.13.14.600" }, error: { code: "HC-UPDATE-002" } },
    });
    return h;
  }

  it("F1: when the newer release is withdrawn, Velopack reports the ready one again and the notice goes", async () => {
    const h = await readyWithFailedNewer(false);
    h.adapter.feed = [v12];
    await h.service.check(false);
    await flush();
    expect(phaseOf(h.service.getState())).toEqual({ kind: "ready", offer: expect.objectContaining({ id: "v2026.11.12.13.557" }) });
    expect(h.downloaded).toHaveLength(2);
    // Nothing is left to retry.
    await h.service.download();
    expect(h.downloaded).toHaveLength(2);
  });

  it("F1: an older release reported than the ready one also clears the notice", async () => {
    const h = await readyWithFailedNewer(true);
    h.adapter.feed = [{ version: "2026.11.8-alpha.9.1", sha: "good" }];
    await h.service.check(false);
    expect(phaseOf(h.service.getState())).toEqual({ kind: "on-exit", offer: expect.objectContaining({ id: "v2026.11.12.13.557" }) });
  });

  it("F2: Erneut versuchen after download-failed reads the source again and downloads the repaired release", async () => {
    const h = velopackLike([{ ...v12, sha: "bad" }]);
    await h.service.check(false);
    await flush();
    expect(phaseOf(h.service.getState())).toMatchObject({ kind: "download-failed", error: { code: "HC-UPDATE-002" } });
    h.adapter.feed = [v12];
    await h.service.download();
    expect(phaseOf(h.service.getState())).toEqual({ kind: "ready", offer: expect.objectContaining({ id: "v2026.11.12.13.557" }) });
    expect(h.adapter.checkCalls).toBe(2);
    expect(h.downloaded.at(-1)).toEqual({ version: v12.version, sha: "good" });
  });

  it("F2: Erneut versuchen after download-failed takes an even newer release, or ends up to date when it was withdrawn", async () => {
    const newer = velopackLike([{ ...v12, sha: "bad" }]);
    await newer.service.check(false);
    await flush();
    newer.adapter.feed = [{ ...v12, sha: "bad" }, v14];
    await newer.service.download();
    expect(phaseOf(newer.service.getState())).toMatchObject({ kind: "ready", offer: { id: "v2026.11.14.15.700" } });

    const gone = velopackLike([{ ...v12, sha: "bad" }]);
    await gone.service.check(false);
    await flush();
    gone.adapter.feed = [];
    await gone.service.download();
    expect(phaseOf(gone.service.getState()).kind).toBe("up-to-date");
    expect(gone.downloaded).toHaveLength(1);
  });

  it("F2: Erneut versuchen after download-failed without network keeps the offer and shows HC-UPDATE-001", async () => {
    const h = velopackLike([{ ...v12, sha: "bad" }]);
    await h.service.check(false);
    await flush();
    h.adapter.feed = null;
    h.adapter.checkImpl = () => Promise.reject(new Error("Network error: offline"));
    await h.service.download();
    const phase = phaseOf(h.service.getState());
    expect(phase).toMatchObject({ kind: "download-failed", offer: { id: "v2026.11.12.13.557" }, error: { code: "HC-UPDATE-001" } });
    expect(phase.kind === "download-failed" && phase.error.detail).toContain("Network error: offline");
    expect(h.downloaded).toHaveLength(1);
  });

  it("F2: Erneut versuchen next to a ready update downloads the repaired newer release with the fresh object", async () => {
    const h = await readyWithFailedNewer(true);
    h.adapter.feed = [v12, v13good];
    await h.service.download();
    expect(phaseOf(h.service.getState())).toEqual({ kind: "on-exit", offer: expect.objectContaining({ id: "v2026.11.13.14.600" }) });
    expect(h.downloaded.at(-1)).toEqual({ version: v13good.version, sha: "good" });
    h.service.onBeforeQuit();
    expect(h.adapter.applied.map((a) => a.update.version)).toEqual([v13good.version]);
  });

  it("F2: Erneut versuchen next to a ready update takes an even newer one, and a withdrawn one drops the notice", async () => {
    const newer = await readyWithFailedNewer(false);
    newer.adapter.feed = [v12, v13bad, v14];
    await newer.service.download();
    expect(phaseOf(newer.service.getState())).toEqual({ kind: "ready", offer: expect.objectContaining({ id: "v2026.11.14.15.700" }) });

    const gone = await readyWithFailedNewer(false);
    gone.adapter.feed = [v12];
    await gone.service.download();
    expect(phaseOf(gone.service.getState())).toEqual({ kind: "ready", offer: expect.objectContaining({ id: "v2026.11.12.13.557" }) });
    expect(gone.downloaded).toHaveLength(2);
  });

  it("F2: Erneut versuchen next to a ready update without network keeps it ready and scheduled, with HC-UPDATE-001", async () => {
    const h = await readyWithFailedNewer(true);
    h.adapter.feed = null;
    h.adapter.checkImpl = () => Promise.reject(new Error("Network error: offline"));
    await h.service.download();
    const phase = phaseOf(h.service.getState());
    expect(phase).toMatchObject({
      kind: "on-exit",
      offer: { id: "v2026.11.12.13.557" },
      newerDownloadFailed: { offer: { id: "v2026.11.13.14.600" }, error: { code: "HC-UPDATE-001" } },
    });
    h.service.onBeforeQuit();
    expect(h.adapter.applied.map((a) => a.update.version)).toEqual([v12.version]);
  });

  it("F2: two retries at once read the source once and start one download", async () => {
    const h = velopackLike([{ ...v12, sha: "bad" }]);
    await h.service.check(false);
    await flush();
    h.adapter.feed = [v12];
    await Promise.all([h.service.download(), h.service.download()]);
    expect(h.adapter.checkCalls).toBe(2);
    expect(h.downloaded).toHaveLength(2);
    expect(phaseOf(h.service.getState()).kind).toBe("ready");
    // And a retry while the download runs is ignored.
    const busy = velopackLike([{ ...v12, sha: "bad" }]);
    await busy.service.check(false);
    await flush();
    busy.adapter.feed = [v12];
    busy.adapter.downloadImpl = () => new Promise<void>(() => undefined);
    void busy.service.download();
    await flush();
    expect(phaseOf(busy.service.getState()).kind).toBe("downloading");
    await busy.service.download();
    expect(busy.adapter.checkCalls).toBe(2);
  });

  it("the check ends before the download starts: no pushed state shows available", async () => {
    const h = velopackLike([v12]);
    await h.service.check(true);
    await flush();
    const pushed = h.states.map((s) => (s.supported ? `${s.checking}:${s.phase.kind}` : ""));
    expect(pushed).toEqual(["true:none", "false:downloading", "false:ready"]);
  });
});

describe("offers the feed must not be trusted with", () => {
  it.each([
    ["older than the installed version", "2026.11.4-alpha.9.9999"],
    ["the installed version itself", "2026.11.5-alpha.4.4410"],
    ["an older commit with a bigger tail", "2026.11.5-alpha.3.99999"],
    ["not a SemVer version", "latest"],
  ])("rejects an offer that is %s: up-to-date, no download", async (_what, version) => {
    const h = build({ prepare: (a) => (a.checkImpl = () => Promise.resolve({ ...nightlyUpdate, version })) });
    const result = await h.service.check(true);
    await flush();
    expect(result.ok).toBe(true);
    expect(phaseOf(result.state).kind).toBe("up-to-date");
    expect(h.adapter.downloadCalls).toBe(0);
    expect(h.logs.join("\n")).toContain("nicht neuer als die installierte Version 2026.11.5-alpha.4.4410");
  });

  it("takes an offer of the same commit with a newer prompt counter", async () => {
    const h = build({ prepare: (a) => (a.checkImpl = () => Promise.resolve({ ...nightlyUpdate, version: "2026.11.5-alpha.5.1" })) });
    await h.service.check(true);
    await flush();
    expect(phaseOf(h.service.getState()).kind).toBe("ready");
  });

  it("a rejected offer never replaces a ready update", async () => {
    const h = build();
    await h.service.check(true);
    await flush();
    h.adapter.checkImpl = () => Promise.resolve({ ...nightlyUpdate, version: "2026.11.1-alpha.1.1" });
    await h.service.check(true);
    expect(phaseOf(h.service.getState())).toMatchObject({ kind: "ready", offer: { id: "v2026.11.12.13.557" } });
    expect(h.adapter.downloadCalls).toBe(1);
  });

  it("a pending package that is not newer than the installed version is not offered", () => {
    const h = build({ prepare: (a) => (a.pendingImpl = () => ({ ...nightlyUpdate, version: "2026.11.5-alpha.4.4410" })) });
    expect(phaseOf(h.service.getState())).toEqual({ kind: "none" });
    expect(h.logs.join("\n")).toContain("wird nicht angeboten");
  });

  it("cuts huge release notes before they are stored or parsed, at a line break", async () => {
    const line = "- a line of notes\n";
    const huge = `## v2026.11.12.13.557\n${line.repeat(Math.ceil((MAX_NOTES_LENGTH * 2) / line.length))}`;
    const h = build({
      prepare: (a) => {
        a.checkImpl = () => Promise.resolve({ ...nightlyUpdate, notesMarkdown: huge });
        a.downloadImpl = () => new Promise<void>(() => undefined);
      },
    });
    const phase = phaseOf((await h.service.check(true)).state);
    const notes = phase.kind === "downloading" ? phase.offer.notesMarkdown : "";
    expect(notes.length).toBeLessThanOrEqual(MAX_NOTES_LENGTH);
    expect(notes.length).toBeGreaterThan(MAX_NOTES_LENGTH - line.length);
    expect(notes.endsWith("- a line of notes")).toBe(true);
    expect(h.logs.join("\n")).toContain("gekürzt");
  });

  it("cuts the notes of a pending package too, and bounds a broken byte count", () => {
    const h = build({
      prepare: (a) => (a.pendingImpl = () => ({ ...nightlyUpdate, notesMarkdown: "x".repeat(MAX_NOTES_LENGTH + 10), downloadBytes: Number.NaN })),
    });
    const phase = phaseOf(h.service.getState());
    expect(phase.kind === "ready" && phase.offer.notesMarkdown.length).toBe(MAX_NOTES_LENGTH);
    expect(phase.kind === "ready" && phase.offer.downloadBytes).toBe(0);
  });

  it("truncateNotes leaves short notes alone", () => {
    expect(truncateNotes("## v1\n- x")).toBe("## v1\n- x");
  });
});

describe("compareSemVer", () => {
  it.each([
    ["2026.11.12", "2026.11.5", 1],
    ["2026.11.12-alpha.13.557", "2026.11.12-alpha.13.557", 0],
    ["2026.11.12-alpha.14.1", "2026.11.12-alpha.13.999", 1],
    ["2026.11.12", "2026.11.12-beta.13.557", 1],
    ["2026.11.12-alpha.1", "2026.11.12-alpha.1.0", -1],
    ["2026.11.12-alpha.2", "2026.11.12-alpha.10", -1],
    ["2026.11.12-1", "2026.11.12-alpha", -1],
    ["v2026.12.1+build.5", "2026.12.1", 0],
    ["99999999999999999999.0.0", "99999999999999999998.0.0", 1],
  ])("%s vs %s is %d", (a, b, expected) => {
    expect(compareSemVer(a, b)).toBe(expected);
    expect(compareSemVer(b, a)).toBe(-expected === 0 ? 0 : -expected);
  });

  it("is null for anything that is not SemVer", () => {
    expect(compareSemVer("latest", "1.0.0")).toBeNull();
    expect(compareSemVer("1.0", "1.0.0")).toBeNull();
    expect(compareSemVer("1.0.0-", "1.0.0")).toBeNull();
  });
});

describe("state pushes", () => {
  it("the unsubscribe function stops the listener", async () => {
    const h = build();
    const seen: UpdateState[] = [];
    const stop = h.service.onChange((state) => seen.push(state));
    await h.service.check(true);
    const count = seen.length;
    expect(count).toBeGreaterThan(0);
    stop();
    await h.service.check(true);
    expect(seen).toHaveLength(count);
  });

  it("a listener that throws does not break the others or the service", async () => {
    const h = build();
    h.service.onChange(() => {
      throw new Error("window is gone");
    });
    await expect(h.service.check(true)).resolves.toMatchObject({ ok: true });
    expect(h.states.length).toBeGreaterThan(0);
    expect(h.logs.join("\n")).toContain("window is gone");
  });
});
