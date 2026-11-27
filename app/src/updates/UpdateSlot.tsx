// The update slot at the top of the Info tab of "Über HalfCube": one card of fixed height that shows exactly one state (no update
// known, checking, up to date, found, downloading, ready, scheduled for exit, error), so the view never jumps. "Nach Updates
// suchen" is always there, at the same spot: while a check runs its spinner covers the invisible label, while a download runs
// it is disabled with the reason in its tooltip, and it is filled only when no other action is the main one.
import type { ReactNode } from "react";
import { useI18n } from "../i18n/runtime.ts";
import type { MessageKey } from "../i18n/types.ts";
import { Button } from "../ui/Button.tsx";
import { cx } from "../ui/cx.ts";
import { IconCircleCheck, IconRefresh, IconSettings, IconSparkles } from "../ui/icons.tsx";
import { Tip } from "../ui/Tip.tsx";
import { Glyph } from "../ui/Glyph.tsx";
import { cancelInstallOnExit, openNews, openSettings, openUpdateError, openUpdateWindow, requestRestart, startDownload } from "./actions.ts";
import { useUpdates, updates } from "./controller.ts";
import { describeWhen, formatProgressSize, useNow } from "./format.ts";
import { Ring, TriangleBadge } from "./InfoButton.tsx";
import { NewerHint } from "./NewerHint.tsx";
import { checkDisabled, checkIsPrimary, downloadPercent, isSupported, isVerifying, newerFailure, offerOf, slotKind, type SlotKind, type SupportedState } from "./view-model.ts";

const tinted = new Set<SlotKind>(["found", "dl", "ready", "exit"]);

/** The one-line headline and the detail text of every state. */
function useSlotTexts(state: SupportedState, kind: SlotKind, lastCheckAt: string | null) {
  const { t, language } = useI18n();
  const { phase } = state;
  const now = useNow();
  const whenOf = (iso: string | null) => {
    const when = iso === null ? null : describeWhen(iso, now, language);
    return when === null ? null : t(when.key, when.params);
  };
  const offer = offerOf(phase);
  const percent = downloadPercent(phase);
  const verifying = isVerifying(phase);
  const lastWhen = whenOf(lastCheckAt);
  const checkedWhen = whenOf(phase.kind === "up-to-date" ? phase.checkedAt : lastCheckAt);
  const tr = (key: MessageKey, params?: Record<string, string | number>) => t(key, params);

  switch (kind) {
    case "none":
      return { head: lastWhen ? tr("updates.slotNone", { when: lastWhen }) : tr("updates.slotNoneNever"), detail: tr("updates.detailNone") };
    case "checking":
      return { head: tr("updates.slotChecking"), detail: tr("updates.detailChecking") };
    case "uptodate":
      return { head: tr("updates.slotUpToDate"), detail: checkedWhen ? tr("updates.detailUpToDate", { when: checkedWhen }) : "" };
    case "found":
      return { head: tr("updates.slotFound", { version: offer?.display ?? "" }), detail: tr("updates.detailFound") };
    case "dl": {
      const total = offer?.downloadBytes ?? 0;
      const received = phase.kind === "downloading" ? phase.receivedBytes : 0;
      return {
        head: verifying ? tr("updates.slotVerifying") : tr("updates.slotDownloading", { percent }),
        detail: verifying ? tr("updates.detailVerifying") : tr("updates.detailDownloading", { size: formatProgressSize(received, total, language) }),
      };
    }
    case "ready":
      return { head: tr("updates.slotReady"), detail: tr("updates.detailReady") };
    case "exit":
      return { head: tr("updates.slotExit"), detail: tr("updates.detailExit") };
    case "failed":
      return { head: tr("updates.slotCheckFailed"), detail: "" };
    case "faildl":
      return { head: tr("updates.slotDownloadFailed"), detail: "" };
  }
}

