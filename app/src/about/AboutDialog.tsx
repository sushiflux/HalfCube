// "About HalfCube" (compact layout with a brand strip): one dialog with a dark brand strip on the
// left (logo, wordmark, version with channel symbol, labels, copyright and credit line) and two tabs on the right,
// "Info" and "Lizenzen". The height of the dialog is the height of the Info tab; the Lizenzen tab lies over it with exactly
// that height and scrolls inside. The credit line closes the strip on the same line as the last row of the right column.
import { useId, useMemo, useRef, type RefObject } from "react";
import { useI18n } from "../i18n/runtime.ts";
import { detectPlatform } from "../platform.ts";
import { CreditLine, Logo, Wordmark } from "../ui/Brand.tsx";
import { cx } from "../ui/cx.ts";
import { Glyph } from "../ui/Glyph.tsx";
import { Modal } from "../ui/Modal.tsx";
import { NotchFrame, NOTCH_BUTTON } from "../ui/NotchFrame.tsx";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { currentVersion, type Channel } from "../version.ts";
import { AboutInfo } from "./AboutInfo.tsx";
import { AboutLicences } from "./AboutLicences.tsx";
import "./about.css";
import { buildItems, EARLY_ACCESS } from "./catalogue.ts";
import { thirdParty } from "./licences-data.ts";
import { aboutStore, useAbout } from "./state.ts";
import type { AboutTab } from "../screens/main/url-state.ts";

const channelKeys: Record<Exclude<Channel, "release">, "about.channelDev" | "about.channelNightly" | "about.channelBeta"> = {
  dev: "about.channelDev",
  nightly: "about.channelNightly",
  beta: "about.channelBeta",
};

function BrandStrip() {
  const { t } = useI18n();
  const version = currentVersion();
  return (
    <aside className="hc-about-strip m-px flex flex-col rounded-l-[5px] px-[22px] pt-[30px] pb-[21px]" data-testid="about-strip">
      <Logo size={84} source="large" />
      <Wordmark size={30} className="mt-4" />
      <div className="mono mt-3.5 text-[12px] [overflow-wrap:anywhere] text-[#e7f0f5]" data-testid="about-version">
        {version.display}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {version.channel !== "release" ? (
          <span className="hc-about-chip" data-kind={version.channel} data-testid="about-channel">
            {t(channelKeys[version.channel])}
          </span>
        ) : null}
        {EARLY_ACCESS ? (
          <span className="hc-about-chip" data-kind="early" data-testid="about-early">
            {t("about.early")}
          </span>
        ) : null}
      </div>
      {/* The two last rows are as tall as the last row of the right column (32 px, 13 px text, centred), so their text lines meet. */}
      <div className="hc-about-foot mt-auto pt-3 text-[13px] leading-[1.45]">
        <div className="flex h-[22px] items-center" data-testid="about-copyright">
          {t("about.copyright")}
        </div>
        <div className="flex h-8 items-center" data-testid="about-credit">
          <CreditLine onDark />
        </div>
      </div>
    </aside>
  );
}

function CloseButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => aboutStore.close()}
      data-testid="about-close"
      style={{ width: NOTCH_BUTTON, height: NOTCH_BUTTON }}
      // The drawn button is 30 px, its invisible hit area 48 px (the ::after).
      className="relative inline-grid cursor-pointer place-items-center rounded-ctl bg-destructive text-[16px] text-on-destructive after:absolute after:-inset-[9px] after:content-[''] hover:brightness-95 dark:hover:brightness-110"
    >
      <Glyph name="close" />
    </button>
  );
}

export function AboutDialog({ ready }: { ready: boolean }) {
  const { t } = useI18n();
  const state = useAbout();
  // The dialog keeps showing the last state while it fades out.
  const shown = state ?? aboutStore.lastOpen();

  const titleId = useId();
  const tabs = useRef<HTMLDivElement>(null);
  // The keyboard starts on the active tab, not on the close button.
  const initialFocus = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return tabs.current?.querySelector<HTMLElement>("[role=tab][aria-selected=true]") ?? null;
      },
    }),
    [],
  );
  const items = useMemo(() => buildItems(thirdParty, detectPlatform(), currentVersion().id.slice(1)), []);
  const info = shown.tab === "info";

  return (
    <Modal
      open={ready && state !== null}
      onClose={() => aboutStore.close()}
      aria-labelledby={titleId}
      initialFocus={initialFocus}
      top="compact"
      className="w-[min(820px,calc(100vw-32px))]"
    >
      <NotchFrame action={<CloseButton label={t("about.close")} />} data-testid="about-dialog" data-tab={shown.tab}>
        <div className="grid grid-cols-[226px_minmax(0,1fr)] text-fg">
          <BrandStrip />
          <div className="flex min-w-0 flex-col">
            <h2 id={titleId} className="mt-1 flex h-9 flex-none items-center pr-14 pl-6 text-[15px] font-semibold">
              {t("about.title")}
            </h2>
            <div ref={tabs} className="flex flex-none px-6">
              <Segmented<AboutTab>
                tabs
                label={t("about.tabs")}
                value={shown.tab}
                onChange={(tab) => aboutStore.setTab(tab)}
                options={[
                  { value: "info", label: t("about.tabInfo"), testId: "about-tab-info" },
                  { value: "licenses", label: t("about.tabLicences"), testId: "about-tab-licenses" },
                ]}
              />
            </div>
            <div className="relative" data-testid="about-panes">
              <div role="tabpanel" aria-label={t("about.tabInfo")} inert={!info} className={cx(!info && "invisible")}>
                {/* The Info tab sets the height of the dialog; in a window too low for it, it scrolls inside (the update slot made it taller). */}
                <ScrollArea viewportClassName="max-h-[calc(100vh-142px)]" data-testid="about-info-scroll">
                  <AboutInfo items={items} />
                </ScrollArea>
              </div>
              <div
                role="tabpanel"
                aria-label={t("about.tabLicences")}
                inert={info}
                data-testid="about-licences-pane"
                className={cx("absolute inset-0 flex min-h-0 flex-col", info && "invisible")}
              >
                <AboutLicences items={items} itemId={shown.item} />
              </div>
            </div>
          </div>
        </div>
      </NotchFrame>
    </Modal>
  );
}
