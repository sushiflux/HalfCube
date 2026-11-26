// "What is still missing" (roadmap item "Skizzenpalette sagt genau, was noch fehlt"). Collapsed by default: a small chip in the status
// line of the palette tells at a glance (a count of open things, a check when everything is determined, a warning triangle only
// for a real problem); a click opens the list over the view under the palette - the palette itself never changes size, so nothing
// moves. The list names what is still free in plain words and names the shapes ("Kreis 2 lässt sich noch verschieben"). An entry
// lights up the elements it is about while the pointer or the focus is on it; a click selects them and brings them into sight.
import { useEffect, useRef } from "react";
import { useT } from "../../i18n/runtime.ts";
import type { SketchView } from "../../model/index.ts";
import { cx } from "../../ui/cx.ts";
import { Glyph } from "../../ui/Glyph.tsx";
import { Tip } from "../../ui/Tip.tsx";
import { chipState, missingList, MISSING_SHOWN } from "./missing-model.ts";
import type { SketchSession } from "./session.ts";

export const MISSING_LIST_ID = "sketch-missing-list";

export interface MissingChipProps {
  view: SketchView;
  open: boolean;
  onToggle: () => void;
}

/** The chip in the palette's status line. Its slot is always there (empty before anything is drawn), so the palette keeps its size. */
export function MissingChip({ view, open, onToggle }: MissingChipProps) {
  const t = useT();
  const state = chipState(view);
  return (
    <span className="flex h-[22px] min-w-[22px] flex-none items-center justify-end" data-testid="missing-chip-slot">
      {state.kind === "none" ? null : (
        <Tip
          align="end"
          label={`${t("sketch.missing.heading")}: ${state.kind === "open" ? t("sketch.missing.chip.open", { count: state.count }) : state.kind === "full" ? t("sketch.missing.chip.full") : t("sketch.missing.chip.problem")}. ${open ? t("sketch.missing.chip.hide") : t("sketch.missing.chip.show")}.`}
        >
          <button
            type="button"
            data-testid="missing-chip"
            data-state={state.kind}
            aria-expanded={open}
            aria-controls={MISSING_LIST_ID}
            aria-label={`${t("sketch.missing.heading")}: ${state.kind === "open" ? t("sketch.missing.chip.open", { count: state.count }) : state.kind === "full" ? t("sketch.missing.chip.full") : t("sketch.missing.chip.problem")}`}
            onClick={onToggle}
            className={cx(
              "flex h-[22px] min-w-[22px] cursor-pointer items-center justify-center gap-1 rounded-ctl border bg-surface px-1 text-[11.5px] font-semibold",
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
              open ? "border-primary" : "border-line-strong",
              state.kind === "problem" ? "text-error" : state.kind === "full" ? "text-fg" : "text-muted",
            )}
          >
            {state.kind === "open" ? (
              <span data-testid="missing-chip-count">{state.count}</span>
            ) : state.kind === "full" ? (
              <span className="text-[14px]" style={{ color: "var(--c-sketch-full)" }}>
                <Glyph name="check" />
              </span>
            ) : (
              <span className="text-[15px]">
                <Glyph name="warning" />
              </span>
            )}
          </button>
        </Tip>
      )}
    </span>
  );
}

export interface SketchMissingProps {
  session: SketchSession;
  view: SketchView;
  open: boolean;
  onClose: () => void;
}

/** The expanded list, over the view below the palette. */
export function SketchMissing({ session, view, open, onClose }: SketchMissingProps) {
  const t = useT();
  const state = chipState(view);
  const { onlyPosition, entries } = missingList(t, view);
  // The list can vanish under the pointer (collapsed, or nothing left): the highlight must not stay behind.
  const lit = useRef(false);
  const visibleNow = open && state.kind !== "none";
  useEffect(() => {
    if (!visibleNow && lit.current) {
      lit.current = false;
      session.highlightFact(null);
    }
  }, [visibleNow, session]);
  if (!visibleNow) return null;
  const visible = entries.slice(0, MISSING_SHOWN);
  const rest = entries.length - visible.length;
  const light = (ids: readonly string[] | null) => {
    lit.current = ids !== null;
    session.highlightFact(ids);
  };
  return (
    <div
      id={MISSING_LIST_ID}
      role="group"
      aria-label={t("sketch.missing.heading")}
      data-overlay=""
      data-testid="sketch-missing"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      className="pointer-events-auto max-h-[360px] overflow-auto rounded-card border border-line-strong bg-surface text-[12px] leading-[1.35] shadow-card"
    >
      <div className="border-b border-line py-1.5 pr-3 pl-3.5 text-[11.5px] font-semibold text-muted">{t("sketch.missing.heading")}</div>
      {state.kind === "full" ? (
        <p className="py-2 pr-3 pl-3.5 text-muted" data-testid="missing-full">
          {t("sketch.missing.fullText")}
        </p>
      ) : null}
      {state.kind === "problem" ? (
        <p className="py-2 pr-3 pl-3.5 text-muted" data-testid="missing-problem">
          {t("sketch.missing.problemText")}
        </p>
      ) : null}
      {onlyPosition ? (
        <p className="border-b border-line py-2 pr-3 pl-3.5 font-semibold text-fg" data-testid="missing-only-position">
          {t("sketch.missing.onlyPosition")}
        </p>
      ) : null}
      <ul>
        {visible.map((e) => (
          <li key={e.key} className="border-b border-line last:border-b-0">
            <button
              type="button"
              data-testid={`missing-${e.kind}`}
              data-kind={e.kind}
              data-elements={e.elements.join(" ")}
              onMouseEnter={() => light(e.elements)}
              onMouseLeave={() => light(null)}
              onFocus={() => light(e.elements)}
              onBlur={() => light(null)}
              onClick={() => session.focusFact(e.elements)}
              className="block w-full cursor-pointer py-2 pr-3 pl-3.5 text-left hover:bg-surface2 focus-visible:bg-surface2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
            >
              <b className="font-semibold text-fg">{e.label}: </b>
              <span className="text-muted">{e.text}</span>
            </button>
          </li>
        ))}
      </ul>
      {rest > 0 ? (
        <p className="border-t border-line py-1.5 pr-3 pl-3.5 text-muted" data-testid="missing-more">
          {t("sketch.missing.more", { count: rest })}
        </p>
      ) : null}
    </div>
  );
}
