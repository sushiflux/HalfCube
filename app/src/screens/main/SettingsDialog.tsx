// The settings dialog skeleton (every setting lives here and nowhere in the work area). Two areas as a segmented tab
// bar, the active one in the URL (`?settings=display|sketch`). A choice applies and is stored the moment it is made; there is
// no save button, and nothing in the window moves. Colour theme, light or dark and the language have their own stores; the
// rest goes through the settings store, where the sketch settings wait for the sketch tools (step U2).
import type { ReactNode } from "react";
import { i18n, useI18n } from "../../i18n/runtime.ts";
import type { Language } from "../../i18n/types.ts";
import { settingsStore, useSettings } from "../../prefs/settings-runtime.ts";
import { themeStore, useTheme } from "../../theme/runtime.ts";
import { getTheme, themeKeys, type Mode, type ThemeKey } from "../../theme/themes.ts";
import { Dialog } from "../../ui/Dialog.tsx";
import { Segmented } from "../../ui/Segmented.tsx";
import type { SettingsTab } from "./url-state.ts";

function Row({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,200px)_1fr] items-start gap-x-4 gap-y-1 border-b border-line py-3 last:border-b-0 max-[640px]:grid-cols-1" data-testid={testId}>
      <div className="pt-2 text-[13.5px] font-medium">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Three small chips with the theme's own colours, so the list shows what each theme looks like in the current mode. */
function Swatch({ themeKey, mode }: { themeKey: ThemeKey; mode: Mode }) {
  const tokens = getTheme(themeKey).tokens[mode];
  return (
    <span aria-hidden="true" className="inline-flex overflow-hidden rounded-sm border border-line-strong">
      {[tokens.bg, tokens.primary, tokens.accent1].map((colour, i) => (
        <span key={i} className="inline-block h-4 w-3.5" style={{ background: colour }} />
      ))}
    </span>
  );
}

export interface SettingsDialogProps {
  tab: SettingsTab | null;
  onTab: (tab: SettingsTab) => void;
  onClose: () => void;
}

export function SettingsDialog({ tab, onTab, onClose }: SettingsDialogProps) {
  const { t, language } = useI18n();
  const { theme, mode } = useTheme();
  const settings = useSettings();
  // The dialog keeps showing the last area while it fades out.
  const shown: SettingsTab = tab ?? "display";

  return (
    <Dialog open={tab !== null} onClose={onClose} title={t("main.settings.title")} showClose size="lg">
      <div className="pb-1" data-testid="settings-dialog">
        <Segmented<SettingsTab>
          tabs
          label={t("main.settings.tabs")}
          value={shown}
          onChange={onTab}
          options={[
            { value: "display", label: t("main.settings.tabDisplay"), testId: "settings-tab-display" },
            { value: "sketch", label: t("main.settings.tabSketch"), testId: "settings-tab-sketch" },
          ]}
          className="mb-1"
        />
        <div role="tabpanel" className="min-h-[330px]">
          {shown === "display" ? (
            <>
              <Row label={t("main.settings.theme")} testId="setting-theme">
                <Segmented<ThemeKey>
                  orientation="vertical"
                  label={t("main.settings.theme")}
                  value={theme}
                  onChange={(key) => themeStore.setTheme(key)}
                  options={themeKeys.map((key) => ({
                    value: key,
                    testId: `theme-${key}`,
                    label: (
                      <>
                        <Swatch themeKey={key} mode={mode} />
                        {t(`theme.${key}`)}
                      </>
                    ),
                  }))}
                  className="min-w-[220px]"
                />
              </Row>
              <Row label={t("main.settings.mode")} testId="setting-mode">
                <Segmented<Mode>
                  label={t("main.settings.mode")}
                  value={mode}
                  onChange={(m) => themeStore.setMode(m)}
                  options={[
                    { value: "light", label: t("main.settings.modeLight"), testId: "mode-light" },
                    { value: "dark", label: t("main.settings.modeDark"), testId: "mode-dark" },
                  ]}
                />
              </Row>
              <Row label={t("main.settings.language")} testId="setting-language">
                <Segmented<Language>
                  label={t("main.settings.language")}
                  value={language}
                  onChange={(l) => i18n.setLanguage(l)}
                  options={[
                    { value: "de", label: "Deutsch", testId: "language-de" },
                    { value: "en", label: "English", testId: "language-en" },
                  ]}
                />
              </Row>
              <Row label={t("main.settings.timeline")} testId="setting-timeline">
                <Segmented
                  label={t("main.settings.timeline")}
                  value={settings.timelineLabels}
                  onChange={(v) => settingsStore.set("timelineLabels", v)}
                  options={[
                    { value: "icons", label: t("main.settings.timelineIcons"), testId: "timeline-icons" },
                    { value: "names", label: t("main.settings.timelineNames"), testId: "timeline-names" },
                  ]}
                />
              </Row>
              <Row label={t("main.settings.axisLabels")} testId="setting-axis-labels">
                <Segmented
                  label={t("main.settings.axisLabels")}
                  value={settings.axisLabels}
                  onChange={(v) => settingsStore.set("axisLabels", v)}
                  options={[
                    { value: "views", label: t("main.settings.axisViews"), testId: "axis-views" },
                    { value: "xyz", label: t("main.settings.axisXyz"), testId: "axis-xyz" },
                  ]}
                />
              </Row>
              <Row label={t("main.settings.wheelZoom")} testId="setting-wheel-zoom">
                <Segmented
                  orientation="vertical"
                  label={t("main.settings.wheelZoom")}
                  value={settings.wheelZoom}
                  onChange={(v) => settingsStore.set("wheelZoom", v)}
                  options={[
                    { value: "down-out", label: t("main.settings.wheelZoomOut"), testId: "wheel-zoom-down-out" },
                    { value: "down-in", label: t("main.settings.wheelZoomIn"), testId: "wheel-zoom-down-in" },
                  ]}
                />
              </Row>
            </>
          ) : (
            <>
              <Row label={t("main.settings.sketchFill")} testId="setting-sketch-fill">
                <Segmented
                  label={t("main.settings.sketchFill")}
                  value={settings.sketchFill}
                  onChange={(v) => settingsStore.set("sketchFill", v)}
                  options={[
                    { value: "band", label: t("main.settings.sketchBand"), testId: "sketch-fill-band" },
                    { value: "fill", label: t("main.settings.sketchArea"), testId: "sketch-fill-fill" },
                  ]}
                />
              </Row>
              <Row label={t("main.settings.sketchColour")} testId="setting-sketch-colour">
                <Segmented
                  label={t("main.settings.sketchColour")}
                  value={settings.sketchColour}
                  onChange={(v) => settingsStore.set("sketchColour", v)}
                  options={[
                    { value: "green", label: t("main.settings.sketchGreen"), testId: "sketch-colour-green" },
                    { value: "blue", label: t("main.settings.sketchBlue"), testId: "sketch-colour-blue" },
                  ]}
                />
              </Row>
              <Row label={t("main.settings.fieldLook")} testId="setting-field-look">
                <Segmented
                  label={t("main.settings.fieldLook")}
                  value={settings.fieldLook}
                  onChange={(v) => settingsStore.set("fieldLook", v)}
                  options={[
                    { value: "dimension", label: t("main.settings.fieldLookDimension"), testId: "field-look-dimension" },
                    { value: "tag", label: t("main.settings.fieldLookTag"), testId: "field-look-tag" },
                  ]}
                />
              </Row>
              <p className="pt-3 text-[12.5px] leading-snug text-muted">{t("main.settings.sketchNote")}</p>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
