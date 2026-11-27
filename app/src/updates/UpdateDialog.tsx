// The update window (mockup variant 2): installed and new version side by side with their channel badges, the download size, how
// many versions are skipped, a scrolling preview of the entries since the installed version, "Später" and the main action. The
// progress runs inside it. It opens only from the update slot or the dot's slot ("Update anzeigen", "Fortschritt anzeigen"), so
// only when an update really exists. The update downloads by itself in the background (owner decision, like Fusion), so the window
// shows the progress and, when the download is done, "Jetzt neu starten". The restart warning comes after the click on that button,
// never by itself when the download ends. Only after a failed download the window offers "Erneut versuchen".
import { useId, useMemo, useRef, type ReactNode } from "react";
import { useI18n } from "../i18n/runtime.ts";
import { Button } from "../ui/Button.tsx";
import { cx } from "../ui/cx.ts";
import { ErrorNotice } from "../ui/ErrorNotice.tsx";
import { IconArrowRight, IconRefresh } from "../ui/icons.tsx";
import { Modal } from "../ui/Modal.tsx";
import { NotchCloseButton, NotchFrame } from "../ui/NotchFrame.tsx";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { currentVersion } from "../version.ts";
import { cancelInstallOnExit, requestRestart, startDownload } from "./actions.ts";
import { ChannelBadge } from "./Badges.tsx";
import { useUpdates } from "./controller.ts";
import { describeUpdateError } from "./errors.ts";
import { formatProgressSize, formatSize } from "./format.ts";
import { AllChangesLink } from "./AllChangesLink.tsx";
import { NewerHint } from "./NewerHint.tsx";
import { EntryBody } from "./NewsEntries.tsx";
import { entryOfVersion } from "./news-logic.ts";
import type { UpdateOffer, UpdatePhase } from "./types.ts";
import { updateUi } from "./ui-state.ts";
import { downloadPercent, isSupported, isVerifying, newerFailure, offerOf } from "./view-model.ts";

function VersionBox({ label, id, display, badge, fresh }: { label: string; id: string; display: string; badge: ReactNode; fresh: boolean }) {
  return (
    <div className={cx("relative overflow-hidden rounded-card border border-line py-2.5 pr-3 pl-[15px]", fresh ? "bg-primary-soft" : "bg-surface-2")} data-testid={fresh ? "update-new" : "update-installed"} data-version={id}>
      <span aria-hidden="true" className={cx("absolute top-0 bottom-0 left-0 w-[3px]", fresh ? "bg-primary" : "bg-line-strong")} />
      <div className={cx("flex h-5 items-center gap-2 text-[11.5px] font-medium", fresh ? "text-fg" : "text-muted")}>
        {label}
        {badge}
      </div>
      <span className="mono mt-0.5 block text-[13px] font-medium">{display}</span>
    </div>
  );
}

function Progress({ phase, offer }: { phase: UpdatePhase; offer: UpdateOffer }) {
  const { t, language } = useI18n();
  const percent = downloadPercent(phase);
  const verifying = isVerifying(phase);
  let text: ReactNode = t("updates.window.phaseFound");
  let size = "";
  let bar = 0;
  let green = false;
  if (phase.kind === "downloading") {
    bar = percent;
    text = (
      <>
        <b className="font-semibold">{verifying ? t("updates.window.phaseVerifying") : t("updates.window.phaseDownloading", { percent })}</b>
        {!verifying ? <span className="mt-0.5 block text-muted">{t("updates.window.phaseDownloadingHint")}</span> : null}
      </>
    );
    size = verifying ? formatSize(offer.downloadBytes, language) : formatProgressSize(phase.receivedBytes, offer.downloadBytes, language);
  } else if (phase.kind === "ready") {
    text = t("updates.window.phaseReady");
    bar = 100;
    green = true;
  } else if (phase.kind === "on-exit") {
    text = t("updates.window.phaseExit");
    bar = 100;
    green = true;
  }
  return (
    <div className="mt-3 min-h-[52px]" data-testid="update-progress" data-percent={bar} aria-live="polite">
      <div className="flex min-h-9 justify-between gap-3 text-[12.5px]">
        <span data-testid="update-phase-text">{text}</span>
        <span className="mono whitespace-nowrap text-muted" data-testid="update-size">
          {size}
        </span>
      </div>
      <div className={cx("mt-1 h-1 overflow-hidden rounded-sm bg-progress-track", bar === 0 && "invisible")}>
        <i className={cx("block h-full", green ? "bg-toggle-on" : "bg-primary")} style={{ width: `${bar}%` }} />
      </div>
    </div>
  );
}

