// The status bar: what is selected, how many steps failed, the unit and the version. The version carries the channel
// symbol; the program kind is a data attribute for tests, not text. The early-access label next to it is a button that opens
// "About HalfCube".
import { EARLY_ACCESS } from "../../about/catalogue.ts";
import { aboutStore } from "../../about/state.ts";
import { branding } from "../../branding.ts";
import { useT } from "../../i18n/runtime.ts";
import { Glyph } from "../../ui/Glyph.tsx";
import { currentVersion } from "../../version.ts";

export interface StatusBarProps {
  /** What the user selected, or null. */
  selection: string | null;
  /** Text while a sketch is open. */
  editing: string | null;
  problemCount: number;
  onProblems: () => void;
}

export function StatusBar({ selection, editing, problemCount, onProblems }: StatusBarProps) {
  const t = useT();
  return (
    <footer className="flex h-[26px] flex-none items-center gap-[18px] border-t border-line bg-surface px-3 text-[12px] whitespace-nowrap text-muted" data-testid="status-bar" data-platform="desktop">
      <span>{editing ?? t("main.status.ready")}</span>
      <span data-testid="status-selection">{selection ? t("main.status.selection", { name: selection }) : t("main.status.noSelection")}</span>
      {problemCount > 0 ? (
        <button type="button" onClick={onProblems} data-testid="status-problems" className="inline-flex cursor-pointer items-center gap-[5px] font-semibold text-error">
          <span className="text-[14px]">
            <Glyph name="warning" />
          </span>
          {t("main.status.problems", { count: problemCount })}
        </button>
      ) : null}
      <span className="ml-auto flex gap-[18px]">
        <span>{t("main.status.unit")}</span>
        <span className="inline-flex items-center gap-2">
          <span data-testid="version">
            {branding.name} {currentVersion().display}
          </span>
          {EARLY_ACCESS ? (
            <button
              type="button"
              aria-label={t("main.status.earlyAccessOpen")}
              onClick={() => aboutStore.open()}
              data-testid="status-early"
              className="inline-flex h-[18px] cursor-pointer items-center rounded-ctl border border-line bg-primary-soft px-[7px] text-[11px] leading-none font-semibold text-fg hover:border-line-strong"
            >
              {t("main.status.earlyAccess")}
            </button>
          ) : null}
        </span>
      </span>
    </footer>
  );
}
