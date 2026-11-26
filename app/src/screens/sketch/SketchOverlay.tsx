// The HTML on top of the sketch in the 3D view: the value texts of the dimensions (double-click edits), the constraint
// symbols, the text that follows the pointer while a dimension is placed, the value fields of the shape being drawn and
// the field that edits a dimension (both are the shared ValueField). The layer draws the geometry, the measuring lines and
// arrowheads of the live values included, and tells where each text sits; this file only puts the text there. Two
// looks, chosen in the settings dialog: "dimension" (the value is calm text on its dimension line, the field that is typed
// into a light surface with an accent line) and "tag" (filled labels with a leader line to the geometry). Everything is an
// overlay (absolute, no layout space), so showing, hiding or resizing a field moves nothing else.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DimensionKind } from "../../document/types.ts";
import { useI18n } from "../../i18n/runtime.ts";
import { quantityErrorText, type SketchView } from "../../model/index.ts";
import type { FieldLook } from "../../prefs/settings.ts";
import { cx } from "../../ui/cx.ts";
import { Glyph } from "../../ui/Glyph.tsx";
import { Tip } from "../../ui/Tip.tsx";
import { FIELD_SIZE, ValueField } from "../../ui/ValueField.tsx";
import type { SketchLayer, SketchLayerOptions } from "../../viewport/sketch/types.ts";
import { constraintGlyph } from "../main/timeline-model.ts";
import { clampSpot, messageSpot, placeFields, type FieldSpot, type Size } from "./field-layout.ts";
import { dimensionName } from "../../document/parameter-names.ts";
import { describeElement, dimensionLabelName, dimensionValueText } from "./describe.ts";
import { formatLive, formatNumber } from "./geometry.ts";
import type { DimEditState, SessionState, SketchSession } from "./session.ts";

/** The text of a dimension label: "60", "30°", "Ø40", "R5"; a reference dimension in brackets. */
export function dimensionText(kind: DimensionKind, value: number, decimalComma: boolean, reference: boolean): string {
  const n = formatNumber(value, decimalComma);
  const text = kind === "angle" ? `${n}°` : kind === "diameter" ? `Ø${n}` : kind === "radius" ? `R${n}` : n;
  return reference ? `(${text})` : text;
}

function useLayerVersion(layer: SketchLayer): number {
  const version = useRef(0);
  return useSyncExternalStore(
    (listener) =>
      layer.subscribe(() => {
        version.current += 1;
        listener();
      }),
    () => version.current,
  );
}

/** The value of a dimension: calm text in the colour of the view (it hides the line under the digits), no box and no frame. */
const dimText =
  "absolute -translate-x-1/2 -translate-y-1/2 rounded-sm bg-viewport px-1.5 text-[13px] font-medium leading-[22px] whitespace-nowrap tabular-nums";

export interface SketchOverlayProps {
  layer: SketchLayer;
  session: SketchSession;
  view: SketchView;
  state: SessionState;
  options: SketchLayerOptions;
  decimalComma: boolean;
  look: FieldLook;
}

