// The axis navigator (no cube): shows the orientation of the view. Click an axis end to look from
// it, click the same end again to see the opposite side, drag to orbit, the small house button returns to the start view.
// Letters: only the filled discs carry the view initials (O, H, R / T, Bk, R); the hollow rings show theirs, and the full
// view name, only under the pointer. Layout and colours come from navigator-model.ts. The turn and tip arrows around it
// are in NavigatorArrows.tsx.
import { useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useI18n } from "../i18n/runtime.ts";
import { useTheme } from "../theme/runtime.ts";
import { getTheme } from "../theme/themes.ts";
import { axisKeys, oppositeAxis, standardViewOf, viewNameOfAxis, type AxisKey, type ViewState } from "./camera.ts";
import { cx } from "../ui/cx.ts";
import { ARROW_BAND, NavigatorArrows } from "./NavigatorArrows.tsx";
import { discColours, endLabel, navigatorEnds, navigatorMetrics, type AxisLabelMode } from "./navigator-model.ts";
import type { Viewport } from "./types.ts";

/** What the navigator shows: the current view and where the camera is heading (they differ during a transition). */
interface ViewSnapshot {
  view: ViewState;
  goal: ViewState;
}

/** A tiny store over the view of a viewport: React reads a snapshot that changes only when the viewport reports a new view. */
function createViewStore(viewport: Viewport) {
  let snapshot: ViewSnapshot = { view: viewport.getView(), goal: viewport.getTargetView() };
  return {
    subscribe: (onChange: () => void) =>
      viewport.on("view", (view) => {
        snapshot = { view, goal: viewport.getTargetView() };
        onChange();
      }),
    get: () => snapshot,
  };
}

export interface AxisNavigatorProps {
  viewport: Viewport;
  /** View initials (default) or X, Y, Z; set in the settings dialog. */
  labels?: AxisLabelMode;
  /** Edge length in CSS pixels. */
  size?: number;
  className?: string;
}

/** A drag shorter than this many pixels is a click. */
const CLICK_SLOP = 4;