export function UpdateDialog({ open }: { open: boolean }) {
  const { t, language } = useI18n();
  const { state } = useUpdates();
  const titleId = useId();
  const primary = useRef<HTMLButtonElement>(null);
  const later = useRef<HTMLButtonElement>(null);
  const supported = isSupported(state) ? state : null;
  const phase = supported?.phase ?? ({ kind: "none" });
  const offer = offerOf(phase);
  const installed = currentVersion();

  // Only what is new in the offered version: its own entry of the release notes (the skipped ones are behind "Alle Änderungen anzeigen").
  const entry = useMemo(() => (offer ? entryOfVersion(offer.notesMarkdown, language, offer.id) : null), [offer, language]);

  const close = () => updateUi.closeView();
  const failed = phase.kind === "download-failed";
  // "available" is the moment before the automatic download starts: the same busy button as while it runs.
  const downloading = phase.kind === "downloading" || phase.kind === "available";
  const title = {
    available: t("updates.window.titleFound"),
    downloading: t("updates.window.titleDownloading"),
    ready: t("updates.window.titleReady"),
    "on-exit": t("updates.window.titleExit"),
    "download-failed": t("updates.window.titleFailed"),
  } as Partial<Record<UpdatePhase["kind"], string>>;
  const heading = title[phase.kind] ?? t("updates.window.titleFound");

  const mainAction = (() => {
    if (phase.kind === "ready" || phase.kind === "on-exit") return { label: t("updates.restartNow"), run: requestRestart };
    return null;
  })();
  const error = phase.kind === "download-failed" ? describeUpdateError(phase.error, t, supported?.channel ?? "") : null;

  return (
    <Modal
      open={open && offer !== null}
      onClose={close}
      aria-labelledby={titleId}
      top="compact"
      initialFocus={downloading || failed ? later : primary}
      className="w-[min(640px,calc(100vw-32px))]"
    >
      <NotchFrame action={<NotchCloseButton label={t("updates.window.close")} onClick={close} data-testid="update-close" />} data-testid="update-window" data-phase={phase.kind}>
        <div className="flex flex-col text-fg">
          <h2 id={titleId} className="mt-1 flex min-h-10 items-center px-14 pl-6 text-[15px] font-semibold" data-testid="update-title">
            {heading}
          </h2>
          <div className="px-6 pt-3">
            {error ? (
              <ErrorNotice headline={error.headline} code={error.code} details={error.details} occurredAt={error.occurredAt} detailsMaxHeight="min(40vh, 320px)" defaultOpen />
            ) : offer ? (
              <>
                <div className="mt-1 grid grid-cols-[1fr_28px_1fr] items-stretch">
                  <VersionBox label={t("updates.window.installed")} id={installed.id} display={installed.display} badge={<ChannelBadge channel={installed.channel} />} fresh={false} />
                  <div className="grid place-items-center text-muted">
                    <IconArrowRight size={18} />
                  </div>
                  <VersionBox label={t("updates.window.newVersion")} id={offer.id} display={offer.display} badge={<ChannelBadge channel={offer.channel} />} fresh />
                </div>
                <dl className="mt-3 grid grid-cols-[96px_1fr] gap-x-2.5 gap-y-[3px] text-[12.5px]" data-testid="update-facts">
                  <dt className="text-muted">{t("updates.window.download")}</dt>
                  <dd className="m-0" data-testid="update-download">
                    {t(offer.delta ? "updates.window.downloadDelta" : "updates.window.downloadFull", { size: formatSize(offer.downloadBytes, language) })}
                  </dd>
                </dl>
                <div className="mt-3.5 text-[13px] font-semibold" data-testid="update-notes-heading">
                  {t("updates.window.notesHeading", { version: offer.display })}
                </div>
                <div className="mt-2 rounded-card border border-line bg-surface">
                  <ScrollArea className="h-[clamp(96px,calc(100vh-480px),176px)]" data-testid="update-notes">
                    {entry ? (
                      <EntryBody entry={entry} language={language} compact className="px-4 py-2" />
                    ) : (
                      <p className="px-4 py-3 text-[12.5px] text-muted">{t("updates.window.notesNone")}</p>
                    )}
                  </ScrollArea>
                </div>
                <AllChangesLink source="update" />
                <Progress phase={phase} offer={offer} />
                <NewerHint failure={newerFailure(phase)} className="mt-2 min-h-10" />
              </>
            ) : null}
          </div>
          <div className="flex items-center justify-end gap-2 px-6 pt-3.5 pb-[18px]">
            {phase.kind === "on-exit" ? (
              <Button ref={later} onClick={cancelInstallOnExit} data-testid="update-cancel-exit">
                {t("updates.cancelOnExit")}
              </Button>
            ) : (
              <Button ref={later} onClick={close} data-testid="update-later">
                {phase.kind === "available" || phase.kind === "downloading" || phase.kind === "ready" ? t("updates.window.later") : t("updates.window.close2")}
              </Button>
            )}
            {failed ? (
              <Button ref={primary} variant="primary" icon={<IconRefresh />} onClick={startDownload} data-testid="update-retry">
                {t("updates.retry")}
              </Button>
            ) : downloading ? (
              <Button variant="primary" loading className="min-w-[176px] opacity-100!" data-testid="update-main">
                {t("updates.restartNow")}
              </Button>
            ) : mainAction ? (
              <Button ref={primary} variant="primary" onClick={mainAction.run} className="min-w-[176px]" data-testid="update-main">
                {mainAction.label}
              </Button>
            ) : null}
          </div>
        </div>
      </NotchFrame>
    </Modal>
  );
}
