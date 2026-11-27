// The tab "Updates" of the settings dialog (mockup "geteilt-einstellungen"): the channel (read-only, set by the installer), the
// installed version, "Jetzt nach Updates suchen" with its result, how often HalfCube checks by itself (a vertical segmented choice
// with a help text) and "Was ist neu". A program without an updater shows what makes sense there: the version, a note and
// "Was ist neu".
import { useI18n } from "../i18n/runtime.ts";
import type { MessageKey } from "../i18n/types.ts";
import { settingsStore, useSettings } from "../prefs/settings-runtime.ts";
import { Row } from "../screens/main/SettingsRow.tsx";
import { Button } from "../ui/Button.tsx";
import { ErrorNotice } from "../ui/ErrorNotice.tsx";
import { IconCircleCheck, IconDownload, IconRefresh, IconSparkles } from "../ui/icons.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { currentVersion } from "../version.ts";
import { openAboutInfo, openNews } from "./actions.ts";
import { ChannelBadge } from "./Badges.tsx";
import { updates, useUpdates } from "./controller.ts";
import { describeUpdateError } from "./errors.ts";
import { describeWhen, useNow } from "./format.ts";
import { updateCheckModes, type UpdateCheckMode } from "./schedule.ts";
import { isSupported } from "./view-model.ts";

const modeLabels: Record<UpdateCheckMode, MessageKey> = {
  start: "updates.settings.modeStart",
  day: "updates.settings.modeDay",
  week: "updates.settings.modeWeek",
  manual: "updates.settings.modeManual",
};
const modeHelp: Record<UpdateCheckMode, MessageKey> = {
  start: "updates.settings.startHelp",
  day: "updates.settings.dayHelp",
  week: "updates.settings.weekHelp",
  manual: "updates.settings.manualHelp",
};

export function UpdatesSettings() {
  const { t, language } = useI18n();
  const settings = useSettings();
  const { state, lastCheckAt, manual } = useUpdates();
  const version = currentVersion();
  const now = useNow();
  const newsRow = (
    <Row label={t("updates.settings.news")} testId="setting-update-news">
      <div className="flex min-h-9 flex-wrap items-center gap-2.5">
        <Button icon={<IconSparkles />} onClick={openNews} data-testid="settings-news">
          {t("updates.showNews")}
        </Button>
      </div>
    </Row>
  );

  if (!isSupported(state)) {
    // No updater: a dev build, a portable copy, a copy that was not installed. The state is null until the updater has
    // answered (and on a page without the desktop bridge); no reason is claimed then, the line keeps its height.
    const reason =
      state === null
        ? " "
        : state.reason === "dev-build"
          ? t("updates.settings.unsupportedDev")
          : state.reason === "portable"
            ? t("updates.settings.unsupportedPortable")
            : t("updates.settings.unsupportedNotInstalled");
    return (
      <>
        <Row label={t("updates.settings.version")} testId="setting-update-version">
          <div className="flex min-h-9 items-center gap-2.5">
            <span className="mono text-[13px]" data-testid="settings-version">
              {version.display}
            </span>
          </div>
          <p className="mt-1 text-[12.5px] leading-snug text-muted" data-testid="settings-no-updater">
            {reason}
          </p>
        </Row>
        {newsRow}
      </>
    );
  }

  const busy = state.checking;
  const lastIso = state.phase.kind === "up-to-date" ? state.phase.checkedAt : lastCheckAt;
  const when = lastIso ? describeWhen(lastIso, now, language) : null;
  const lastText = when ? t("updates.settings.lastChecked", { when: t(when.key, when.params) }) : t("updates.settings.neverChecked");
  const error = manual?.kind === "error" ? describeUpdateError(manual.error, t, state.channel) : null;

  return (
    <>
      <Row label={t("updates.settings.channel")} testId="setting-update-channel">
        <div className="flex min-h-9 flex-wrap items-center gap-2.5">
          <ChannelBadge channel={state.channel} />
          <span className="text-[13px] text-muted">{t("updates.settings.channelNote")}</span>
        </div>
      </Row>
      <Row label={t("updates.settings.version")} testId="setting-update-version">
        <div className="flex min-h-9 items-center gap-2.5">
          <span className="mono text-[13px]" data-testid="settings-version">
            {version.display}
          </span>
        </div>
      </Row>
      <Row label={t("updates.settings.check")} testId="setting-update-check">
        <div className="flex min-h-9 flex-wrap items-center gap-2.5">
          <Button
            icon={<IconRefresh />}
            loading={busy}
            aria-disabled={state.phase.kind === "downloading" || undefined}
            onClick={() => {
              if (state.phase.kind !== "downloading") void updates.checkNow();
            }}
            className="opacity-100!"
            data-testid="settings-check"
          >
            {t("updates.settings.checkNow")}
          </Button>
          <span className="text-[13px] text-muted" data-testid="settings-last-checked">
            {lastText}
          </span>
        </div>
        <div className="mt-1.5 flex min-h-[30px] items-center gap-2 text-[13px]" aria-live="polite" data-testid="settings-result">
          {busy ? (
            <>
              <span className="size-4 animate-[hc-spin_0.9s_linear_infinite] rounded-full border-2 border-[rgb(127_127_127/0.35)] border-t-primary" aria-hidden="true" />
              <span>{t("updates.settings.resultChecking")}</span>
            </>
          ) : manual?.kind === "uptodate" ? (
            <>
              <span className="inline-flex text-[17px] text-toggle-on">
                <IconCircleCheck />
              </span>
              <span>{t("updates.settings.resultUpToDate")}</span>
            </>
          ) : manual?.kind === "found" ? (
            <>
              <span className="inline-flex text-[17px] text-toggle-on">
                <IconDownload />
              </span>
              <span>{t("updates.settings.resultFound", { version: manual.version })}</span>
              <button type="button" onClick={openAboutInfo} data-testid="settings-show-update" className="h-7 cursor-pointer rounded-ctl px-1 font-medium text-primary hover:underline">
                {t("updates.settings.resultShow")}
              </button>
            </>
          ) : null}
        </div>
        {error ? (
          <div className="mt-2" data-testid="settings-error">
            <ErrorNotice headline={error.headline} code={error.code} details={error.details} occurredAt={error.occurredAt} />
          </div>
        ) : null}
      </Row>
      <Row label={t("updates.settings.frequency")} testId="setting-update-frequency">
        <Segmented<UpdateCheckMode>
          orientation="vertical"
          label={t("updates.settings.frequency")}
          value={settings.updateCheck}
          onChange={(v) => settingsStore.set("updateCheck", v)}
          options={updateCheckModes.map((mode) => ({ value: mode, label: t(modeLabels[mode]), testId: `update-check-${mode}` }))}
          className="min-w-[232px]"
        />
        <p className="mt-1.5 min-h-9 text-[12.5px] leading-[1.4] text-muted" data-testid="update-check-help">
          {t(modeHelp[settings.updateCheck])}
        </p>
      </Row>
      {newsRow}
    </>
  );
}
