// DEV BUILDS ONLY. A made-up updater so every state of the update views can be looked at in the local dev environment and driven by
// the end-to-end suite: `?updates-demo=found`. It is imported only behind the build constant `__HC_UPDATES_DEMO__` (see runtime.ts),
// which Vite sets to false in nightly, beta and release builds, so the module is dropped from those bundles.
//
//   ?updates-demo=none|uptodate|found|dl|ready|exit|failed|faildl|newerfail|news
//     none      nothing known yet
//     uptodate  the last check found nothing (checked a moment ago)
//     found     an update is found; the download starts by itself after a moment, as in the real program (about 3 s, then ready)
//     dl        a download is running and stays at 42 % (&updates-progress=NN sets the percentage; 100 shows "Prüft …")
//     ready     downloaded and verified, waiting for the restart
//     exit      scheduled to install when HalfCube closes
//     newerfail a newer update failed to download while the older one stays ready (hint with "Erneut versuchen"; the retry succeeds)
//     failed    a manual check failed (code HC-UPDATE-001); the dot on the info icon carries the warning triangle
//     faildl    the download failed (checksum, HC-UPDATE-002); "Erneut versuchen" starts a successful simulated download
//     news      the program starts as the new version after an update: "Was ist neu" opens by itself
//   &updates-browser=1                    no updater at all, as in the browser version: only "Was ist neu" works (with news: opens by itself)
//   &updates-first=1                      the program counts as freshly installed ("Was ist neu" remembers the version and shows nothing)
//   &updates-auto=off                     keeps "found" where it is: the download does not start by itself (for screenshots and tests)
//   &updates-check=found|uptodate|error   what a check by hand finds (default: error in the scenario failed, otherwise uptodate)
//   &updates-restart=fail                 "Jetzt neu starten" fails with HC-UPDATE-004 after a moment; otherwise it stays on
//                                         "wird neu gestartet" (the real program would close here)
import { currentVersion, formatVersion } from "../version.ts";
import { demoChangelogMarkdown, demoIds } from "./demo-changelog.ts";
import type { NewsSource } from "./news-logic.ts";
import type { UpdateCheckResult, UpdateError, UpdateOffer, UpdatesBridge, UpdateState } from "./types.ts";

export const demoScenarios = ["none", "uptodate", "found", "dl", "ready", "exit", "failed", "faildl", "newerfail", "news"] as const;
export type DemoScenario = (typeof demoScenarios)[number];

export interface DemoOptions {
  scenario: DemoScenario;
  /** Percentage of the scenario "dl". */
  progress: number;
  check: "found" | "uptodate" | "error";
  restartFails: boolean;
  /** The download starts by itself when an update is found (the real program does); off freezes the state "found". */
  auto: boolean;
  /** No updater, like the browser version. */
  browser: boolean;
  /** A first installation: nothing was shown yet. */
  first: boolean;
}

const TOTAL_BYTES = 19_293_798; // 18,4 MB

export function parseDemoOptions(search: string): DemoOptions | null {
  const q = new URLSearchParams(search);
  const scenario = q.get("updates-demo");
  if (!scenario || !(demoScenarios as readonly string[]).includes(scenario)) return null;
  const p = Number(q.get("updates-progress") ?? 42);
  const check = q.get("updates-check");
  return {
    scenario: scenario as DemoScenario,
    progress: Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : 42,
    check: check === "found" || check === "uptodate" || check === "error" ? check : scenario === "failed" ? "error" : "uptodate",
    restartFails: q.get("updates-restart") === "fail",
    auto: q.get("updates-auto") !== "off",
    browser: q.get("updates-browser") === "1",
    first: q.get("updates-first") === "1",
  };
}

/** A fixed time of day (14:32) on today's date, so the figures of the manual always show the same check time. */
function demoTime(seconds = 0): string {
  const d = new Date();
  d.setHours(14, 32, seconds, 0);
  return d.toISOString();
}

function demoError(code: UpdateError["code"]): UpdateError {
  const at = demoTime(7);
  return code === "HC-UPDATE-002"
    ? { code, at, detail: "SHA-256 expected: 9f2c4d81a07be3c1…e41a\nSHA-256 received: 3b7d90aa51c2f6b8…0c58\nPackage: HalfCube-delta.nupkg" }
    : code === "HC-UPDATE-004"
      ? { code, at, detail: "The update could not be applied: the updater process did not start (the demo parameter updates-restart=fail)." }
      : { code, at, detail: "The update server (github.com) did not answer within 10000 ms (timeout)." };
}

export function demoOffer(installedId: string, which: "offer" | "newer" = "offer"): UpdateOffer {
  const ids = demoIds(installedId);
  return {
    id: ids[which],
    channel: "nightly",
    display: formatVersion(ids[which], "nightly"),
    downloadBytes: TOTAL_BYTES,
    delta: true,
    notesMarkdown: demoChangelogMarkdown(installedId),
  };
}

