// The update service of the main process: the one update state of the program (app/src/updates/types.ts), driven by the
// page's requests. It never checks by itself. Velopack sits behind the small `VelopackAdapter` interface (the real one is
// velopack-adapter.ts), so every transition is unit-tested with a fake and this file loads neither Electron nor Velopack.
import type {
  NewerDownloadFailure,
  UpdateCheckResult,
  UpdateError,
  UpdateErrorCode,
  UpdateOffer,
  UpdatePhase,
  UpdateState,
  UpdatesUnavailableReason,
} from "../../../app/src/updates/types.ts";
import { formatVersion, type Channel } from "../../../app/src/version.ts";
import { describeFeed, type FeedSource } from "./feed.ts";
import { mapPackVersion } from "./version-map.ts";
import { branding } from "../../../app/src/branding.ts";

/** An update package as the adapter reports it: the feed's version and sizes, plus Velopack's own object, opaque here. */
export interface FoundUpdate {
  /** Velopack's object for this update (an UpdateInfo or a VelopackAsset); only the adapter looks into it. */
  handle: unknown;
  /** The package version in the feed's SemVer form, e.g. "2026.11.12-alpha.13.557" (see version-map.ts). */
  version: string;
  /** The release notes the feed carries; "" when there are none. */
  notesMarkdown: string;
  /** Bytes the download will fetch (the sum of the deltas, or the full package). */
  downloadBytes: number;
  /** True when Velopack applies deltas, false when it fetches the full package. */
  delta: boolean;
}

export interface VelopackAdapter {
  /** The version Velopack installed, as written in its manifest (SemVer, e.g. "2026.11.5-alpha.4.4410"). */
  currentVersion(): string;
  /** Asks the feed; null when nothing newer is there. Rejects with the original error. */
  check(): Promise<FoundUpdate | null>;
  /** Downloads and verifies; `onPercent` gets 0 to 100. Rejects with the original error. */
  download(update: FoundUpdate, onPercent: (percent: number) => void): Promise<void>;
  /** An update package that an earlier session already downloaded and that is not installed yet. */
  pending(): FoundUpdate | null;
  /** Starts the updater, which waits for this process to end, applies the update and optionally starts HalfCube again. */
  applyAfterExit(update: FoundUpdate, restart: boolean): void;
}

export type AdapterLoad =
  | { ok: true; adapter: VelopackAdapter }
  | { ok: false; reason: Exclude<UpdatesUnavailableReason, "dev-build">; detail: string };