export function SketchOverlay({ layer, session, view, state, options, decimalComma, look }: SketchOverlayProps) {
  const { t } = useI18n();
  useLayerVersion(layer);
  const [box, boxRef] = useBox();
  const selected = new Set(state.selection);
  const editingId = state.dimEdit?.id ?? null;
  const dimensions = new Map(view.dimensions.map((d) => [d.id, d]));
  const constraints = new Map(view.constraints.map((c) => [c.id, c]));
  const dimName = (id: string): string => {
    const d = dimensions.get(id);
    return d ? `${dimensionLabelName(t, d)} ${t(`sketch.dim.${d.kind}`)} ${dimensionText(d.kind, d.driving ? d.value.value : (d.measured ?? d.value.value), decimalComma, !d.driving)}` : t("sketch.element.dimension");
  };
  const dimAnchors = layer.dimensionAnchors();
  return (
    <div ref={boxRef} className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="sketch-overlay" aria-label={t("sketch.overlay.label")}>
      {options.showDimensions
        ? dimAnchors.map((a) => {
            const d = dimensions.get(a.id);
            if (!d || a.id === editingId) return null;
            const reference = !d.driving;
            const bad = d.state !== "ok";
            // The tooltip names the dimension: its automatic name and its value, "d3 · 40 mm".
            const tip = t("sketch.dim.tip", { name: dimensionLabelName(t, d), value: dimensionValueText(d, decimalComma) });
            return (
              <span key={a.id} className="pointer-events-none absolute flex size-0" style={{ left: a.x, top: a.y }}>
              <Tip label={tip} className="after:mt-3">
              <button
                type="button"
                data-overlay=""
                data-testid={`dim-${a.id}`}
                data-name={dimensionName(d)}
                data-reference={reference || undefined}
                aria-label={t("sketch.dim.edit", { name: dimName(a.id) })}
                aria-pressed={selected.has(a.id)}
                onClick={() => session.select([a.id])}
                onDoubleClick={() => session.editDimension(a.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === "F2") {
                    e.preventDefault();
                    session.editDimension(a.id);
                  }
                }}
                className={cx(
                  dimText,
                  "pointer-events-auto cursor-pointer",
                  // A reference dimension only measures: the muted token (contrast pair t16 against the view) and the brackets of
                  // its text, no frame. A selected one carries the accent line on its bottom edge.
                  bad ? "text-error" : reference ? "text-muted" : "text-dim-text",
                  selected.has(a.id) && "after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-selection",
                )}
              >
                {dimensionText(d.kind, reference ? (d.measured ?? d.value.value) : d.value.value, decimalComma, reference)}
              </button>
              </Tip>
              </span>
            );
          })
        : null}
      {options.showConstraints
        ? layer.constraintAnchors().map((a) => {
            // A constraint that joins two curves has a second anchor named "<id>#2".
            const id = a.id.split("#")[0]!;
            const c = constraints.get(id);
            if (!c) return null;
            const bad = c.state !== "ok";
            return (
              <button
                key={a.id}
                type="button"
                data-overlay=""
                data-testid={`constraint-${a.id}`}
                data-kind={c.kind}
                aria-label={describeElement(t, view, id, decimalComma)}
                aria-pressed={selected.has(id)}
                onClick={() => session.select([id])}
                style={{ left: a.x, top: a.y }}
                className={cx(
                  "pointer-events-auto absolute grid size-[18px] -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center rounded-sm border bg-viewport-2 text-[13px]",
                  bad ? "border-error text-error" : "border-constraint text-constraint",
                  selected.has(id) && "shadow-[0_0_0_2px_var(--c-selection)]",
                )}
              >
                <Glyph name={constraintGlyph[c.kind] ?? "cFix"} />
              </button>
            );
          })
        : null}
      {state.ghost ? <Ghost layer={layer} state={state} decimalComma={decimalComma} look={look} /> : null}
      {state.typed ? <DrawFields layer={layer} session={session} typed={state.typed} box={box} decimalComma={decimalComma} look={look} /> : null}
      {state.dimEdit ? (
        <DimBox
          key={`${state.dimEdit.id ?? "new"}:${state.dimEdit.at.join(",")}`}
          layer={layer}
          session={session}
          edit={state.dimEdit}
          look={look}
          anchor={editingId ? (dimAnchors.find((a) => a.id === editingId) ?? null) : null}
          box={box}
        />
      ) : null}
    </div>
  );
}

function Ghost({ layer, state, decimalComma, look }: { layer: SketchLayer; state: SessionState; decimalComma: boolean; look: FieldLook }) {
  const g = state.ghost;
  if (!g) return null;
  const at = layer.toScreen(g.at[0], g.at[1]);
  return (
    <span
      aria-hidden="true"
      data-testid="dimension-ghost"
      data-look={look}
      style={{ left: at.x, top: at.y, ...(look === "tag" ? { height: FIELD_SIZE.tag.h } : {}) }}
      className={
        // The dimension that is placed follows the pointer: calm text on its line, or a grey label.
        look === "tag"
          ? "absolute flex -translate-x-1/2 -translate-y-1/2 items-center rounded-ctl bg-muted px-2.5 text-[13.5px] font-semibold whitespace-nowrap text-surface tabular-nums shadow-card"
          : cx(dimText, "text-[14px] text-fg")
      }
    >
      {dimensionText(g.dimKind, g.value, decimalComma, false)}
    </span>
  );
}

/** The width of the message under a value field and the room it may need; it wraps, so the height is a generous guess for the placement only. */
const MESSAGE: Size = { w: 260, h: 96 };

