// What the open sketch adds to the 3D view: the pointer and key input that drives the tools, the one-line prompt, the
// floating palette and the HTML overlay of dimensions and constraints. It sits inside the view's container (the element the
// layer measures its coordinates in); left button without Alt belongs to the tools, everything else still navigates.
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n/runtime.ts";
import type { SketchView } from "../../model/index.ts";
import type { FieldLook } from "../../prefs/settings.ts";
import { Glyph } from "../../ui/Glyph.tsx";
import { keysBelongToTarget } from "../../ui/typing-target.ts";
import type { SketchFullColour, SketchLayer, SketchLayerOptions } from "../../viewport/sketch/types.ts";
import { SketchOverlay } from "./SketchOverlay.tsx";
import { MissingChip, SketchMissing } from "./SketchMissing.tsx";
import { SketchPalette } from "./SketchPalette.tsx";
import type { SketchSession } from "./session.ts";
import { useSessionState } from "./use-session.ts";

const OVERLAY_SELECTOR = "[data-testid='axis-navigator'],[data-overlay]";

/** Pointer and keyboard input of the tools. */
function useSketchInput(host: HTMLElement | null, session: SketchSession): void {
  useEffect(() => {
    if (!host) return;
    const rel = (e: MouseEvent) => {
      const r = host.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const inOverlay = (target: EventTarget | null) => target instanceof Element && target.closest(OVERLAY_SELECTOR) !== null;
    let active: number | null = null;
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || e.altKey || inOverlay(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      host.setPointerCapture(e.pointerId);
      active = e.pointerId;
      const p = rel(e);
      void session.pointerDown(p.x, p.y, e.shiftKey);
    };
    const move = (e: PointerEvent) => {
      if (active === null && inOverlay(e.target)) return session.clearHover();
      const p = rel(e);
      session.pointerMove(p.x, p.y, e.shiftKey);
    };
    const up = (e: PointerEvent) => {
      if (active !== e.pointerId) return;
      active = null;
      if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
      const p = rel(e);
      void session.pointerUp(p.x, p.y, e.shiftKey);
    };
    const leave = () => session.clearHover();
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // Text fields and dialogs keep their keys; a ticked checkbox does not (the sketch keys work after clicking one).
      if (keysBelongToTarget(e.target)) return;
      if (session.key({ key: e.key, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey })) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    host.addEventListener("pointerdown", down, true);
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerup", up);
    host.addEventListener("pointercancel", up);
    host.addEventListener("pointerleave", leave);
    window.addEventListener("keydown", key, true);
    return () => {
      host.removeEventListener("pointerdown", down, true);
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerup", up);
      host.removeEventListener("pointercancel", up);
      host.removeEventListener("pointerleave", leave);
      window.removeEventListener("keydown", key, true);
    };
  }, [host, session]);
}

export interface SketchModeProps {
  session: SketchSession;
  layer: SketchLayer;
  view: SketchView;
  options: SketchLayerOptions;
  name: string;
  planeLabel: string;
  colour: SketchFullColour;
  fieldLook: FieldLook;
  onShowConstraints: (on: boolean) => void;
  onShowDimensions: (on: boolean) => void;
  onFinish: () => void;
  finishing: boolean;
}

export function SketchMode({ session, layer, view, options, name, planeLabel, colour, fieldLook, onShowConstraints, onShowDimensions, onFinish, finishing }: SketchModeProps) {
  const { t, language } = useI18n();
  const state = useSessionState(session);
  // The element the layer measures in is the parent of this component's root.
  const [host, setHost] = useState<HTMLElement | null>(null);
  const rootRef = useCallback((el: HTMLDivElement | null) => setHost(el?.parentElement ?? null), []);
  useSketchInput(host, session);
  // "What is still missing" starts collapsed in every sketch session and is never opened by itself; Esc closes it.
  const [missingOpen, setMissingOpen] = useState(false);
  useEffect(() => {
    if (!missingOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setMissingOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [missingOpen]);
  return (
    <div ref={rootRef} className="contents">
      <div
        role="status"
        data-overlay=""
        data-testid="sketch-prompt"
        data-prompt={state.notice ?? state.prompt}
        className="absolute top-3 left-3 z-[2] flex max-w-[calc(100%-176px)] items-center gap-2 rounded-ctl border border-line-strong bg-surface px-3 py-1.5 text-[12.5px] font-medium shadow-card"
      >
        <span className="text-[16px] text-primary">
          <Glyph name="pencil" />
        </span>
        <span>{state.notice ? t(`sketch.notice.${state.notice}`) : t(`sketch.prompt.${state.prompt}`)}</span>
      </div>
      <SketchOverlay layer={layer} session={session} view={view} state={state} options={options} decimalComma={language === "de"} look={fieldLook} />
      {/* The palette keeps its size; what is still missing is a box of its own below it, so nothing moves when that list changes. */}
      <div className="pointer-events-none absolute top-[152px] right-3 bottom-3 z-[3] flex w-[236px] flex-col gap-2">
        <SketchPalette
          name={name}
          planeLabel={planeLabel}
          view={view}
          drawing={state.inProgress}
          colour={colour}
          showConstraints={options.showConstraints}
          showDimensions={options.showDimensions}
          onShowConstraints={onShowConstraints}
          onShowDimensions={onShowDimensions}
          onFinish={onFinish}
          finishing={finishing}
          missingChip={<MissingChip view={view} open={missingOpen} onToggle={() => setMissingOpen((on) => !on)} />}
        />
        <SketchMissing session={session} view={view} open={missingOpen} onClose={() => setMissingOpen(false)} />
      </div>
    </div>
  );
}