export function createDemoBridge(options: DemoOptions): UpdatesBridge {
  const installed = currentVersion().id;
  const offer = demoOffer(installed);
  const newer = demoOffer(installed, "newer");
  const listeners = new Set<(state: UpdateState) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };

  const supported = (phase: Extract<UpdateState, { supported: true }>["phase"], checking = false): UpdateState => ({ supported: true, channel: "nightly", phase, checking });
  const initial = (): UpdateState => {
    switch (options.scenario) {
      case "found":
        return supported({ kind: "available", offer });
      case "dl":
        return supported({ kind: "downloading", offer, receivedBytes: Math.round((TOTAL_BYTES * options.progress) / 100), percent: options.progress });
      case "ready":
        return supported({ kind: "ready", offer });
      case "exit":
        return supported({ kind: "on-exit", offer });
      case "failed":
        return supported({ kind: "check-failed", error: demoError("HC-UPDATE-001") });
      case "faildl":
        return supported({ kind: "download-failed", offer, error: demoError("HC-UPDATE-002") });
      case "newerfail":
        return supported({ kind: "ready", offer, newerDownloadFailed: { offer: newer, error: demoError("HC-UPDATE-003") } });
      case "uptodate":
        return supported({ kind: "up-to-date", checkedAt: demoTime() });
      case "none":
      case "news":
        return supported({ kind: "none" });
    }
  };
  let state: UpdateState = initial();
  if (options.auto && state.supported && state.phase.kind === "available") later(() => startDownload(), 1400);
  const push = (next: UpdateState) => {
    state = next;
    for (const l of [...listeners]) l(next);
    // The real program starts the download by itself as soon as a check finds an update.
    if (options.auto && next.supported && next.phase.kind === "available") later(() => startDownload(), 1400);
  };
  const startDownload = (): void => {
    const known = phaseOf();
    const retryNewer = known.kind === "ready" && known.newerDownloadFailed !== undefined;
    if (known.kind !== "available" && known.kind !== "download-failed" && !retryNewer) return;
    const target = retryNewer ? newer : offer;
    let percent = 0;
    const step = () => {
      percent = Math.min(100, percent + 2);
      push(supported({ kind: "downloading", offer: target, receivedBytes: Math.round((TOTAL_BYTES * percent) / 100), percent }));
      if (percent < 100) later(step, 60);
      else later(() => push(supported({ kind: "ready", offer: target })), 1100);
    };
    step();
  };
  const phaseOf = () => (state.supported ? state.phase : { kind: "none" as const });

  return {
    get: () => Promise.resolve(state),
    onState(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    check(manual): Promise<UpdateCheckResult> {
      push(supported(phaseOf(), true));
      return new Promise((resolve) => {
        later(() => {
          const known = phaseOf();
          const keeps = known.kind === "available" || known.kind === "downloading" || known.kind === "ready" || known.kind === "on-exit";
          if (keeps) {
            push(supported(known));
            resolve({ ok: true, state });
          } else if (options.check === "error") {
            const error = demoError("HC-UPDATE-001");
            // An automatic check that fails stays silent: what was shown before stays.
            push(supported(manual ? { kind: "check-failed", error } : known));
            resolve({ ok: false, error, state });
          } else if (options.check === "found") {
            push(supported({ kind: "available", offer }));
            resolve({ ok: true, state });
          } else {
            push(supported({ kind: "up-to-date", checkedAt: demoTime() }));
            resolve({ ok: true, state });
          }
        }, 900);
      });
    },
    download() {
      startDownload();
      return Promise.resolve();
    },
    restartNow() {
      if (!options.restartFails) return new Promise(() => undefined);
      return new Promise((resolve) => later(() => resolve({ ok: false, error: demoError("HC-UPDATE-004") }), 700));
    },
    setInstallOnExit(on) {
      const known = phaseOf();
      if (on && known.kind === "ready") push(supported({ kind: "on-exit", offer }));
      else if (!on && known.kind === "on-exit") push(supported({ kind: "ready", offer }));
      return Promise.resolve(state);
    },
  };
}

/** "Was ist neu" for the demo: the program counts as the offered version, the scenario "news" has not seen it yet. */
export function createDemoNewsSource(options: DemoOptions): NewsSource {
  const installed = currentVersion().id;
  const ids = demoIds(installed);
  let shown: string | null = options.first ? null : options.scenario === "news" ? installed : ids.offer;
  return {
    currentId: ids.offer,
    channel: "nightly",
    autoAllowed: options.scenario === "news" || options.first,
    lastShownId: () => shown,
    remember: (id) => {
      // Kept in memory only: the demo never touches the stored preferences.
      shown = id;
    },
    markdown: () => demoChangelogMarkdown(installed),
  };
}
