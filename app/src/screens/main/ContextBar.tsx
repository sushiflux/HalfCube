// The context bar over the 3D view (focus layout): which component is active and what the user is editing. With one component
// it says so; in a sketch it shows the path and the plane. "Zur Baugruppe" and the occurrence note come with assemblies.
import { useT } from "../../i18n/runtime.ts";
import { Glyph } from "../../ui/Glyph.tsx";

export interface ContextBarProps {
  componentName: string;
  /** Name and plane of the sketch being edited. */
  sketch: { name: string; planeLabel: string } | null;
}

export function ContextBar({ componentName, sketch }: ContextBarProps) {
  const t = useT();
  return (
    <div className="relative flex h-9 flex-none items-center gap-2.5 border-b border-line bg-surface pr-2 pl-3.5 text-[12px]" data-testid="context-bar">
      <span aria-hidden="true" className="absolute top-0 bottom-0 left-0 w-[3px] bg-primary" />
      <span className="font-medium text-muted">{sketch ? t("main.context.sketchEditing") : t("main.context.activeComponent")}</span>
      <span className="flex items-center gap-1 text-[13px] font-medium" data-testid="context-path">
        <span className="text-[15px] text-muted">
          <Glyph name="component" />
        </span>
        {sketch ? (
          <>
            <span>{componentName}</span>
            <span className="text-[15px] text-muted">
              <Glyph name="chevronRight" />
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="text-[15px] text-primary">
                <Glyph name="pencil" />
              </span>
              <b className="font-semibold">{sketch.name}</b>
            </span>
          </>
        ) : (
          <b className="font-semibold">{componentName}</b>
        )}
      </span>
      <span className="inline-flex items-center gap-1.5 font-medium text-muted">
        <span className="text-[14px]">
          <Glyph name={sketch ? "plane" : "info"} />
        </span>
        {sketch ? t("main.context.onPlane", { plane: sketch.planeLabel }) : t("main.context.single")}
      </span>
    </div>
  );
}
