// The tools of the sketch tab (palette variant): Zeichnen (line, rectangle, circle), Bemaßen (dimension) and
// Abhängigkeiten (the constraints the engine supports). Only tools live here; the status and the display switches are in the
// floating palette. A tool stays on until Esc or a second click on its button.
import { useT } from "../../i18n/runtime.ts";
import { cx } from "../../ui/cx.ts";
import { Glyph, type GlyphName } from "../../ui/Glyph.tsx";
import { Tip } from "../../ui/Tip.tsx";
import { Group, Tool } from "../main/Toolbar.tsx";
import { constraintToolIds, toolKeys } from "./tools.ts";
import type { ToolId } from "./tool.ts";
import type { SketchSession } from "./session.ts";
import { useSessionState } from "./use-session.ts";

export const constraintGlyphOf: Record<(typeof constraintToolIds)[number], GlyphName> = {
  coincident: "cCoincident",
  horizontal: "cHorizontal",
  vertical: "cVertical",
  fix: "cFix",
  parallel: "cParallel",
  perpendicular: "cPerpendicular",
  equal: "cEqual",
  pointOnCurve: "cOnCurve",
};

export function SketchToolbar({ session }: { session: SketchSession | null }) {
  const t = useT();
  const state = useSessionState(session);
  const off = session === null;
  const tip = (id: ToolId, name: string) => {
    const key = toolKeys[id];
    return key ? t("sketch.tools.tip", { name, key }) : name;
  };
  const drawing = (id: "line" | "rectangle" | "circle" | "dimension", glyph: GlyphName) => (
    <Tool
      glyph={glyph}
      label={t(`sketch.tools.${id}`)}
      testId={`tool-${id}`}
      active={state.tool === id}
      tip={tip(id, t(`sketch.tools.${id}`))}
      onClick={() => session?.toggleTool(id)}
      {...(off ? { unavailable: t("main.toolbar.engineNotReady") } : {})}
    />
  );
  return (
    <>
      <Group name={t("sketch.toolbar.groupDraw")}>
        {drawing("line", "toolLine")}
        {drawing("rectangle", "toolRect")}
        {drawing("circle", "toolCircle")}
      </Group>
      <Group name={t("sketch.toolbar.groupDimension")}>{drawing("dimension", "toolDim")}</Group>
      <Group name={t("sketch.toolbar.groupConstraints")} className="min-w-0">
        <div className="grid grid-cols-4 grid-rows-2 content-center gap-px" role="group" aria-label={t("sketch.toolbar.groupConstraints")}>
          {constraintToolIds.map((id) => {
            const active = state.tool === id;
            const label = t(`sketch.tools.${id}`);
            return (
              <Tip key={id} label={label} align="start">
                <button
                  type="button"
                  disabled={off}
                  aria-label={label}
                  aria-pressed={active}
                  data-testid={`tool-${id}`}
                  onClick={() => session?.toggleTool(id)}
                  className={cx(
                    "relative grid size-[26px] place-items-center rounded-ctl text-[17px]",
                    off ? "cursor-not-allowed opacity-45" : "cursor-pointer hover:bg-surface-2",
                    active ? "bg-primary-soft text-primary" : "text-fg",
                  )}
                >
                  <Glyph name={constraintGlyphOf[id]} />
                  {active ? <span aria-hidden="true" className="absolute right-0 bottom-0 left-0 h-0.5 rounded-b-ctl bg-primary" /> : null}
                </button>
              </Tip>
            );
          })}
        </div>
      </Group>
    </>
  );
}
