// The title row of the main window: logo and wordmark (the loading screen's logo flies to this spot), the document tab and,
// on the right, undo, redo and the gear that opens the settings dialog. Settings never live anywhere else.
import { aboutStore } from "../../about/state.ts";
import { useT } from "../../i18n/runtime.ts";
import { Logo, Wordmark } from "../../ui/Brand.tsx";
import { cx } from "../../ui/cx.ts";
import { Glyph } from "../../ui/Glyph.tsx";
import { Tip } from "../../ui/Tip.tsx";

function BarButton({ label, glyph, onClick, disabled, testId, tip }: { label: string; glyph: "undo" | "redo" | "settings" | "info"; onClick: () => void; disabled?: boolean; testId: string; tip?: string }) {
  return (
    <Tip label={tip ?? label} align="end">
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        data-testid={testId}
        className="inline-grid size-9 cursor-pointer place-items-center rounded-ctl text-[18px] text-muted hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-muted"
      >
        <Glyph name={glyph} />
      </button>
    </Tip>
  );
}

export interface TitleBarProps {
  /** The logo is shown once the loading screen's logo has arrived. */
  arrived: boolean;
  documentName: string;
  /** The document has changes that exist nowhere else (there is no file to save to yet, so every change counts). */
  unsaved: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Why undo is not available although a sketch is open (its own steps are used up); shown as the button's tooltip. */
  undoLimit?: string | undefined;
  onUndo: () => void;
  onRedo: () => void;
  onSettings: () => void;
}

export function TitleBar({ arrived, documentName, unsaved, canUndo, canRedo, undoLimit, onUndo, onRedo, onSettings }: TitleBarProps) {
  const t = useT();
  return (
    <header className="flex h-10 flex-none items-stretch gap-3 border-b border-line bg-surface pl-3 pr-1.5" data-testid="titlebar">
      <div className="flex items-center gap-2.5">
        {/* The logo of the loading screen flies to this spot and is shown once it has arrived. */}
        <Logo size={24} source="small" data-handover-target="" className={cx(!arrived && "opacity-0")} />
        <Wordmark size={18} className={cx("transition-opacity duration-300", !arrived && "opacity-0")} />
      </div>
      <div className="relative ml-1 flex items-center gap-2 border-x border-line bg-bg px-4 text-[13px] font-semibold" data-testid="document-tab">
        <span>{documentName}</span>
        {unsaved ? (
          <span role="img" aria-label={t("main.title.unsaved")} data-testid="unsaved-dot" className="size-1.5 rounded-full bg-muted" />
        ) : null}
        <span aria-hidden="true" className="absolute right-0 -bottom-px left-0 h-0.5 bg-primary" />
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-0.5">
        <BarButton label={t("main.title.undo")} tip={!canUndo && undoLimit ? undoLimit : t("main.title.undo")} glyph="undo" onClick={onUndo} disabled={!canUndo} testId="undo" />
        <BarButton label={t("main.title.redo")} glyph="redo" onClick={onRedo} disabled={!canRedo} testId="redo" />
        <span aria-hidden="true" className="mx-1.5 h-5 w-px bg-line" />
        {/* The one entry of the help area so far; it opens "About Partcraft" directly (a menu with a single entry would only cost a click). */}
        <BarButton label={t("main.title.about")} glyph="info" onClick={() => aboutStore.open()} testId="about-button" />
        <BarButton label={t("main.title.settings")} glyph="settings" onClick={onSettings} testId="settings-button" />
      </div>
    </header>
  );
}
