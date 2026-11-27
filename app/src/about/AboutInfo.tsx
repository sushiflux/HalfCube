// The "Info" tab of "About HalfCube": the early-access note, the licence in short, the links, the one line that names the
// LGPL components with their copyright (LGPL-2.1 section 6: the program shows a copyright notice, so it carries theirs too),
// and the technical details with "Copy version".
import { useCallback } from "react";
import { useI18n } from "../i18n/runtime.ts";
import { getDesktopBridge } from "../platform.ts";
import { Button } from "../ui/Button.tsx";
import { CopyButton } from "../ui/CopyButton.tsx";
import { ExternalLink } from "../ui/ExternalLink.tsx";
import { IconFileText, IconGithub, IconExternal, IconSparkles } from "../ui/icons.tsx";
import { openNews } from "../updates/actions.ts";
import { useUpdates } from "../updates/controller.ts";
import { LinkButton, UpdateSlot } from "../updates/UpdateSlot.tsx";
import { isSupported } from "../updates/view-model.ts";
import { currentVersion } from "../version.ts";
import { kernelVersion, lgplItems, lgplLibraries, LICENCE_ITEM, NOTICE_ITEM, REPOSITORY_URL } from "./catalogue.ts";
import { aboutStore } from "./state.ts";
import type { LicenceItem } from "./types.ts";
import { versionReport } from "./version-report.ts";

export function AboutInfo({ items }: { items: readonly LicenceItem[] }) {
  const { t } = useI18n();
  const display = currentVersion().display;
  const electron = getDesktopBridge()?.versions.electron || null;
  const kernel = kernelVersion(items);
  const getText = useCallback(() => versionReport(display, electron, kernel), [display, electron, kernel]);
  const lgpl = lgplItems(items).length > 0 ? lgplLibraries(items, t("about.lgplAnd")) : "";
  const hasSlot = isSupported(useUpdates().state);

  return (
    <div className="px-6 pt-4 pb-[22px]" data-testid="about-info">
      {hasSlot ? (
        <section aria-labelledby="about-updates-title">
          <h3 id="about-updates-title" className="text-[13px] font-semibold">
            {t("updates.heading")}
          </h3>
          <UpdateSlot />
        </section>
      ) : null}
      <div className={`relative overflow-hidden rounded-card border border-line bg-surface-2 py-3 pr-3.5 pl-4 text-[13px]${hasSlot ? " mt-4" : ""}`}>
        <span className="absolute top-0 bottom-0 left-0 w-[3px] bg-primary" aria-hidden="true" />
        {t("about.earlyText")}
      </div>

      <section className="mt-4" aria-labelledby="about-licence-title">
        <h3 id="about-licence-title" className="mb-1.5 text-[13px] font-semibold">
          {t("about.licenceTitle")}
        </h3>
        <p className="text-[13px]" data-testid="about-licence-summary">
          {t("about.licenceSummary")}
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button size="sm" icon={<IconFileText />} onClick={() => aboutStore.open({ tab: "licenses", item: LICENCE_ITEM })} data-testid="about-show-licence">
            {t("about.showLicence")}
          </Button>
          <button
            type="button"
            onClick={() => aboutStore.open({ tab: "licenses", item: NOTICE_ITEM })}
            data-testid="about-show-notice"
            className="inline-flex h-8 cursor-pointer items-center gap-[7px] rounded-ctl px-1 text-[13px] font-medium text-primary hover:underline"
          >
            <span className="inline-flex text-base">
              <IconFileText />
            </span>
            {t("about.showNotice")}
          </button>
        </div>
        <div className="mt-3">
          <ExternalLink href={REPOSITORY_URL} data-testid="about-source" className="inline-flex items-center gap-[5px] rounded-ctl text-[13px] font-medium text-primary hover:underline">
            <span className="inline-flex text-base">
              <IconGithub />
            </span>
            {t("about.source")}
            <span className="inline-flex text-[14px]">
              <IconExternal />
            </span>
          </ExternalLink>
        </div>
        {lgpl !== "" ? (
          <p className="mt-3 text-[12px] leading-snug text-muted" data-testid="about-lgpl">
            {t("about.lgplLine", { libraries: lgpl })}{" "}
            <span aria-hidden="true">· </span>
            <button
              type="button"
              onClick={() => aboutStore.open({ tab: "licenses" })}
              data-testid="about-lgpl-link"
              className="cursor-pointer rounded-sm font-medium text-primary hover:underline"
            >
              {t("about.lgplLink")}
            </button>
          </p>
        ) : null}
      </section>

      <section className="mt-4" aria-labelledby="about-tech-title">
        <h3 id="about-tech-title" className="mb-1.5 text-[13px] font-semibold">
          {t("about.techTitle")}
        </h3>
        <dl className="mt-2 grid grid-cols-[148px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]" data-testid="about-tech">
          {electron ? (
            <>
              <dt className="text-muted">{t("about.techElectron")}</dt>
              <dd className="mono m-0" data-testid="about-electron">
                {electron}
              </dd>
            </>
          ) : null}
          {kernel ? (
            <>
              <dt className="text-muted">{t("about.techKernel")}</dt>
              <dd className="mono m-0" data-testid="about-kernel">
                OCCT {kernel}
              </dd>
            </>
          ) : null}
        </dl>
        <div className="mt-1.5 -ml-2 flex flex-wrap items-center gap-x-3">
          <span data-testid="about-copy-version">
            <CopyButton getText={getText} variant="quiet" size="sm" label={t("about.copyVersion")} className="px-2" />
          </span>
          {hasSlot ? null : (
            <LinkButton onClick={openNews} icon={<IconSparkles />} testId="update-news-link">
              {t("updates.showNews")}
            </LinkButton>
          )}
        </div>
      </section>
    </div>
  );
}
