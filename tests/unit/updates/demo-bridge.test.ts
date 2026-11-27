import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoBridge, createDemoNewsSource, parseDemoOptions, type DemoOptions } from "../../../app/src/updates/demo-bridge.ts";
import type { UpdateState } from "../../../app/src/updates/types.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const options = (patch: Partial<DemoOptions> = {}): DemoOptions => ({ scenario: "found", progress: 42, check: "uptodate", restartFails: false, auto: true, browser: false, first: false, ...patch });
const phaseOf = (s: UpdateState) => (s.supported ? s.phase.kind : "unsupported");

describe("the demo parameters", () => {
  it("reads the scenario and its options", () => {
    expect(parseDemoOptions("?updates-demo=dl&updates-progress=77")).toEqual(options({ scenario: "dl", progress: 77 }));
    expect(parseDemoOptions("?updates-demo=failed")?.check).toBe("error");
    expect(parseDemoOptions("?updates-demo=found&updates-check=found&updates-restart=fail")).toEqual(options({ check: "found", restartFails: true }));
    expect(parseDemoOptions("?updates-demo=found&updates-auto=off")?.auto).toBe(false);
    expect(parseDemoOptions("?updates-demo=found")?.auto).toBe(true);
    expect(parseDemoOptions("?updates-demo=news&updates-browser=1&updates-first=1")).toEqual(options({ scenario: "news", browser: true, first: true }));
  });

  it("ignores an unknown scenario and the absence of the parameter", () => {
    expect(parseDemoOptions("?updates-demo=install")).toBeNull();
    expect(parseDemoOptions("?lang=de")).toBeNull();
    expect(parseDemoOptions("?updates-demo=dl&updates-progress=500")?.progress).toBe(100);
  });
});

describe("the demo updater", () => {
  it("starts in the state of its scenario", async () => {
    const kinds: Record<string, string> = { none: "none", uptodate: "up-to-date", found: "available", dl: "downloading", ready: "ready", exit: "on-exit", failed: "check-failed", faildl: "download-failed", newerfail: "ready", news: "none" };
    const found: Record<string, string> = {};
    for (const scenario of Object.keys(kinds)) {
      const bridge = createDemoBridge(options({ scenario: scenario as DemoOptions["scenario"] }));
      found[scenario] = phaseOf(await bridge.get());
    }
    expect(found).toEqual(kinds);
  });

  it("runs a simulated download from found to ready and reports progress states (started by hand, as the retry does)", async () => {
    const bridge = createDemoBridge(options({ auto: false }));
    const seen: string[] = [];
    bridge.onState((s) => seen.push(s.supported && s.phase.kind === "downloading" ? `dl${s.phase.percent}` : phaseOf(s)));
    await bridge.download();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen[0]).toBe("dl2");
    expect(seen).toContain("dl100");
    expect(seen.at(-1)).toBe("ready");
  });

  it("downloads by itself after a moment when an update is found, like the real program, and ends ready", async () => {
    const bridge = createDemoBridge(options());
    const seen: string[] = [];
    bridge.onState((s) => seen.push(phaseOf(s)));
    expect(phaseOf(await bridge.get())).toBe("available");
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen[0]).toBe("downloading");
    expect(seen.at(-1)).toBe("ready");
  });

  it("starts the download by itself after a check that finds an update, and not with the switch off", async () => {
    const auto = createDemoBridge(options({ scenario: "none", check: "found" }));
    const kinds: string[] = [];
    auto.onState((s) => kinds.push(phaseOf(s)));
    const c = auto.check(false);
    await vi.advanceTimersByTimeAsync(1000);
    await c;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kinds).toContain("available");
    expect(kinds.at(-1)).toBe("ready");

    const frozen = createDemoBridge(options({ auto: false }));
    const seen: string[] = [];
    frozen.onState((s) => seen.push(phaseOf(s)));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen).toEqual([]);
    expect(phaseOf(await frozen.get())).toBe("available");
  });

  it("does not retry a failed download by itself", async () => {
    const bridge = createDemoBridge(options({ scenario: "faildl" }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(phaseOf(await bridge.get())).toBe("download-failed");
  });

  it("keeps the older update ready while the newer download failed, and a retry downloads the newer one", async () => {
    const bridge = createDemoBridge(options({ scenario: "newerfail" }));
    const first = await bridge.get();
    const phase = first.supported ? first.phase : null;
    expect(phase?.kind).toBe("ready");
    const failure = phase?.kind === "ready" ? phase.newerDownloadFailed : undefined;
    expect(failure?.error.code).toBe("HC-UPDATE-003");
    const offered = phase?.kind === "ready" ? phase.offer.id : "";
    expect(failure?.offer.id).not.toBe(offered);
    await vi.advanceTimersByTimeAsync(5000);
    expect(phaseOf(await bridge.get())).toBe("ready");
    await bridge.download();
    await vi.advanceTimersByTimeAsync(10_000);
    const after = await bridge.get();
    const end = after.supported && after.phase.kind === "ready" ? after.phase : null;
    expect(end?.offer.id).toBe(failure?.offer.id);
    expect(end?.newerDownloadFailed).toBeUndefined();
  });

  it("schedules and cancels installing on exit", async () => {
    const bridge = createDemoBridge(options({ scenario: "ready" }));
    expect(phaseOf(await bridge.setInstallOnExit(true))).toBe("on-exit");
    expect(phaseOf(await bridge.setInstallOnExit(false))).toBe("ready");
  });

  it("answers a manual check as the option says, and an automatic failure changes nothing visible", async () => {
    const found = createDemoBridge(options({ scenario: "none", check: "found" }));
    const a = found.check(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(phaseOf((await a).state)).toBe("available");

    const failing = createDemoBridge(options({ scenario: "none", check: "error" }));
    const auto = failing.check(false);
    await vi.advanceTimersByTimeAsync(1000);
    const autoResult = await auto;
    expect(autoResult.ok).toBe(false);
    expect(phaseOf(autoResult.state)).toBe("none");
    const manual = failing.check(true);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await manual;
    expect(result.ok).toBe(false);
    expect(phaseOf(result.state)).toBe("check-failed");
    expect(result.ok ? null : result.error.code).toBe("HC-UPDATE-001");
  });

  it("restarts for good unless told to fail", async () => {
    const failing = createDemoBridge(options({ scenario: "ready", restartFails: true }));
    const p = failing.restartNow();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await p).error.code).toBe("HC-UPDATE-004");
    let settled = false;
    void createDemoBridge(options({ scenario: "ready" })).restartNow().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(false);
  });
});

describe("the demo news source", () => {
  it("opens by itself only in the scenario 'news', and never writes to the stored preferences", () => {
    const news = createDemoNewsSource(options({ scenario: "news" }));
    expect(news.autoAllowed).toBe(true);
    expect(news.lastShownId()).not.toBe(news.currentId);
    news.remember(news.currentId);
    expect(news.lastShownId()).toBe(news.currentId);
    expect(createDemoNewsSource(options()).autoAllowed).toBe(false);
    // A first installation remembers the version and shows nothing; nothing has been shown yet.
    const first = createDemoNewsSource(options({ scenario: "news", first: true }));
    expect(first.lastShownId()).toBeNull();
  });
});