export function AxisNavigator({ viewport, labels = "views", size = 128, className }: AxisNavigatorProps) {
  const { t } = useI18n();
  const { theme, mode } = useTheme();
  const tokens = getTheme(theme).tokens[mode];
  const highContrast = getTheme(theme).highContrast;
  const store = useMemo(() => createViewStore(viewport), [viewport]);
  const { view, goal } = useSyncExternalStore(store.subscribe, store.get);
  const [hovered, setHovered] = useState<AxisKey | null>(null);
  const [dragging, setDragging] = useState(false);
  const press = useRef<{ id: number; x: number; y: number; moved: boolean; key: AxisKey | null } | null>(null);

  /** The navigator keeps its square in the middle; the band around it is room for the arrows. */
  const box = size + 2 * ARROW_BAND;
  const m = useMemo(() => navigatorMetrics(size), [size]);
  const ends = useMemo(() => navigatorEnds(view, size), [view, size]);
  const c = size / 2;
  const initials = useMemo(
    () => ({ top: t("viewport.initials.top"), bottom: t("viewport.initials.bottom"), front: t("viewport.initials.front"), back: t("viewport.initials.back"), right: t("viewport.initials.right"), left: t("viewport.initials.left") }),
    [t],
  );
  const viewName = (key: AxisKey): string => t(`viewport.views.${viewNameOfAxis[key]}`);

  const keyAt = (target: EventTarget | null): AxisKey | null => {
    const el = target instanceof Element ? target.closest("[data-axis]") : null;
    const key = el?.getAttribute("data-axis");
    return axisKeys.find((k) => k === key) ?? null;
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, key: keyAt(e.target) };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) {
      setHovered(keyAt(e.target));
      return;
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (!p.moved && Math.hypot(dx, dy) > CLICK_SLOP) {
      p.moved = true;
      setDragging(true);
    }
    if (p.moved) {
      viewport.orbitBy(e.clientX - p.x, e.clientY - p.y);
      p.x = e.clientX;
      p.y = e.clientY;
    }
  };
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!p.moved && p.key) viewport.alignToAxis(p.key);
  };
  const onKeyDown = (e: KeyboardEvent<SVGGElement>, key: AxisKey) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      viewport.alignToAxis(key);
    }
  };

  const hoveredEnd = hovered ? ends.find((x) => x.key === hovered) : undefined;
  const showBackdrop = hovered !== null || dragging;

  return (
    <div
      className={cx("pointer-events-none", className)}
      style={{ width: box, height: box }}
      data-testid="axis-navigator"
      data-labels={labels}
      data-aligned={standardViewOf(goal) !== null}
    >
      <div className="pointer-events-auto absolute" style={{ left: ARROW_BAND, top: ARROW_BAND, width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="group"
          aria-label={t("viewport.navigatorLabel")}
          className="block touch-none select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => { if (!press.current) setHovered(null); }}
        >
          {showBackdrop ? (
            <circle cx={c} cy={c} r={m.reach + m.disc + 4} className={dragging ? "stroke-primary" : "stroke-line"} fill="var(--c-surface)" fillOpacity={dragging ? 0.92 : 0.72} strokeWidth={dragging ? 1.6 : 1} />
          ) : null}
          <circle cx={c} cy={c} r={size * 0.022} fill="var(--c-text)" pointerEvents="none" />
          {ends.map((end) => {
            const colour = `var(--c-axis-${end.axis})`;
            const isHover = hovered === end.key;
            const text = endLabel(end.key, labels, initials, isHover);
            const len = Math.hypot(end.x - c, end.y - c);
            const ux = len > 0.01 ? (end.x - c) / len : 0, uy = len > 0.01 ? (end.y - c) / len : 0;
            const name = viewName(end.key);
            const common = { "data-axis": end.key, "data-testid": `nav-end-${end.key}`, "data-view": viewNameOfAxis[end.key], role: "button", tabIndex: 0, "aria-label": name, className: "cursor-pointer focus-visible:outline-2 focus-visible:outline-primary" } as const;
            if (end.positive) {
              const d = discColours(tokens[end.axis === "x" ? "axisX" : end.axis === "y" ? "axisY" : "axisZ"], tokens.surface, tokens.text, highContrast);
              return (
                <g key={end.key} {...common} onKeyDown={(e) => onKeyDown(e, end.key)}>
                  <line x1={c} y1={c} x2={end.x - ux * m.disc} y2={end.y - uy * m.disc} stroke={colour} strokeWidth={m.lineWidth} strokeLinecap="round" />
                  {isHover ? <circle cx={end.x} cy={end.y} r={m.disc + 4} fill="none" className="stroke-primary" strokeWidth={2} /> : null}
                  <circle cx={end.x} cy={end.y} r={m.disc + 0.5} fill={d.fill} stroke={colour} strokeWidth={1.6} />
                  {text ? (
                    <text x={end.x} y={end.y} textAnchor="middle" dominantBaseline="central" fill={d.letter} fontSize={m.fontSize} fontWeight={700} pointerEvents="none">{text}</text>
                  ) : null}
                </g>
              );
            }
            const wide = isHover && text.length > 1 && text[0] !== "−";
            const r = !isHover ? m.ring : wide ? m.ringWide : m.disc;
            return (
              <g key={end.key} {...common} onKeyDown={(e) => onKeyDown(e, end.key)}>
                <line x1={c} y1={c} x2={end.x - ux * m.ring} y2={end.y - uy * m.ring} stroke={colour} strokeWidth={1.4} strokeDasharray="2 3" strokeLinecap="round" />
                {isHover ? <circle cx={end.x} cy={end.y} r={r + 4} fill="none" className="stroke-primary" strokeWidth={2} /> : null}
                <circle cx={end.x} cy={end.y} r={r} fill={isHover ? "var(--c-primary-soft)" : "var(--c-surface)"} stroke={colour} strokeWidth={2} />
                {text ? (
                  <text x={end.x} y={end.y} textAnchor="middle" dominantBaseline="central" fill="var(--c-text)" fontSize={text.startsWith("−") ? m.fontSize * 0.85 : m.fontSize} fontWeight={700} pointerEvents="none">{text}</text>
                ) : null}
              </g>
            );
          })}
        </svg>
        <button
          type="button"
          onClick={() => viewport.goHome()}
          title={t("viewport.home")}
          aria-label={t("viewport.home")}
          data-testid="nav-home"
          className="absolute top-0 left-0 grid size-6 place-items-center rounded-ctl text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-primary"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12l-2 0l9 -9l9 9l-2 0" />
            <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7" />
            <path d="M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6" />
          </svg>
        </button>
        {hoveredEnd && !dragging ? (
          <div
            role="tooltip"
            data-testid="nav-tooltip"
            className="pointer-events-none absolute top-full left-1/2 z-10 mt-0.5 -translate-x-1/2 rounded-ctl border border-line bg-surface px-2 py-1 text-[11.5px] leading-tight whitespace-nowrap text-fg shadow-sm"
          >
            <div className="font-semibold">{viewName(hoveredEnd.key)}</div>
            <div className="text-muted">{t("viewport.again", { name: viewName(oppositeAxis[hoveredEnd.key]) })}</div>
          </div>
        ) : null}
      </div>
      <NavigatorArrows viewport={viewport} goal={goal} box={box} />
    </div>
  );
}
