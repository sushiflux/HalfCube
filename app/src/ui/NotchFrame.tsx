// A floating window with the corner action in a notch cut out of its top-right corner (the preferred style of the product, skill
// ui-regeln): the outline follows the notch without a break, the button's top and right edges lie flush on the outline and the gap is only
// on its left and below. The outline is an SVG path drawn for the measured size, so the window can have any height; the content
// sits on top of it. The button comes in as `action` and keeps its own 30 px size, focus ring and aria-label.
import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx.ts";

/** Side of the square the notch cuts out of the corner, in CSS px; the button is 30 px and sits in the notch's corner. */
export const NOTCH_SIZE = 36;
export const NOTCH_BUTTON = 30;

const R = 6; // outer corner radius
const r = 5; // radius of the notch's inner corners

/** The outline of a W x H window with the notch, 1 px stroke, half a pixel in so the stroke is not clipped. */
export function notchPath(w: number, h: number): string {
  const n = NOTCH_SIZE;
  return [
    `M${R} .5`,
    `L${w - n - r} .5`,
    `Q${w - n} .5 ${w - n} ${r}`,
    `L${w - n} ${n - r}`,
    `Q${w - n} ${n} ${w - n + r} ${n}`,
    `L${w - r - 0.5} ${n}`,
    `Q${w - 0.5} ${n} ${w - 0.5} ${n + r}`,
    `L${w - 0.5} ${h - R}`,
    `Q${w - 0.5} ${h - 0.5} ${w - R} ${h - 0.5}`,
    `L${R} ${h - 0.5}`,
    `Q.5 ${h - 0.5} .5 ${h - R}`,
    `L.5 ${R}`,
    `Q.5 .5 ${R} .5`,
    "Z",
  ].join(" ");
}

export interface NotchFrameProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** The corner button (a close X); placed in the notch. */
  action: ReactNode;
  children: ReactNode;
}

export function NotchFrame({ action, children, className, ...rest }: NotchFrameProps) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize((s) => (s && s.w === el.offsetWidth && s.h === el.offsetHeight ? s : { w: el.offsetWidth, h: el.offsetHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={box} className={cx("relative", className)} {...rest}>
      {size ? (
        <svg aria-hidden="true" width={size.w} height={size.h} className="pointer-events-none absolute inset-0 overflow-visible [filter:drop-shadow(0_4px_12px_rgb(0_0_0/0.16))]">
          <path d={notchPath(size.w, size.h)} className="fill-surface stroke-line-strong" strokeWidth="1" />
        </svg>
      ) : null}
      <div className="absolute top-0 right-0 z-[2]">{action}</div>
      <div className="relative">{children}</div>
    </div>
  );
}