/** The size of the overlay's own box, kept up to date while the view is resized. */
function useBox(): [Size, (el: HTMLElement | null) => void] {
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [el, setEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!el) return;
    const read = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [size, setEl];
}

/**
 * The message under a value field: it wraps inside its own width, lies over the sketch (no layout space, so nothing moves
 * when it comes or goes) and flips to the other side near the view's edge. Dimension look: plain text in the view's colour;
 * tag look: a light card with the accent line of an error on its left edge.
 */
function Message({ children, id, spot, box, look }: { children: string; id: string; spot: FieldSpot; box: Size; look: FieldLook }) {
  const place = messageSpot(spot, FIELD_SIZE[look], box, MESSAGE);
  return (
    <div
      id={id}
      role="alert"
      data-look={look}
      style={place}
      className={cx(
        "pointer-events-none absolute w-[260px] text-[12px] leading-[1.4] font-medium text-error",
        look === "dimension" ? "rounded-sm bg-viewport px-2 py-1" : "overflow-hidden rounded-ctl bg-surface py-1.5 pr-2.5 pl-3.5 shadow-card",
      )}
    >
      {look === "tag" ? <span aria-hidden="true" className="absolute top-0 bottom-0 left-0 w-[2px] bg-error" /> : null}
      {children}
    </div>
  );
}

/**
 * Keeps the keyboard in the active field while typing is open. A field that still follows the pointer is selected, so the
 * next character replaces its value; a typed one gets the cursor behind its text. When typing ends the field lets go of
 * the focus, so the sketch keys (tool letters, Esc, Delete) work again.
 */
function useFocusField(typing: boolean, active: string, shown: readonly string[], locked: boolean) {
  const refs = useRef(new Map<string, HTMLInputElement>());
  const last = useRef<string | null>(null);
  const key = shown.join("\u0000");
  useEffect(() => {
    if (!typing) {
      last.current = null;
      for (const el of refs.current.values()) if (document.activeElement === el) el.blur();
      return;
    }
    const el = refs.current.get(active);
    if (!el) return;
    if (document.activeElement !== el) el.focus();
    if (!locked) {
      el.select();
    } else if (last.current !== active) {
      const end = el.value.length;
      el.setSelectionRange(end, end);
    }
    last.current = active;
  }, [typing, active, key, locked]);
  return refs;
}

/**
 * The value fields of the shape being drawn: from the first point on, one field per value, showing the current value
 * while the pointer moves. Look "dimension": the field sits on the dimension line the layer draws for it; look "tag":
 * beside its geometry with a leader line. A typed character overwrites the active field and locks that value; the others
 * keep following the pointer. The fields ignore the pointer (a click beside or under one is a click in the sketch).
 */