export interface UpdateServiceOptions {
  /** The channel the program was built for; the installer packs the same one, so it is also Velopack's channel. */
  channel: Channel;
  feed: FeedSource;
  /** Loads Velopack and builds the adapter. Called once, and never for a dev build. */
  loadAdapter: () => AdapterLoad;
  /** Ends the program (app.quit()). */
  quit: () => void;
  /** Operator log, one line per call. */
  log: (line: string) => void;
  now?: () => Date;
  /** How long a check may take before it counts as failed. Default 10 s. */
  checkTimeoutMs?: number;
  /** Minimum time between two pushed progress states. Default 200 ms. */
  progressIntervalMs?: number;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 10_000;
const DEFAULT_PROGRESS_INTERVAL_MS = 200;

/**
 * Release notes longer than this are cut (at the last line break before it). The notes end up in the update window's DOM,
 * and the feed is not ours to trust: a huge or hostile entry must not make a huge page. Real channel excerpts are a few KB.
 */
export const MAX_NOTES_LENGTH = 256 * 1024;

/** Phases that mean "an update is known": a failed manual check does not replace them (the offer and its actions stay). */
const knownPhases: ReadonlySet<UpdatePhase["kind"]> = new Set(["available", "downloading", "ready", "on-exit", "download-failed"]);

type CheckOutcome = { kind: "done" } | { kind: "error"; error: unknown };

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Velopack's wording for a package that does not match its feed entry (read in lib-rust/src/manager.rs and lib.rs). */
function isVerificationFailure(text: string): boolean {
  return /checksum did not match|size did not match|update package is invalid/i.test(text);
}

const semVerPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function compareIdentifier(a: string, b: string): number {
  const numA = /^\d+$/.test(a);
  const numB = /^\d+$/.test(b);
  if (numA && numB) {
    const diff = BigInt(a) - BigInt(b);
    return diff === 0n ? 0 : diff < 0n ? -1 : 1;
  }
  // SemVer 2 section 11: numeric identifiers sort before alphanumeric ones, which compare in ASCII order.
  if (numA !== numB) return numA ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * SemVer 2 precedence of two package versions (the form Velopack packs and compares, see version-map.ts): negative, zero
 * or positive; null when either is not a SemVer version. Build metadata is ignored, as SemVer prescribes.
 */
export function compareSemVer(a: string, b: string): number | null {
  const ma = semVerPattern.exec(a.trim());
  const mb = semVerPattern.exec(b.trim());
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const diff = compareIdentifier(ma[i] ?? "0", mb[i] ?? "0");
    if (diff !== 0) return diff;
  }
  const preA = ma[4];
  const preB = mb[4];
  // A version without a pre-release label ranks above the same core with one.
  if (preA === undefined || preB === undefined) return preA === preB ? 0 : preA === undefined ? 1 : -1;
  const partsA = preA.split(".");
  const partsB = preB.split(".");
  for (let i = 0; i < Math.min(partsA.length, partsB.length); i++) {
    const diff = compareIdentifier(partsA[i] ?? "", partsB[i] ?? "");
    if (diff !== 0) return diff;
  }
  return partsA.length === partsB.length ? 0 : partsA.length < partsB.length ? -1 : 1;
}

/** Cuts release notes to MAX_NOTES_LENGTH, at the last line break before the limit so no heading is torn apart. */
export function truncateNotes(notes: string): string {
  if (notes.length <= MAX_NOTES_LENGTH) return notes;
  const cut = notes.slice(0, MAX_NOTES_LENGTH);
  const lineEnd = cut.lastIndexOf("\n");
  return lineEnd > 0 ? cut.slice(0, lineEnd) : cut;
}

export class UpdateService {
  private readonly options: UpdateServiceOptions;
  private readonly now: () => Date;
  private readonly listeners = new Set<(state: UpdateState) => void>();
  private readonly unsupported: UpdatesUnavailableReason | null;
  private readonly adapter: VelopackAdapter | null;
  /** The version Velopack installed (its manifest); no offer at or below it is ever taken. "" when unsupported. */
  private readonly installedVersion: string;
  private phase: UpdatePhase = { kind: "none" };
  /** Velopack's object behind the current offer (the one shown, downloading or ready); null while no update is known. */
  private known: FoundUpdate | null = null;
  /**
   * The ready update while a newer one downloads. Velopack deletes an older package only after the newer one is
   * downloaded, verified and renamed into place (manager.rs, download_updates), so until then this one can still be
   * installed: it is the phase to fall back to when the newer download fails, and what a quit with the "install on
   * exit" wish applies while the newer one is still downloading.
   */
  private fallback: FoundUpdate | null = null;
  /** A newer update whose download failed while `known` stayed ready; download() and the next check retry it. */
  private failedNewer: FoundUpdate | null = null;
  /** True while the user wants the downloaded update installed when HalfCube closes (phase on-exit). */
  private installOnExit = false;
  private checking = false;
  private inflight: Promise<CheckOutcome> | null = null;
  /** The running download (started by a check or a retry); null when none runs. */
  private downloadRun: Promise<void> | null = null;
  /** True once the updater was started for the update, so quitting does not start it a second time. */
  private applying = false;
  private lastProgressAt = 0;

  constructor(options: UpdateServiceOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());

    if (options.channel === "dev") {
      this.unsupported = "dev-build";
      this.adapter = null;
      this.installedVersion = "";
      this.log("Updates: Entwicklungsstand (Kanal dev), die Update-Funktion ist aus.");
      return;
    }
    const loaded = options.loadAdapter();
    if (!loaded.ok) {
      this.unsupported = loaded.reason;
      this.adapter = null;
      this.installedVersion = "";
      this.log(`Updates: nicht verfügbar (${loaded.reason}): ${loaded.detail}`);
      return;
    }
    this.unsupported = null;
    this.adapter = loaded.adapter;
    this.installedVersion = loaded.adapter.currentVersion();
    this.log(`Updates: Kanal ${options.channel}, installierte Version ${this.installedVersion}, Quelle ${describeFeed(options.feed)}.`);

