// The floating sketch palette under the axis navigator (palette variant): the sketch and its plane, the
// status with its line pattern and a short explanation, the two display switches and "Skizze beenden". The status
// texts of every state share one grid cell, so the palette is as tall as the longest one and nothing moves when the state
// changes.
import type { ReactNode } from "react";
import { useT } from "../../i18n/runtime.ts";
import type { SketchView } from "../../model/index.ts";
import type { SketchFullColour } from "../../viewport/sketch/types.ts";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { Glyph } from "../../ui/Glyph.tsx";
import { Checkbox } from "../../ui/Checkbox.tsx";
import { sketchStatus, statusKinds, type StatusKind } from "./status-model.ts";

type Translate = ReturnType<typeof useT>;

const wordKey = {
  none: "sketch.status.noneWord",
  draw: "sketch.status.drawWord",
  under: "sketch.status.underWord",
  full: "sketch.status.fullWord",
  over: "sketch.status.overWord",
  failed: "sketch.status.failedWord",
} as const satisfies Record<StatusKind, string>;

const whyKey = {
  none: "sketch.status.noneWhy",
  draw: "sketch.status.drawWhy",
  under: "sketch.status.underWhy",
  full: "sketch.status.fullWhy",
  over: "sketch.status.overWhy",
  failed: "sketch.status.failedWhy",
} as const satisfies Record<StatusKind, string>;

const dofText = (t: Translate, dof: number) => (dof === 1 ? t("sketch.status.dofOne") : t("sketch.status.dofMany", { count: dof }));

/** The sub line before the explanation: degrees of freedom, or "noch keine Elemente". */
function subText(t: Translate, kind: StatusKind, dof: number | null): string | null {
  if (kind === "none") return t("sketch.status.noneSub");
  return dof === null ? null : dofText(t, dof);
}

/** The line pattern of a state: dashed grey while nothing is placed, otherwise the colour of the state. */
function Sample({ kind, colour }: { kind: StatusKind; colour: SketchFullColour }) {
  const plain = kind === "none" || kind === "draw";
  const token = kind === "full" ? (colour === "blue" ? "var(--c-sketch-full-blue)" : "var(--c-sketch-full)") : kind === "under" ? "var(--c-sketch-under)" : "var(--c-sketch-over)";
  return (
    <svg viewBox="0 0 30 10" width="30" height="10" aria-hidden="true" className="flex-none">
      {plain ? (
        <line x1="5" y1="5" x2="25" y2="5" stroke="var(--c-muted)" strokeWidth="1.6" strokeDasharray="3 3" />
      ) : (
        <>
          <line x1="5" y1="5" x2="25" y2="5" stroke={token} strokeWidth="1.6" />
          {[4, 26].map((x) => (
            <circle key={x} cx={x} cy="5" r="3" fill={kind === "full" ? token : "var(--c-surface)"} stroke={token} strokeWidth="1.4" />
          ))}
        </>
      )}
    </svg>
  );
}

export interface SketchPaletteProps {
  name: string;
  planeLabel: string;
  view: SketchView;
  /** A tool has begun an element in a sketch that has nothing yet. */
  drawing: boolean;
  colour: SketchFullColour;
  showConstraints: boolean;
  showDimensions: boolean;
  onShowConstraints: (on: boolean) => void;
  onShowDimensions: (on: boolean) => void;
  onFinish: () => void;
  finishing: boolean;
  /** The collapsed chip of "what is still missing" (SketchMissing.tsx), shown at the right of the status line. */
  missingChip?: ReactNode;
}

export function SketchPalette({ name, planeLabel, view, drawing, colour, showConstraints, showDimensions, onShowConstraints, onShowDimensions, onFinish, finishing, missingChip }: SketchPaletteProps) {
  const t = useT();
  const status = sketchStatus(view, drawing);
  const section = "border-b border-line py-2 pr-3 pl-3.5";
  const heading = "mb-1.5 text-[11.5px] font-semibold text-muted";
  return (
    <div
      role="group"
      aria-label={t("sketch.palette.label")}
      data-overlay=""
      data-testid="sketch-palette"
      className="pointer-events-auto relative w-full shrink-0 overflow-hidden rounded-card border border-line-strong bg-surface text-[13px]"
    >
      <span aria-hidden="true" className="absolute top-0 bottom-0 left-0 w-[3px] bg-primary" />
      <div className="flex min-h-9 items-center gap-2 border-b border-line py-1 pr-3 pl-3.5 font-semibold">
        <span className="text-[18px] text-primary">
          <Glyph name="pencil" />
        </span>
        <span className="min-w-0 flex-1 break-words leading-tight" data-testid="sketch-palette-name">{name}</span>
        <span className="flex-none text-[12px] font-medium text-muted">{planeLabel}</span>
      </div>
      <div className={section} data-testid="sketch-status" data-status={status.kind}>
        {/* The chip of "what is still missing" sits in the status line; its slot is always there, so nothing moves. */}
        <div className="mb-1 flex h-[22px] items-center justify-between">
          <span className="text-[11.5px] font-semibold text-muted">{t("sketch.palette.status")}</span>
          {missingChip}
        </div>
        <div className="flex h-6 items-center gap-2">
          <Sample kind={status.kind} colour={colour} />
          {status.kind === "full" ? (
            <span className="text-[16px]" style={{ color: colour === "blue" ? "var(--c-sketch-full-blue)" : "var(--c-sketch-full)" }}>
              <Glyph name="check" />
            </span>
          ) : status.kind === "over" || status.kind === "failed" ? (
            <span className="text-[16px] text-error">
              <Glyph name="warning" />
            </span>
          ) : null}
          <b className="font-semibold" data-testid="sketch-status-word">{t(wordKey[status.kind])}</b>
        </div>
        <div className="mt-1 grid text-[12px] leading-[1.35] text-muted" data-testid="sketch-status-why">
          {statusKinds.map((kind) => {
            const sub = subText(t, kind, kind === status.kind ? status.dof : kind === "under" ? 99 : kind === "full" ? 0 : null);
            const active = kind === status.kind;
            return (
              <p key={kind} aria-hidden={active ? undefined : true} className={cx("col-start-1 row-start-1", !active && "invisible")}>
                {sub ? <b className="font-semibold text-fg">{sub}. </b> : null}
                {t(whyKey[kind])}
              </p>
            );
          })}
        </div>
      </div>
      <div className={section}>
        <div className={heading}>{t("sketch.palette.display")}</div>
        <Checkbox
          checked={showConstraints}
          onChange={onShowConstraints}
          tone="text"
          icon={<Glyph name="constraintsShown" />}
          label={t("sketch.palette.constraints")}
          className="h-7 w-full"
          data-testid="show-constraints"
        />
        <Checkbox
          checked={showDimensions}
          onChange={onShowDimensions}
          tone="text"
          icon={<Glyph name="dimensionsShown" />}
          label={t("sketch.palette.dimensions")}
          className="h-7 w-full"
          data-testid="show-dimensions"
        />
      </div>
      <div className="flex py-2.5 pr-3 pl-3.5">
        <Button variant="primary" size="lg" icon={<Glyph name="check" />} onClick={onFinish} loading={finishing} className="flex-1" data-testid="finish-sketch-palette">
          {t("sketch.palette.finish")}
        </Button>
      </div>
    </div>
  );
}
