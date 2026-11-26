// The navigation bar at the bottom centre of the 3D view orbit, pan and zoom as drag modes, "fit all",
// then the display-style menu and the grid toggle. These are work switches, not settings, so they may sit in the work
// area; their start values belong to the settings dialog later. A drag mode is on until it is clicked again or Esc
// is pressed. The orbit mode choice (free or fixed up axis) waits until the view offers it.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useT } from "../../i18n/runtime.ts";
import { cx } from "../../ui/cx.ts";
import { Glyph, type GlyphName } from "../../ui/Glyph.tsx";
import { Tip } from "../../ui/Tip.tsx";

export type DragMode = "orbit" | "pan" | "zoom";
export type DisplayStyle = "shaded" | "shadedHidden";

const displayGlyph: Record<DisplayStyle, GlyphName> = { shaded: "shaded", shadedHidden: "shadedHidden" };
const displayStyles: readonly DisplayStyle[] = ["shaded", "shadedHidden"];

export interface NavBarProps {
  mode: DragMode | null;
  onMode: (mode: DragMode | null) => void;
  onFit: () => void;
  display: DisplayStyle;
  onDisplay: (display: DisplayStyle) => void;
  grid: boolean;
  onGrid: (grid: boolean) => void;
}

const button = "relative inline-grid size-9 cursor-pointer place-items-center overflow-hidden rounded-ctl text-[18px] text-muted hover:bg-surface-2 hover:text-fg";
const pressedClass = "bg-primary-soft text-primary hover:bg-primary-soft hover:text-primary";

function PressedLine() {
  return <span aria-hidden="true" className="absolute right-0 bottom-0 left-0 h-0.5 bg-primary" />;
}

export function NavBar({ mode, onMode, onFit, display, onDisplay, grid, onGrid }: NavBarProps) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const wrap = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setMenuOpen(false);
        wrap.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menuOpen]);

  const modeButton = (id: DragMode, glyph: GlyphName, label: string) => {
    const on = mode === id;
    return (
      <Tip label={on ? t("main.nav.modeHint") : label} side="top">
        <button
          type="button"
          aria-label={label}
          aria-pressed={on}
          data-testid={`nav-${id}`}
          onClick={() => onMode(on ? null : id)}
          className={cx(button, on && pressedClass)}
        >
          <Glyph name={glyph} />
          {on ? <PressedLine /> : null}
        </button>
      </Tip>
    );
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitemradio]"));
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };

  const names: Record<DisplayStyle, string> = { shaded: t("main.nav.shaded"), shadedHidden: t("main.nav.shadedHidden") };

  return (
    <div
      role="toolbar"
      aria-label={t("main.nav.label")}
      data-testid="navbar"
      data-overlay=""
      className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-ctl border border-line bg-surface p-[3px]"
    >
      {modeButton("orbit", "orbit", t("main.nav.orbit"))}
      {modeButton("pan", "pan", t("main.nav.pan"))}
      {modeButton("zoom", "zoom", t("main.nav.zoom"))}
      <Tip label={t("main.nav.fit")} side="top">
        <button type="button" aria-label={t("main.nav.fit")} data-testid="nav-fit" onClick={onFit} className={button}>
          <Glyph name="fit" />
        </button>
      </Tip>
      <span role="separator" aria-orientation="vertical" className="mx-1 h-5 w-px flex-none bg-line-strong" />
      <span ref={wrap} className="relative inline-flex">
        <Tip label={menuOpen ? "" : names[display]} side="top">
          <button
            type="button"
            aria-label={`${t("main.nav.display")}: ${names[display]}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            data-testid="nav-display"
            onClick={() => setMenuOpen((o) => !o)}
            className={cx(button, "w-11 grid-flow-col gap-px", menuOpen && "bg-surface-2 text-fg")}
          >
            <Glyph name={displayGlyph[display]} />
            <span className="text-[11px]">
              <Glyph name="chevronUp" />
            </span>
          </button>
        </Tip>
        {menuOpen ? (
          <div
            id={menuId}
            role="menu"
            aria-label={t("main.nav.display")}
            onKeyDown={onMenuKey}
            data-testid="nav-display-menu"
            className="absolute bottom-full left-0 z-50 mb-2 w-max min-w-[250px] overflow-hidden rounded-ctl border border-line-strong bg-surface py-1 shadow-dialog"
          >
            <div className="px-3 pt-1 pb-1.5 text-[11px] font-semibold text-muted">{t("main.nav.display")}</div>
            {displayStyles.map((style) => {
              const on = style === display;
              return (
                <button
                  key={style}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  autoFocus={on}
                  data-testid={`nav-display-${style}`}
                  onClick={() => {
                    onDisplay(style);
                    setMenuOpen(false);
                  }}
                  className={cx("relative flex h-9 w-full cursor-pointer items-center gap-2.5 px-3 text-left text-[13px] hover:bg-surface-2", on ? "bg-primary-soft font-semibold" : "font-medium")}
                >
                  <span className="text-[18px]">
                    <Glyph name={displayGlyph[style]} />
                  </span>
                  <span className="flex-1">{names[style]}</span>
                  <span className="w-4 text-[15px] text-primary">{on ? <Glyph name="check" /> : null}</span>
                  {on ? <span aria-hidden="true" className="absolute top-0 bottom-0 left-0 w-[3px] bg-primary" /> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </span>
      <Tip label={t("main.nav.grid")} side="top">
        <button
          type="button"
          aria-label={t("main.nav.grid")}
          aria-pressed={grid}
          data-testid="nav-grid"
          onClick={() => onGrid(!grid)}
          className={cx(button, grid && pressedClass)}
        >
          <Glyph name="grid" />
          {grid ? <PressedLine /> : null}
        </button>
      </Tip>
    </div>
  );
}
