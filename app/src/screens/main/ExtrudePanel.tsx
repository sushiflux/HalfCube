// What the extrude command puts over the 3D view: the hint while it asks for an area, and the dialog with the notice for a problem
// under it. The notice is laid over the view (absolute, under the dialog), so a problem appearing or going away moves nothing.
import { useMemo } from "react";
import type { PartcraftDocument } from "../../document/types.ts";
import { useI18n } from "../../i18n/runtime.ts";
import { ErrorNotice } from "../../ui/ErrorNotice.tsx";
import { Glyph } from "../../ui/Glyph.tsx";
import type { ExtrudeCommand, ExtrudeState } from "./extrude-command.ts";
import { ExtrudeDialog } from "./ExtrudeDialog.tsx";
import { failureText } from "./extrude-messages.ts";

/** The hint bar over the view while the command asks for an area (like the hint when a sketch plane is chosen). */
export function PickProfileHint() {
  const { t } = useI18n();
  return (
    <div
      role="status"
      data-overlay=""
      data-testid="pick-profile-hint"
      className="absolute top-3 left-1/2 z-[3] flex -translate-x-1/2 items-center gap-2 rounded-ctl border border-line-strong bg-surface px-3 py-1.5 text-[12.5px] font-medium shadow-card"
    >
      <span className="text-[16px] text-primary">
        <Glyph name="fnExtrude" />
      </span>
      {t("main.extrude.pickHint")}
      <span aria-hidden="true" className="h-4 w-px bg-line" />
      <kbd className="mono rounded-sm border border-line-strong px-1.5 text-[11px] text-muted">{t("main.extrude.pickHintKey")}</kbd>
    </div>
  );
}

export interface ExtrudePanelProps {
  command: ExtrudeCommand;
  state: ExtrudeState;
  profileLabel: string | null;
  /** The document: a failure names its steps and shapes ("Skizze1", "Rechteck 1") with it. */
  doc: PartcraftDocument;
}

export function ExtrudePanel({ command, state, profileLabel, doc }: ExtrudePanelProps) {
  const { t, language } = useI18n();
  const failure = state.failure;
  const text = useMemo(() => (failure ? failureText(t, failure, { doc, decimalComma: language === "de" }) : null), [t, failure, doc, language]);
  return (
    <div data-overlay="" className="absolute top-3.5 left-3.5 z-[3] w-[372px]" data-testid="extrude-panel">
      <ExtrudeDialog command={command} state={state} profileLabel={profileLabel} />
      {text ? (
        <div className="absolute top-full right-0 left-0 mt-2" data-testid="extrude-failure" data-code={text.code}>
          <ErrorNotice headline={text.title} code={text.code} details={text.blocks} />
        </div>
      ) : state.profileGone ? (
        <p
          role="status"
          data-testid="extrude-profile-gone"
          className="absolute top-full right-0 left-0 mt-2 rounded-card border border-line-strong bg-surface px-3.5 py-2.5 text-[12.5px] leading-[1.4] shadow-card"
        >
          {t("main.extrude.profileGone")}
        </p>
      ) : null}
    </div>
  );
}