function Lead({ kind, pct }: { kind: SlotKind; pct: number }) {
  switch (kind) {
    case "none":
      return <IconRefresh size={18} className="text-muted" />;
    case "checking":
      return (
        <span className="size-4 animate-[hc-spin_0.9s_linear_infinite] rounded-full border-2 border-[rgb(127_127_127/0.35)] border-t-primary" role="presentation" />
      );
    case "uptodate":
      return <IconCircleCheck size={18} className="text-toggle-on" />;
    case "found":
      return <span className="size-2.5 rounded-full bg-primary" />;
    case "dl":
      return <Ring pct={pct} size={20} radius={8} className="size-5 -rotate-90" />;
    case "ready":
      return (
        <span className="grid size-[14px] place-items-center rounded-full bg-primary text-[10px] text-on-primary">
          <Glyph name="check" />
        </span>
      );
    case "exit":
      return <span className="size-3 rounded-full border-2 border-primary bg-primary-soft" data-mark="ring" />;
    case "failed":
    case "faildl":
      return <TriangleBadge className="size-4 [--halo:var(--c-surface)]" />;
  }
}

/** The error line of a failed check or download: the short headline with its code, as in the error notice. */
function ErrorLine({ state, kind }: { state: SupportedState; kind: SlotKind }) {
  const { t } = useI18n();
  const { phase } = state;
  const error = phase.kind === "check-failed" || phase.kind === "download-failed" ? phase.error : null;
  if (error === null) return null;
  const key = `updates.errorHeadline${error.code.slice(-1)}` as MessageKey;
  return (
    <span data-testid="update-slot-error" data-error-code={error.code} data-kind={kind}>
      {t(key)} <span className="mono text-[12px] whitespace-nowrap text-muted">({error.code})</span>
    </span>
  );
}

const outlineOnCard = "bg-surface! hover:bg-surface-2!";

export function UpdateSlot() {
  const { t } = useI18n();
  const { state, lastCheckAt } = useUpdates();
  if (!isSupported(state)) return null;
  return <SlotCard state={state} lastCheckAt={lastCheckAt} t={t} />;
}