    // An update an earlier session downloaded and nobody installed shows as ready right away.
    try {
      const pending = loaded.adapter.pending();
      if (pending && this.isNewerThanInstalled(pending)) {
        this.known = this.sanitize(pending);
        const offer = this.buildOffer(this.known);
        this.phase = { kind: "ready", offer };
        this.log(`Updates: ein früher geladenes Update wartet auf die Installation (${offer.display}).`);
      } else if (pending) {
        this.log(`Updates: Das geladene Paket ${pending.version} ist nicht neuer als die installierte Version ${this.installedVersion} und wird nicht angeboten.`);
      }
    } catch (error) {
      this.log(`Updates: Das geladene Update konnte nicht gelesen werden: ${errorText(error)}`);
    }
  }

  getState(): UpdateState {
    if (this.unsupported !== null || this.options.channel === "dev") {
      return { supported: false, reason: this.unsupported ?? "dev-build" };
    }
    return { supported: true, channel: this.options.channel, phase: this.phase, checking: this.checking };
  }

  /** Registers a listener for every state change; returns the function that removes it. */
  onChange(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async check(manual: boolean): Promise<UpdateCheckResult> {
    if (!this.adapter) return { ok: true, state: this.getState() };
    // A download in progress is not interrupted by a check; the page just gets the state.
    if (this.phase.kind === "downloading") return { ok: true, state: this.getState() };

    const outcome = await this.sharedCheck(this.adapter);
    if (outcome.kind === "done") return { ok: true, state: this.getState() };

    const error = this.makeError("HC-UPDATE-001", "Checking for updates failed.", outcome.error);
    if (!manual) {
      // Silent: the phase stays and nothing is pushed. ok:false tells the page that the check did not get through, so it
      // does not record it as the last successful one (the schedule would otherwise wait a day or a week).
      this.log(`Updates: Die automatische Suche ist fehlgeschlagen (${error.detail})`);
      return { ok: false, error, state: this.getState() };
    }
    this.log(`Updates: Die Suche von Hand ist fehlgeschlagen (${error.detail})`);
    if (!knownPhases.has(this.phase.kind)) {
      this.phase = { kind: "check-failed", error };
      this.emit();
    }
    return { ok: false, error, state: this.getState() };
  }

  /**
   * "Erneut versuchen": in the phases available and download-failed, and in ready / on-exit with a newer update whose
   * download failed. The source is read again first, because Velopack's object from the earlier check carries the
   * checksum and file list of that moment: a release that was repaired since would fail again with it. Then the same rules
   * as for a check apply (a newer update that is gone drops its notice, an even newer one is downloaded instead), and the
   * download starts with the fresh object. If the source cannot be read, the phase stays and carries that error (the ready
   * update stays ready). Resolves when the download has ended. One check and one download at a time: a call while either
   * runs joins it.
   */
  async download(): Promise<void> {
    const adapter = this.adapter;
    const phase = this.phase;
    const retryable =
      phase.kind === "available" || phase.kind === "download-failed" || ((phase.kind === "ready" || phase.kind === "on-exit") && this.failedNewer !== null);
    if (!adapter || !retryable) {
      this.log(`Updates: Herunterladen ignoriert (Zustand ${this.adapter ? phase.kind : "nicht verfügbar"}).`);
      return;
    }
    this.log("Updates: Erneut versuchen, die Quelle wird neu gelesen.");
    const outcome = await this.sharedCheck(adapter);
    if (outcome.kind === "error") this.retryCheckFailed(outcome.error);
    if (this.downloadRun) await this.downloadRun;
  }

  /** Installs the downloaded update now. Resolves only with an error; on success the program quits. */
  async restartNow(): Promise<{ ok: false; error: UpdateError }> {
    const adapter = this.adapter;
    const phase = this.phase;
    if (!adapter || (phase.kind !== "ready" && phase.kind !== "on-exit") || !this.known) {
      const error = this.makeError("HC-UPDATE-004", "There is no downloaded update to install.", new Error(`The update phase is "${this.adapter ? phase.kind : "unavailable"}".`));
      this.log(`Updates: Neustart ohne geladenes Update angefordert (${error.detail})`);
      return { ok: false, error };
    }
    try {
      adapter.applyAfterExit(this.known, true);
    } catch (error) {
      const failure = this.makeError("HC-UPDATE-004", "The update could not be started.", error);
      this.log(`Updates: Der Updater konnte nicht gestartet werden (${failure.detail})`);
      return { ok: false, error: failure };
    }
    this.applying = true;
    this.log(`Updates: ${phase.offer.display} wird installiert, ${branding.name} beendet sich und startet neu.`);
    this.options.quit();
    return new Promise<never>(() => undefined);
  }

  /** Schedules (true) or cancels (false) installing the downloaded update when HalfCube closes. */
  setInstallOnExit(on: boolean): UpdateState {
    const phase = this.phase;
    if (on && phase.kind === "ready") {
      this.installOnExit = true;
      this.phase = { ...phase, kind: "on-exit" };
      this.log(`Updates: ${phase.offer.display} wird beim Beenden installiert.`);
      this.emit();
    } else if (!on && phase.kind === "on-exit") {
      this.installOnExit = false;
      this.phase = { ...phase, kind: "ready" };
      this.log(`Updates: Die Installation von ${phase.offer.display} beim Beenden ist zurückgenommen.`);
      this.emit();
    }
    return this.getState();
  }

  /**
   * Called when HalfCube quits (before-quit): applies a scheduled update without restarting. While a newer update is
   * still downloading, the scheduled older one is applied instead (its package is still on disk, see `fallback`).
   */
  onBeforeQuit(): void {
    const phase = this.phase;
    if (!this.adapter || this.applying) return;
    let target: FoundUpdate | null = null;
    if (phase.kind === "on-exit") target = this.known;
    else if (phase.kind === "downloading" && this.installOnExit) target = this.fallback;
    if (!target) return;
    this.applying = true;
    const display = this.buildOffer(target).display;
    try {
      this.adapter.applyAfterExit(target, false);
      this.log(
        phase.kind === "downloading"
          ? `Updates: ${display} wird nach dem Beenden installiert; das Herunterladen von ${phase.offer.display} ist abgebrochen.`
          : `Updates: ${display} wird nach dem Beenden installiert.`,
      );
    } catch (error) {
      this.log(`Updates: Der Updater konnte beim Beenden nicht gestartet werden: ${errorText(error)}`);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------

  /**
   * One check at a time: callers that arrive while one runs wait for the same answer. Like Autodesk Fusion, an update the
   * check finds is downloaded at once, in the background; the user only restarts. The download starts in the same
   * synchronous step that ends the check, so no second check or retry can slip in between and start another one.
   */
  private sharedCheck(adapter: VelopackAdapter): Promise<CheckOutcome> {
    if (this.inflight) return this.inflight;
    const run = async (): Promise<CheckOutcome> => {
      this.checking = true;
      this.emit();
      let toDownload: FoundUpdate | null = null;
      try {
        // Through a promise chain so that an adapter that throws at once is handled like one that rejects.
        const found = await this.withTimeout(Promise.resolve().then(() => adapter.check()));
        toDownload = this.applyFound(found);
        return { kind: "done" };
      } catch (error) {
        return { kind: "error", error };
      } finally {
        this.checking = false;
        this.inflight = null;
        // runDownload pushes its first state itself, so the short "available" never reaches the page.
        if (toDownload) this.startDownload(adapter, toDownload);
        else this.emit();
      }
    };
    this.inflight = run();
    return this.inflight;
  }

  private startDownload(adapter: VelopackAdapter, found: FoundUpdate): void {
    const run = this.runDownload(adapter, found).finally(() => {
      if (this.downloadRun === run) this.downloadRun = null;
    });
    this.downloadRun = run;
  }

  /** The re-read of "Erneut versuchen" failed: the phase stays and shows this error instead of the old one. */
  private retryCheckFailed(cause: unknown): void {
    const error = this.makeError("HC-UPDATE-001", "Reading the update source again for the retry failed.", cause);
    this.log(`Updates: Erneut versuchen ist fehlgeschlagen, die Quelle war nicht lesbar (${error.detail})`);
    const phase = this.phase;
    if (phase.kind === "available" || phase.kind === "download-failed") {
      this.phase = { kind: "download-failed", offer: phase.offer, error };
    } else if ((phase.kind === "ready" || phase.kind === "on-exit") && phase.newerDownloadFailed) {
      this.phase = { ...phase, newerDownloadFailed: { offer: phase.newerDownloadFailed.offer, error } };
    } else {
      return;
    }
    this.emit();
  }

  private async withTimeout<T>(work: Promise<T>): Promise<T> {
    const ms = this.options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`The feed did not answer within ${ms / 1000} s.`)), ms);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Takes over the answer of a check; returns the update that has to be downloaded now, or null. */
  private applyFound(raw: FoundUpdate | null): FoundUpdate | null {
    const phase = this.phase;
    // A download in progress is never disturbed by a check.
    if (phase.kind === "downloading") return null;

    let found = raw === null ? null : this.sanitize(raw);
    // Never a downgrade, and not the installed version again: checked here too instead of relying on Velopack alone
    // (a feed entry or a future option such as AllowVersionDowngrade must not make HalfCube install an older version).
    if (found !== null && !this.isNewerThanInstalled(found)) {
      this.log(`Updates: Das Angebot ${found.version} ist nicht neuer als die installierte Version ${this.installedVersion} und wird verworfen.`);
      found = null;
    }

    if (phase.kind === "ready" || phase.kind === "on-exit") {
      // Velopack reports the newest release every time, also the one that is already downloaded (it compares with the
      // installed version, not with the downloaded one). Only a newer one replaces the downloaded update (and is
      // downloaded too); nothing found, or the ready version again, keeps it.
      if (found === null || !this.known || !this.isNewer(found, this.known)) {
        if (phase.newerDownloadFailed) {
          // The newest release is no longer newer than the ready one, so the newer update whose download failed is not
          // offered any more: forget it, the ready one stays.
          this.log(`Updates: ${phase.newerDownloadFailed.offer.display} wird nicht mehr angeboten, ${phase.offer.display} bleibt.`);
          this.failedNewer = null;
          this.phase = { kind: phase.kind, offer: phase.offer };
        }
        return null;
      }
      this.log(`Updates: Ein neueres Update (${this.buildOffer(found).display}) wird geladen; ${phase.offer.display} bleibt bis dahin installierbar.`);
      this.replaceReadyWith(found);
    }

    if (found === null) {
      this.known = null;
      this.phase = { kind: "up-to-date", checkedAt: this.now().toISOString() };
      this.log("Updates: Die Suche ist durch, es gibt nichts Neueres.");
      return null;
    }
    const offer = this.buildOffer(found);
    this.known = found;
    this.phase = { kind: "available", offer };
    this.log(`Updates: ${offer.display} ist verfügbar (${offer.delta ? "Delta" : "volles Paket"}, ${offer.downloadBytes} Bytes).`);
    return found;
  }

  /** The ready update becomes the fallback and `newer` the one that is downloaded next. */
  private replaceReadyWith(newer: FoundUpdate): void {
    this.fallback = this.known;
    this.failedNewer = null;
    this.known = newer;
  }

  private async runDownload(adapter: VelopackAdapter, found: FoundUpdate): Promise<void> {
    const offer = this.buildOffer(found);
    this.known = found;
    this.lastProgressAt = 0;
    this.phase = { kind: "downloading", offer, receivedBytes: 0, percent: 0 };
    this.log(`Updates: Herunterladen von ${offer.display} beginnt (${offer.delta ? "Delta" : "volles Paket"}, ${offer.downloadBytes} Bytes).`);
    this.emit();

    try {
      await adapter.download(found, (percent) => this.onProgress(offer, percent));
      // Velopack removed the older package after verifying this one, so the fallback is gone with it.
      this.fallback = null;
      // A newer update that replaced a scheduled one keeps the wish to install when HalfCube closes: the intent behind it
      // ("install the update at exit") holds for the newer version too, and the page can still cancel it.
      this.phase = this.installOnExit ? { kind: "on-exit", offer } : { kind: "ready", offer };
      this.log(`Updates: ${offer.display} ist geladen und geprüft.`);
    } catch (error) {
      const text = errorText(error);
      const code: UpdateErrorCode = isVerificationFailure(text) ? "HC-UPDATE-002" : "HC-UPDATE-003";
      const failure = this.makeError(
        code,
        // Velopack leaves the failed download as a *.partial file in its packages folder; the next download of the same
        // package writes over it, and the next successful download deletes every older *.partial at its end (manager.rs,
        // download_updates). HalfCube never uses it and does not touch that folder itself (an updater may still run there).
        code === "HC-UPDATE-002"
          ? "The downloaded update package failed verification and is not used; the next successful download replaces it."
          : "Downloading the update failed.",
        error,
      );
      this.log(`Updates: Das Herunterladen von ${offer.display} ist fehlgeschlagen (${failure.code}): ${failure.detail}`);
      const fallback = this.fallback;
      if (fallback) {
        // The older update is still on disk and stays ready (and scheduled, if it was); the newer one can be retried.
        this.fallback = null;
        this.failedNewer = found;
        this.known = fallback;
        const newerDownloadFailed: NewerDownloadFailure = { offer, error: failure };
        const readyOffer = this.buildOffer(fallback);
        this.phase = this.installOnExit ? { kind: "on-exit", offer: readyOffer, newerDownloadFailed } : { kind: "ready", offer: readyOffer, newerDownloadFailed };
        this.log(`Updates: ${readyOffer.display} bleibt ${this.installOnExit ? "zum Beenden vorgemerkt" : "bereit"}.`);
      } else {
        // Nothing is downloaded now, so there is nothing to install at exit; the next due check retries the download.
        this.installOnExit = false;
        this.phase = { kind: "download-failed", offer, error: failure };
      }
    }
    this.emit();
  }

  /** True when `found` is newer than the installed version by SemVer precedence; an unreadable version never is. */
  private isNewerThanInstalled(found: FoundUpdate): boolean {
    const order = compareSemVer(found.version, this.installedVersion);
    return order !== null && order > 0;
  }

  private isNewer(found: FoundUpdate, current: FoundUpdate): boolean {
    const order = compareSemVer(found.version, current.version);
    return order !== null && order > 0;
  }

  /** The adapter's answer with the feed-controlled parts bounded: notes cut to MAX_NOTES_LENGTH, a sane byte count. */
  private sanitize(found: FoundUpdate): FoundUpdate {
    const notes = typeof found.notesMarkdown === "string" ? found.notesMarkdown : "";
    const notesMarkdown = truncateNotes(notes);
    if (notesMarkdown.length !== notes.length) this.log(`Updates: Die Release-Notes von ${found.version} sind ${notes.length} Zeichen lang und werden gekürzt.`);
    const downloadBytes = Number.isFinite(found.downloadBytes) && found.downloadBytes >= 0 ? found.downloadBytes : 0;
    return { ...found, notesMarkdown, downloadBytes };
  }

  private onProgress(offer: UpdateOffer, rawPercent: number): void {
    if (this.phase.kind !== "downloading") return;
    const percent = Math.min(100, Math.max(0, Number.isFinite(rawPercent) ? rawPercent : 0));
    this.phase = { kind: "downloading", offer, receivedBytes: Math.round((offer.downloadBytes * percent) / 100), percent };
    const at = this.now().getTime();
    const interval = this.options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    if (percent >= 100 || at - this.lastProgressAt >= interval) {
      this.lastProgressAt = at;
      this.emit();
    }
  }

  private buildOffer(found: FoundUpdate): UpdateOffer {
    const channel = this.options.channel;
    if (channel === "dev") throw new Error("A dev build has no update offers.");
    const mapped = mapPackVersion(found.version, channel, found.notesMarkdown);
    // A version that is not one of the shapes of the installer script is shown as it came, with a "v".
    const id = mapped?.id ?? `v${found.version}`;
    return { id, channel, display: formatVersion(id, channel), downloadBytes: found.downloadBytes, delta: found.delta, notesMarkdown: found.notesMarkdown };
  }

  /** The complete English cause with channel, source and the original text, for "Details" and the copied message. */
  private makeError(code: UpdateErrorCode, what: string, cause: unknown): UpdateError {
    const detail = `${what} Channel: ${this.options.channel}. Source: ${describeFeed(this.options.feed)}. Cause: ${errorText(cause)}`;
    return { code, detail, at: this.now().toISOString() };
  }

  private log(line: string): void {
    this.options.log(line);
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (error) {
        this.log(`Updates: Ein Empfänger des Zustands ist fehlgeschlagen: ${errorText(error)}`);
      }
    }
  }
}
