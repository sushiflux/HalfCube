// The update contract between the desktop main process (desktop/src/updates/) and the page (app/src/updates/).
//
// The main process owns Velopack's UpdateManager and the one update state of the program; it never checks by itself.
// The page decides when to check (the schedule setting and the time of the last successful check live in the page's
// preferences), shows the state (dot on the info icon, update slot in "Über HalfCube", update window) and asks for the
// next step. The browser version has no updater and never sees this bridge.
//
// Like Autodesk Fusion, an update that a check finds (automatic or manual) is downloaded by the main process at once, in
// the background: none/up-to-date -> downloading -> ready, without a click. The user only restarts (restartNow) or lets
// it install when HalfCube closes. A newer update found while one is ready or scheduled is downloaded the same way; the
// ready one stays the fallback until the newer one is verified and only then is replaced (the "install on exit" wish
// carries over). If the newer download fails, the phase goes back to ready / on-exit with the older update and names the
// failure in `newerDownloadFailed`; quitting while the newer one downloads installs the scheduled older one.
// A waiting update does not stop the checks: a newer one is still found and downloaded.
import type { Channel } from "../version.ts";

export const IPC_UPDATES_GET = "halfcube:updates-get";
/** Main process to page: every new UpdateState, pushed after each change (also download progress). */
export const IPC_UPDATES_STATE = "halfcube:updates-state";
export const IPC_UPDATES_CHECK = "halfcube:updates-check";
export const IPC_UPDATES_DOWNLOAD = "halfcube:updates-download";
export const IPC_UPDATES_RESTART = "halfcube:updates-restart";
export const IPC_UPDATES_ON_EXIT = "halfcube:updates-on-exit";

export type UpdateErrorCode =
  /** The check failed: no answer, network, HTTP status, unreadable feed. */
  | "HC-UPDATE-001"
  /** The downloaded package failed verification (checksum); it is not used; the next successful download replaces it. */
  | "HC-UPDATE-002"
  /** The download failed for another reason (network, disk). */
  | "HC-UPDATE-003"
  /** The update could not be started (applying it, restarting). */
  | "HC-UPDATE-004";

export interface UpdateError {
  code: UpdateErrorCode;
  /** The complete technical cause in English, untranslated: shown under "Details" and copied with the message. */
  detail: string;
  /** ISO 8601 time when it happened. */
  at: string;
}

/** An update the feed offers. */
export interface UpdateOffer {
  /**
   * Five-segment id of the new version, e.g. "v2026.11.12.4.4410". Only a release whose notes carry no stamped heading
   * has the three-segment form "v2026.11.12" (the installer packs no more for a release).
   */
  id: string;
  channel: Channel;
  /** Readable form, always from formatVersion (app/src/version.ts). */
  display: string;
  /** Bytes the download will fetch (the sum of the deltas, or the full package). */
  downloadBytes: number;
  /** True when Velopack applies deltas, false when it fetches the full package. */
  delta: boolean;
  /**
   * The release notes the new version carries, as Markdown: a channel changelog excerpt in the same frame as the
   * shipped channel file (parse it with parseChangelog). "" when the release has none.
   */
  notesMarkdown: string;
}