function SlotCard({ state, lastCheckAt, t }: { state: SupportedState; lastCheckAt: string | null; t: ReturnType<typeof useI18n>["t"] }) {
  const kind = slotKind(state);
  const texts = useSlotTexts(state, kind, lastCheckAt);
  const failed = kind === "failed" || kind === "faildl";
  const disabled = checkDisabled(state);
  const busy = state.checking && !disabled;
  const pct = downloadPercent(state.phase);
  const barPct = kind === "dl" ? pct : kind === "ready" || kind === "exit" ? 100 : 0;
  const filled = checkIsPrimary(kind);
  const failure = newerFailure(state.phase);

  type SlotAction = { label: string; onClick: () => void; primary: boolean; testId: string };
  // The update downloads by itself, so there is no "download" action: the slot shows the progress, then "Jetzt neu starten". After a
  // failed download it offers "Erneut versuchen" and "Details".
  const actions: SlotAction[] = (() => {
    switch (kind) {
      case "found":
        return [{ label: t("updates.showUpdate"), onClick: openUpdateWindow, primary: true, testId: "update-slot-show" }];
      case "dl":
        return [{ label: t("updates.showProgress"), onClick: openUpdateWindow, primary: true, testId: "update-slot-progress" }];
      case "ready":
        return [{ label: t("updates.restartNow"), onClick: requestRestart, primary: true, testId: "update-slot-restart" }];
      case "exit":
        return [{ label: t("updates.restartNow"), onClick: requestRestart, primary: true, testId: "update-slot-restart" }];
      case "failed":
        return [{ label: t("updates.showDetails"), onClick: openUpdateError, primary: true, testId: "update-slot-details" }];
      case "faildl":
        return [
          { label: t("updates.showDetails"), onClick: openUpdateWindow, primary: false, testId: "update-slot-details" },
          { label: t("updates.retry"), onClick: startDownload, primary: true, testId: "update-slot-retry" },
        ];
      case "none":
      case "checking":
      case "uptodate":
        return [];
    }
  })();

  const checkButton = (
    <Button
      size="sm"
      variant={filled ? "primary" : "neutral"}
      loading={busy}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) void updates.checkNow();
      }}
      data-testid="update-check"
      className={cx(
        "w-[198px] opacity-100!",
        !filled && outlineOnCard,
        disabled && "cursor-not-allowed! border-line-strong! bg-surface! text-muted! hover:bg-surface!",
      )}
      icon={<IconRefresh />}
    >
      {t("updates.checkNow")}
    </Button>
  );

  return (
    <div className="mt-2 flex flex-col" data-testid="update-slot" data-slot={kind}>
      <div
        role="group"
        aria-label={t("updates.slotLabel")}
        aria-live="polite"
        className={cx(
          "relative overflow-hidden rounded-card border border-line py-2 pr-3.5 pl-[17px]",
          failure ? "h-[168px]" : "h-[128px]",
          tinted.has(kind) ? "bg-primary-soft" : failed ? "bg-surface" : "bg-surface-2",
        )}
      >
        <span aria-hidden="true" className={cx("absolute top-0 bottom-0 left-0 w-[3px]", failed ? "bg-destructive" : tinted.has(kind) ? "bg-primary" : "bg-line-strong")} />
        <div className="flex h-9 items-center gap-2.5">
          <span className="relative grid size-5 flex-none place-items-center" aria-hidden="true">
            <Lead kind={kind} pct={pct} />
          </span>
          <span className="min-w-0 flex-1 text-[13.5px] font-semibold" data-testid="update-slot-head">
            {texts.head}
          </span>
          {actions.map((action) => (
            <Button key={action.testId} size="sm" variant={action.primary ? "primary" : "neutral"} onClick={action.onClick} data-testid={action.testId} className={cx(!action.primary && outlineOnCard)}>
              {action.label}
            </Button>
          ))}
        </div>
        <div className="mt-0.5 min-h-[38px] text-[12.5px] leading-[1.45]" data-testid="update-slot-detail">
          {failed ? <ErrorLine state={state} kind={kind} /> : texts.detail}
          {kind === "exit" ? (
            <>
              {" "}
              <button type="button" onClick={cancelInstallOnExit} data-testid="update-cancel-exit" className="cursor-pointer rounded-sm font-semibold text-fg underline">
                {t("updates.cancelOnExit")}
              </button>
            </>
          ) : null}
        </div>
        <div
          aria-hidden="true"
          className={cx("absolute left-[17px] h-1 overflow-hidden rounded-sm bg-progress-track", "right-[224px]", failure ? "bottom-16" : "bottom-6", barPct === 0 && "invisible")}
          data-testid="update-slot-bar"
        >
          <i className={cx("block h-full", kind === "dl" ? "bg-primary" : "bg-toggle-on")} style={{ width: `${barPct}%` }} />
        </div>
        <div className={cx("absolute right-3.5", failure ? "bottom-[50px]" : "bottom-2.5")}>
          {disabled ? (
            <Tip label={t("updates.checkDisabledDownloading")} side="top" align="end">
              {checkButton}
            </Tip>
          ) : (
            checkButton
          )}
        </div>
        {/* Rare: a newer update whose download failed while the older one stays ready. The card grows by this row; the rest keeps its place. */}
        <NewerHint failure={failure} className="absolute inset-x-0 bottom-0 h-10 border-t border-line pr-3.5 pl-[17px]" />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2">
        <LinkButton onClick={openNews} icon={<IconSparkles />} testId="update-news-link">
          {t("updates.showNews")}
        </LinkButton>
        <LinkButton onClick={() => openSettings("updates")} icon={<IconSettings />} testId="update-settings-link">
          {t("updates.updateSettings")}
        </LinkButton>
      </div>
    </div>
  );
}

export function LinkButton({ onClick, icon, children, testId }: { onClick: () => void; icon: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-ctl px-1 text-[13px] font-medium text-primary hover:underline"
    >
      <span className="inline-flex text-base">{icon}</span>
      {children}
    </button>
  );
}
