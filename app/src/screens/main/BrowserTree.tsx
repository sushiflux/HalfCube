// The browser tree docked on the left. The active component's whole subtree is one band; with one component that is
// every row, and the structure is ready for more. Keyboard: arrows move, Right/Left open and close, Enter activates.
import { useRef, type KeyboardEvent } from "react";
import { useT } from "../../i18n/runtime.ts";
import { cx } from "../../ui/cx.ts";
import { Glyph, type GlyphName } from "../../ui/Glyph.tsx";
import { ScrollArea } from "../../ui/ScrollArea.tsx";
import type { OriginPlane } from "../../document/types.ts";
import type { TreeRow, TreeRowKind } from "./tree-model.ts";

const rowGlyph: Record<TreeRowKind, GlyphName> = {
  component: "component",
  origin: "origin",
  plane: "plane",
  axis: "axis",
  folder: "folder",
  sketch: "pencil",
  body: "body",
};

export interface BrowserTreeProps {
  rows: readonly TreeRow[];
  selectedId: string | null;
  /** The user is choosing the plane of a new sketch: plane rows can be clicked to pick. */
  pickingPlane: boolean;
  /** Id of the sketch or extrusion step being edited. */
  editingFeatureId: string | null;
  onToggle: (id: string) => void;
  onSelect: (row: TreeRow) => void;
  onPickPlane: (plane: OriginPlane) => void;
  /** Double-click on a sketch opens it for editing. */
  onOpenSketch: (featureId: string) => void;
  /** Double-click on a body edits the extrusion that made it. */
  onOpenBody: (featureId: string) => void;
  onHoverPlane: (plane: OriginPlane | null) => void;
}

export function BrowserTree({ rows, selectedId, pickingPlane, editingFeatureId, onToggle, onSelect, onPickPlane, onOpenSketch, onOpenBody, onHoverPlane }: BrowserTreeProps) {
  const t = useT();
  const container = useRef<HTMLDivElement>(null);

  const focusRow = (id: string | undefined) => {
    if (!id) return;
    container.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)?.focus();
  };

  const activate = (row: TreeRow) => {
    if (row.kind === "plane" && row.plane && pickingPlane) onPickPlane(row.plane);
    else onSelect(row);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, row: TreeRow, index: number) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusRow(rows[index + 1]?.id);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusRow(rows[index - 1]?.id);
        break;
      case "ArrowRight":
        if (row.hasChildren && !row.expanded) {
          event.preventDefault();
          onToggle(row.id);
        } else if (row.expanded) {
          event.preventDefault();
          focusRow(rows[index + 1]?.id);
        }
        break;
      case "ArrowLeft":
        if (row.hasChildren && row.expanded) {
          event.preventDefault();
          onToggle(row.id);
        }
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        activate(row);
        break;
      case "F2":
        break;
    }
  };

  return (
    <aside aria-label={t("main.tree.label")} className="flex min-h-0 w-[252px] flex-none flex-col border-r border-line bg-surface min-[1100px]:w-[280px]" data-testid="browser-tree">
      <div className="flex h-[38px] flex-none items-center border-b border-line px-3.5 text-[13px] font-semibold">{t("main.tree.label")}</div>
      <ScrollArea className="flex-1" viewportClassName="py-1">
        <div ref={container} role="tree" aria-label={t("main.tree.label")}>
          {rows.map((row, index) => {
            const selected = row.id === selectedId;
            const editing = row.featureId !== undefined && row.featureId === editingFeatureId && (row.kind === "sketch" || row.kind === "body");
            const pickable = pickingPlane && row.kind === "plane";
            return (
              <div
                key={row.id}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-selected={selected}
                aria-expanded={row.hasChildren ? row.expanded : undefined}
                tabIndex={selected || (selectedId === null && index === 0) ? 0 : -1}
                data-row-id={row.id}
                data-testid={`tree-row-${row.id}`}
                data-state={row.state}
                onClick={() => activate(row)}
                onDoubleClick={() => {
                  if (row.kind === "sketch" && row.featureId) onOpenSketch(row.featureId);
                  else if (row.kind === "body" && row.featureId) onOpenBody(row.featureId);
                  else if (row.hasChildren) onToggle(row.id);
                }}
                onKeyDown={(e) => onKeyDown(e, row, index)}
                onPointerEnter={() => row.kind === "plane" && pickingPlane && row.plane && onHoverPlane(row.plane)}
                onPointerLeave={() => row.kind === "plane" && onHoverPlane(null)}
                style={{ paddingLeft: 10 + row.depth * 18 }}
                className={cx(
                  "relative flex h-7 cursor-pointer items-center gap-1.5 pr-2 text-[13px] whitespace-nowrap",
                  "before:absolute before:top-0 before:bottom-0 before:left-0 before:w-[3px] before:bg-primary before:content-['']",
                  pickable ? "bg-surface hover:shadow-[inset_0_0_0_1px_var(--c-primary)]" : selected ? "bg-surface shadow-[inset_0_0_0_1px_var(--c-line-strong)]" : "bg-primary-soft hover:bg-surface-2",
                  editing ? "font-semibold" : "font-medium",
                )}
              >
                {row.hasChildren ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={row.expanded ? t("main.tree.collapse") : t("main.tree.expand")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggle(row.id);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                    className="inline-grid size-[18px] cursor-pointer place-items-center rounded-sm text-[14px] text-muted hover:text-fg"
                  >
                    <Glyph name={row.expanded ? "chevronDown" : "chevronRight"} />
                  </button>
                ) : (
                  <span aria-hidden="true" className="inline-block size-[18px]" />
                )}
                {row.kind === "component" ? (
                  <span
                    role="img"
                    aria-label={t("main.tree.activeComponent")}
                    data-testid="active-component-mark"
                    className="grid size-3 flex-none place-items-center rounded-full border-[1.5px] border-primary after:size-1.5 after:rounded-full after:bg-primary after:content-['']"
                  />
                ) : null}
                <span className={cx("text-[16px]", editing ? "text-primary" : "text-muted")}>
                  <Glyph name={rowGlyph[row.kind]} />
                </span>
                <span className="min-w-0 flex-1 overflow-hidden">{row.label}</span>
                {row.state === "error" || row.state === "warning" ? (
                  <span role="img" aria-label={t("main.tree.stepFailed")} className={cx("text-[15px]", row.state === "error" ? "text-error" : "text-fg")}>
                    <Glyph name="warning" />
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </aside>
  );
}
