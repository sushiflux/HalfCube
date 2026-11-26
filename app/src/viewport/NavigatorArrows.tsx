// The six arrows around the axis navigator: two quarter-circle arrows above it turn the view by 90
// degrees about the vertical axis, four chevrons at its sides tip it to the neighbouring standard view in their direction.
// They are separate buttons next to the navigator, never faces, edges or corners of a body. They show only while the view
// is a standard view (the 90-degree step is clear only from there); the room stays reserved, so nothing moves when they
// come and go, and hidden ones leave the tab order. Keyboard: Shift + left/right turns, Ctrl + Shift + arrows tip (not while
// a text field has the focus).
import { useEffect, type CSSProperties } from "react";
import { useI18n } from "../i18n/runtime.ts";
import { keysBelongToTarget } from "../ui/typing-target.ts";
import { Tip } from "../ui/Tip.tsx";
import { standardViewOf, viewAfterTip, viewAfterTurn, viewNameOfAxis, type AxisKey, type TipDirection, type TurnDirection, type ViewState } from "./camera.ts";
import type { Viewport } from "./types.ts";

/** Room reserved around the navigator for the arrows (CSS pixels). */
export const ARROW_BAND = 26;

type Placement = { left: number; top: number; width: number; height: number; side: "top" | "bottom"; align: "start" | "center" | "end" };
type ArrowSpec = { id: string; kind: "turn"; direction: TurnDirection } | { id: string; kind: "tip"; direction: TipDirection };

const SPECS: readonly ArrowSpec[] = [
  { id: "turn-left", kind: "turn", direction: "left" },
  { id: "turn-right", kind: "turn", direction: "right" },
  { id: "tip-up", kind: "tip", direction: "up" },
  { id: "tip-down", kind: "tip", direction: "down" },
  { id: "tip-left", kind: "tip", direction: "left" },
  { id: "tip-right", kind: "tip", direction: "right" },
];

/**
 * Hit boxes (at least 26 px each way) in the reserved band; the group is `box` pixels wide and high. Every tooltip is aligned
 * to the right edge of its arrow and grows to the left: the group sits at the right edge of the view, where a tooltip would be cut.
 */
function placementOf(id: string, box: number): Placement {
  const mid = box / 2;
  switch (id) {
    case "turn-left": return { left: 0, top: 0, width: 28, height: ARROW_BAND, side: "bottom", align: "end" };
    case "turn-right": return { left: box - 28, top: 0, width: 28, height: ARROW_BAND, side: "bottom", align: "end" };
    case "tip-up": return { left: mid - 16, top: 0, width: 32, height: ARROW_BAND, side: "bottom", align: "end" };
    case "tip-down": return { left: mid - 16, top: box - ARROW_BAND, width: 32, height: ARROW_BAND, side: "bottom", align: "end" };
    case "tip-left": return { left: 0, top: mid - 16, width: ARROW_BAND, height: 32, side: "bottom", align: "end" };
    default: return { left: box - ARROW_BAND, top: mid - 16, width: ARROW_BAND, height: 32, side: "bottom", align: "end" };
  }
}

/** A quarter-circle line with an arrowhead at its lower end: the left one arcs from the top to the left, the right one mirrored. */
function TurnGlyph({ direction }: { direction: TurnDirection }) {
  const r = 10, cx = 17, cy = 15.5; // arc centre; the arc runs from the top point to the left point
  const start = `${cx} ${cy - r}`, end = `${cx - r} ${cy}`;
  const arc = `M${start} A${r} ${r} 0 0 0 ${end}`;
  const head = `${cx - r},${cy + 3.2} ${cx - r - 4.4},${cy - 2.2} ${cx - r + 4.4},${cy - 2.2}`;
  const body = (
    <>
      <g className="pc-arrow-halo" style={{ stroke: "var(--c-viewport)", fill: "var(--c-viewport)" }}>
        <path d={arc} fill="none" strokeWidth={4.6} strokeLinecap="round" />
        <polygon points={head} strokeWidth={3} strokeLinejoin="round" />
      </g>
      <g stroke="currentColor" fill="currentColor">
        <path d={arc} fill="none" strokeWidth={2} strokeLinecap="round" />
        <polygon points={head} strokeWidth={1} strokeLinejoin="round" />
      </g>
    </>
  );
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true">
      {direction === "left" ? body : <g transform="translate(24 0) scale(-1 1)">{body}</g>}
    </svg>
  );
}

