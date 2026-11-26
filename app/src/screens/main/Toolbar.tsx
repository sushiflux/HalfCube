// The toolbar (tabs on top, tool groups with their names below them, and on the right of the sketch tab
// "Skizze beenden" (it sits in the sketch palette as well). Tools that do not exist yet are shown quietly disabled
// with a tooltip, never as live buttons that do nothing. The sketch tab hands its space to `sketchTools`, which brings its
// own groups (sketch/SketchToolbar.tsx).
import type { ReactNode } from "react";
import { useT } from "../../i18n/runtime.ts";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { Glyph, type GlyphName } from "../../ui/Glyph.tsx";
import { Tip } from "../../ui/Tip.tsx";

export type ToolbarTab = "body" | "sketch";

export interface ToolProps {
  glyph: GlyphName;
  label: string;
  testId: string;
  onClick?: () => void;
  /** Why the tool cannot be used right now; the tool is then disabled and this is its tooltip. */
  unavailable?: string;
  /** The tool's command is running (shown as the highlighted tool). */
  active?: boolean;
  tip?: string;
}

export function Tool({ glyph, label, testId, onClick, unavailable, active, tip }: ToolProps) {
  const disabled = unavailable !== undefined;
  return (
    <Tip label={unavailable ?? tip ?? label} align="start" className="self-stretch">
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-pressed={active === undefined ? undefined : active}
        onClick={onClick}
        data-testid={testId}
        className={cx(
          "relative flex min-w-14 flex-col items-center justify-center gap-[3px] rounded-ctl px-[5px] py-0.5 text-[11.5px] font-medium whitespace-nowrap",
          disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer hover:bg-surface-2",
          active ? "bg-primary-soft" : "",
        )}
      >
        <span className={cx("text-[22px]", active ? "text-primary" : "text-fg")}>
          <Glyph name={glyph} />
        </span>
        <span>{label}</span>
        {active ? <span aria-hidden="true" className="absolute right-0 bottom-0 left-0 h-0.5 rounded-b-ctl bg-primary" /> : null}
      </button>
    </Tip>
  );
}

export function Group({ name, children, className }: { name: string; children: ReactNode; className?: string }) {
  return (
    <div role="group" aria-label={name} className={cx("flex flex-col px-2 first:pl-0 [&+&]:border-l [&+&]:border-line", className)}>
      <div className="flex flex-1 gap-px">{children}</div>
      <div className="text-center text-[11px] font-medium text-muted">{name}</div>
    </div>
  );
}

export interface ToolbarProps {
  tab: ToolbarTab;
  /** The engine can answer: the sketch tool needs it. */
  engineReady: boolean;
  /** The user is choosing the plane for a new sketch. */
  pickingPlane: boolean;
  onSketch: () => void;
  /** The extrude command: running (asking for an area or its dialog open), and why it cannot start (null: it can). */
  extruding: boolean;
  extrudeUnavailable: string | null;
  onExtrude: () => void;
  onFinishSketch: () => void;
  finishing: boolean;
  /** The sketch tools with their groups, shown in the sketch tab. */
  sketchTools: ReactNode;
}

export function Toolbar({ tab, engineReady, pickingPlane, onSketch, extruding, extrudeUnavailable, onExtrude, onFinishSketch, finishing, sketchTools }: ToolbarProps) {
  const t = useT();
  const sketching = tab === "sketch";
  const later = t("main.toolbar.notYet");
  return (
    <section aria-label={t("main.toolbar.label")} className="flex-none bg-surface" data-testid="toolbar">
      <div role="tablist" aria-label={t("main.toolbar.tabs")} className="flex h-9 items-stretch gap-0.5 px-3">
        {(["body", "sketch"] as const).map((id) => {
          if (id === "sketch" && !sketching) return null;
          const active = tab === id;
          const blocked = id === "body" && sketching;
          return (
            <Tip key={id} label={blocked ? t("main.toolbar.finishFirst") : ""}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                aria-disabled={blocked || undefined}
                tabIndex={active ? 0 : -1}
                data-testid={`tab-${id}`}
                onClick={() => undefined}
                className={cx(
                  "relative flex items-center px-3.5 text-[13.5px]",
                  active ? "font-semibold text-fg" : "font-medium text-muted",
                  blocked ? "cursor-not-allowed opacity-45" : "cursor-default",
                )}
              >
                {id === "body" ? t("main.toolbar.tabBody") : t("main.toolbar.tabSketch")}
                {active ? <span aria-hidden="true" className="absolute right-0 bottom-0 left-0 h-[3px] bg-primary" /> : null}
              </button>
            </Tip>
          );
        })}
      </div>
      <div className="flex h-[80px] items-stretch border-y border-line px-3 pt-[5px] pb-1" data-testid="tool-row">
        {sketching ? (
          <>
            {sketchTools}
            <div className="ml-auto flex flex-none items-center pl-3">
              <Button variant="primary" size="lg" icon={<Glyph name="check" />} onClick={onFinishSketch} loading={finishing} data-testid="finish-sketch">
                {t("main.toolbar.finishSketch")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Group name={t("main.toolbar.groupCreate")}>
              <Tool
                glyph="sketch"
                label={t("main.toolbar.sketch")}
                testId="tool-sketch"
                onClick={onSketch}
                active={pickingPlane}
                tip={t("main.toolbar.pickPlane")}
                {...(!engineReady ? { unavailable: t("main.toolbar.engineNotReady") } : extruding ? { unavailable: t("main.toolbar.extrudeRunning") } : {})}
              />
              <Tool
                glyph="fnExtrude"
                label={t("main.toolbar.extrude")}
                testId="tool-extrude"
                onClick={onExtrude}
                active={extruding}
                tip={t("main.toolbar.extrudeTip")}
                {...(extrudeUnavailable !== null ? { unavailable: extrudeUnavailable } : {})}
              />
              <Tool glyph="fnRevolve" label={t("main.toolbar.revolve")} testId="tool-revolve" unavailable={later} />
              <Tool glyph="fnHole" label={t("main.toolbar.hole")} testId="tool-hole" unavailable={later} />
            </Group>
            <Group name={t("main.toolbar.groupModify")}>
              <Tool glyph="fnFillet" label={t("main.toolbar.fillet")} testId="tool-fillet" unavailable={later} />
            </Group>
          </>
        )}
      </div>
    </section>
  );
}