export type UpdatePhase =
  /** Nothing known yet in this session. */
  | { kind: "none" }
  /** The last check found nothing newer. */
  | { kind: "up-to-date"; checkedAt: string }
  /**
   * An update is known but not downloading: only the moment before the download starts by itself, so the page rarely sees
   * it. A failed download is "download-failed", not this.
   */
  | { kind: "available"; offer: UpdateOffer }
  /**
   * The download of `offer` runs. When it replaces a ready or scheduled update, that one stays on disk as the fallback
   * until this download is verified (a quit with the "install on exit" wish installs the fallback).
   */
  | { kind: "downloading"; offer: UpdateOffer; receivedBytes: number; percent: number }
  /**
   * Downloaded and verified; installs when HalfCube restarts through the update. `newerDownloadFailed` is set when a newer
   * update was found but its download failed: `offer` is still ready, download() retries the newer one.
   */
  | { kind: "ready"; offer: UpdateOffer; newerDownloadFailed?: NewerDownloadFailure }
  /** Ready and scheduled to install when HalfCube closes; can be cancelled. `newerDownloadFailed` as for "ready". */
  | { kind: "on-exit"; offer: UpdateOffer; newerDownloadFailed?: NewerDownloadFailure }
  /** A manual check failed (an automatic one never lands here, it stays silent). */
  | { kind: "check-failed"; error: UpdateError }
  /**
   * The download failed and no older update is ready; the page offers "Erneut versuchen" (download()), and the next due
   * check retries by itself. A failed manual check keeps this phase (the offer and the retry stay).
   */
  | { kind: "download-failed"; offer: UpdateOffer; error: UpdateError };

/** A newer update whose download failed while an older one stays ready (phases "ready" and "on-exit"). */
export interface NewerDownloadFailure {
  offer: UpdateOffer;
  error: UpdateError;
}

/** Why this build never looks for updates. */
export type UpdatesUnavailableReason =
  /** A dev build (channel dev): never offers or receives updates. */
  | "dev-build"
  /** Not installed through the installer (started from the build folder, unpacked copy). */
  | "not-installed"
  /** A portable copy. */
  | "portable";

export type UpdateState =
  | { supported: false; reason: UpdatesUnavailableReason }
  | {
      supported: true;
      /** The channel the installer set (nightly, beta, release). */
      channel: Exclude<Channel, "dev">;
      phase: UpdatePhase;
      /** A check is running right now; the phase stays what was known before it (spinner in the check button). */
      checking: boolean;
    };

export type UpdateCheckResult =
  /** The feed answered (or there is nothing to ask: unsupported build, a download runs). Only then is the check counted. */
  | { ok: true; state: UpdateState }
  /**
   * The check failed. Manual: the page shows the error with code and details, and the phase became "check-failed" unless
   * an update is known. Automatic: the phase is unchanged and the page shows nothing; it must not count the check as done
   * (no new "last checked" time), so the schedule tries again at the next opportunity.
   */
  | { ok: false; error: UpdateError; state: UpdateState };

/** What the preload script exposes to the page (DesktopBridge.updates). */
export interface UpdatesBridge {
  get(): Promise<UpdateState>;
  /** Called with every state the main process pushes; returns the function that stops listening. */
  onState(listener: (state: UpdateState) => void): () => void;
  /**
   * Asks the feed. `manual` is true for the button "Nach Updates suchen": only then a failure becomes the phase
   * "check-failed" (and the warning triangle on the info icon). An automatic check that fails changes nothing visible.
   */
  check(manual: boolean): Promise<UpdateCheckResult>;
  /**
   * Retries the download after a failure ("Erneut versuchen"); progress and the outcome arrive as states. Downloads start
   * by themselves after a check, so this does nothing unless the phase is "available", "download-failed", or "ready" /
   * "on-exit" with `newerDownloadFailed` (then the newer one is retried and the ready one stays the fallback); in
   * particular it returns at once while a download runs. It reads the source again first (a release repaired since the
   * last check is then downloaded with its new checksum; one that is gone drops its offer or notice; an even newer one is
   * taken instead). If the source cannot be read, the phase stays and its error becomes HC-UPDATE-001.
   */
  download(): Promise<void>;
  /**
   * Installs the downloaded update now: HalfCube closes, the update is applied and HalfCube starts again. On success the
   * program exits and the promise never settles; it resolves only with an error.
   */
  restartNow(): Promise<{ ok: false; error: UpdateError }>;
  /** Schedules (true) or cancels (false) installing the downloaded update when HalfCube closes. */
  setInstallOnExit(on: boolean): Promise<UpdateState>;
}