function DrawFields({
  layer,
  session,
  typed,
  box,
  decimalComma,
  look,
}: {
  layer: SketchLayer;
  session: SketchSession;
  typed: NonNullable<SessionState["typed"]>;
  box: Size;
  decimalComma: boolean;
  look: FieldLook;
}) {
  const { t } = useI18n();
  const size = FIELD_SIZE[look];
  const shown = typed.fields.map((f) => (f.locked ? f.text : formatLive(f.live, decimalComma)));
  const activeField = typed.fields.find((f) => f.id === typed.active);
  const refs = useFocusField(typed.typing, typed.active, shown, activeField?.locked ?? false);
  const anchors = look === "dimension" ? layer.liveAnchors() : [];
  const spots: FieldSpot[] =
    look === "dimension"
      ? typed.fields.map((f) => {
          const a = anchors.find((x) => x.id === f.id);
          return a ? clampSpot({ x: a.x, y: a.y }, box, size, 6) : { x: Number.NaN, y: Number.NaN };
        })
      : placeFields(
          typed.fields.map((f) => {
            const from = layer.toScreen(f.at[0], f.at[1]);
            const to = layer.toScreen(f.at[0] + f.away[0], f.at[1] + f.away[1]);
            return { x: from.x, y: from.y, dx: to.x - from.x, dy: to.y - from.y, either: f.either };
          }),
          box,
          size,
        );
  const failing = typed.fields.findIndex((f) => f.error);
  const failed = failing >= 0 ? typed.fields[failing] : undefined;
  return (
    <div data-testid="typed-fields" data-look={look} data-typing={typed.typing || undefined} className="pointer-events-none absolute inset-0">
      {look === "tag" ? (
        // The thin leader line from each label to the point of the geometry it measures.
        <svg aria-hidden="true" className="absolute inset-0 size-full overflow-visible">
          {typed.fields.map((f, i) => {
            const spot = spots[i]!;
            const from = layer.toScreen(f.at[0], f.at[1]);
            const colour = f.error ? "stroke-error fill-error" : f.id === typed.active ? "stroke-primary fill-primary" : "stroke-muted fill-muted";
            return (
              <g key={f.id} data-testid={`leader-${f.id}`} className={colour}>
                <line x1={from.x} y1={from.y} x2={spot.x} y2={spot.y} strokeWidth={1} />
                <circle cx={from.x} cy={from.y} r={3} strokeWidth={0} />
              </g>
            );
          })}
        </svg>
      ) : null}
      {typed.fields.map((f, i) => {
        const spot = spots[i]!;
        // A value without a place yet (the layer has not drawn its dimension): nothing to show.
        if (!Number.isFinite(spot.x) || !Number.isFinite(spot.y)) return null;
        const active = f.id === typed.active;
        return (
          <div key={f.id} style={{ left: spot.x - size.w / 2, top: spot.y - size.h / 2, width: size.w }} className="absolute">
            <ValueField
              data-testid={`typed-${f.id}`}
              inputRef={(el) => {
                if (el) refs.current.set(f.id, el);
                else refs.current.delete(f.id);
              }}
              label={t(`sketch.typed.${f.id as "length"}`)}
              unit={f.kind === "angle" ? "°" : "mm"}
              {...(f.id === "diameter" ? { prefix: "Ø" } : {})}
              look={look}
              value={shown[i]!}
              active={active}
              invalid={f.error !== null}
              readOnly={!typed.typing}
              tabIndex={-1}
              aria-describedby={f.error ? "typed-error" : undefined}
              onChange={(text) => session.setTyped(f.id, text)}
              onFocus={() => session.focusTyped(f.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void session.commitTyped();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  session.escape();
                } else if (e.key === "Tab" && typed.fields.length > 1) {
                  e.preventDefault();
                  session.nextTyped();
                }
              }}
            />
          </div>
        );
      })}
      {failed?.error && Number.isFinite(spots[failing]!.x) ? (
        <Message id="typed-error" spot={spots[failing]!} box={box} look={look}>
          {quantityErrorText(t, failed.error, failed.kind)}
        </Message>
      ) : null}
    </div>
  );
}

function DimBox({
  layer,
  session,
  edit,
  anchor,
  box,
  look,
}: {
  layer: SketchLayer;
  session: SketchSession;
  edit: DimEditState;
  anchor: { x: number; y: number } | null;
  box: Size;
  look: FieldLook;
}) {
  const { t } = useI18n();
  const at = anchor ?? layer.toScreen(edit.at[0], edit.at[1]);
  const first = useRef(true);
  const name = t(`sketch.dim.${edit.dimKind}`);
  const size = FIELD_SIZE[look];
  const spot = clampSpot(at, box, size, 6);
  return (
    <>
      <div data-overlay="" data-testid="dim-box" style={{ left: spot.x - size.w / 2, top: spot.y - size.h / 2, width: size.w }} className="pointer-events-auto absolute">
        <ValueField
          data-testid="dim-input"
          inputRef={(el) => {
            // Focused once when the box opens, the whole value selected so typing replaces it.
            if (el && first.current) {
              first.current = false;
              el.focus();
              el.select();
            }
          }}
          label={t("sketch.overlay.inputLabel", { name })}
          unit={edit.unit === "deg" ? "°" : "mm"}
          {...(edit.dimKind === "diameter" ? { prefix: "Ø" } : edit.dimKind === "radius" ? { prefix: "R" } : {})}
          look={look}
          value={edit.text}
          active
          invalid={edit.error !== null}
          aria-describedby={edit.error ? "dim-error" : undefined}
          onChange={(text) => session.setDimText(text)}
          onBlur={() => session.cancelDimEdit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void session.commitDimEdit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              session.cancelDimEdit();
            }
          }}
        />
      </div>
      {edit.error ? (
        <Message id="dim-error" spot={spot} box={box} look={look}>
          {quantityErrorText(t, edit.error, edit.quantity)}
        </Message>
      ) : null}
    </>
  );
}