function ChevronGlyph({ direction }: { direction: TipDirection }) {
  const rotate = { up: 0, right: 90, down: 180, left: 270 }[direction];
  const d = "M6 14.5 L12 8.5 L18 14.5";
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true">
      <g transform={`rotate(${rotate} 12 12)`}>
        <path className="pc-arrow-halo" d={d} fill="none" strokeWidth={5.4} strokeLinecap="round" strokeLinejoin="round" style={{ stroke: "var(--c-viewport)" }} />
        <path d={d} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

export interface NavigatorArrowsProps {
  viewport: Viewport;
  /** Where the camera is heading (the end of a running transition), so the arrows do not flicker during a turn. */
  goal: ViewState;
  /** Edge length of the whole group (navigator plus the reserved band on every side). */
  box: number;
}

export function NavigatorArrows({ viewport, goal, box }: NavigatorArrowsProps) {
  const { t } = useI18n();
  const current = standardViewOf(goal);
  const viewName = (key: AxisKey): string => t(`viewport.views.${viewNameOfAxis[key]}`);
  const shift = t("viewport.keyShift"), ctrl = t("viewport.keyCtrl");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || !event.key.startsWith("Arrow")) return;
      if (keysBelongToTarget(event.target)) return;
      const direction = event.key.slice(5).toLowerCase() as TipDirection;
      const withCtrl = event.ctrlKey || event.metaKey;
      if (!event.shiftKey || standardViewOf(viewport.getTargetView()) === null) return;
      if (!withCtrl && (direction === "left" || direction === "right")) viewport.turnView(direction);
      else if (withCtrl) viewport.tipView(direction);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewport]);

  return (
    <>
      {SPECS.map((spec) => {
        const p = placementOf(spec.id, box);
        let title = "", detail = "", keys = "";
        if (current !== null) {
          if (spec.kind === "turn") {
            const after = viewAfterTurn(goal, spec.direction);
            const result = after ? standardViewOf(after) : null;
            title = t(spec.direction === "left" ? "viewport.turnLeft" : "viewport.turnRight");
            detail = current === "+z" || current === "-z" ? t("viewport.turnStays", { name: viewName(current) }) : result ? t("viewport.turnResult", { name: viewName(result) }) : "";
            keys = `${shift} + ${spec.direction === "left" ? "←" : "→"}`;
          } else {
            const after = viewAfterTip(goal, spec.direction);
            const result = after ? standardViewOf(after) : null;
            title = result ? t("viewport.tipTo", { name: viewName(result) }) : "";
            detail = t("viewport.tipFrom", { name: viewName(current) });
            keys = `${ctrl} + ${shift} + ${{ up: "↑", down: "↓", left: "←", right: "→" }[spec.direction]}`;
          }
        }
        const style: CSSProperties = { left: p.left, top: p.top, width: p.width, height: p.height };
        return (
          <div
            key={spec.id}
            className="pointer-events-auto absolute transition-[opacity,visibility] duration-150 data-[hidden=true]:invisible data-[hidden=true]:opacity-0 motion-reduce:transition-none"
            style={style}
            data-hidden={current === null}
          >
            <Tip label={title ? `${title} (${keys})` : ""} side={p.side} align={p.align} className="size-full">
              <button
                type="button"
                data-testid={`nav-${spec.id}`}
                aria-label={title ? `${title}. ${detail}` : undefined}
                aria-keyshortcuts={spec.kind === "turn" ? `Shift+Arrow${spec.direction === "left" ? "Left" : "Right"}` : `Control+Shift+Arrow${spec.direction[0]!.toUpperCase()}${spec.direction.slice(1)}`}
                tabIndex={current === null ? -1 : 0}
                onClick={() => (spec.kind === "turn" ? viewport.turnView(spec.direction) : viewport.tipView(spec.direction))}
                className="group grid size-full hover:[&_.pc-arrow-halo]:opacity-0 cursor-pointer place-items-center rounded-ctl text-muted transition-colors hover:bg-primary-soft hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary active:scale-95 motion-reduce:transition-none motion-reduce:active:scale-100"
              >
                {spec.kind === "turn" ? <TurnGlyph direction={spec.direction} /> : <ChevronGlyph direction={spec.direction} />}
              </button>
            </Tip>
          </div>
        );
      })}
    </>
  );
}
