import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx.ts";

export interface ScrollAreaProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  children: ReactNode;
  /** Class names for the scrolling viewport (set max-h-* here). */
  viewportClassName?: string;
}

interface Thumb {
  height: number;
  top: number;
}

/**
 * Scroll container whose scrollbar overlays the content and never takes layout space: the native bar is hidden and
 * a slim thumb appears only when there is something to scroll, while scrolling, on hover and while dragging.
 */
export function ScrollArea({ children, className, viewportClassName, ...rest }: ScrollAreaProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<Thumb | null>(null);
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<number | undefined>(undefined);
  const drag = useRef<{ startY: number; startTop: number } | null>(null);

  const measure = useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    const ratio = el.clientHeight / el.scrollHeight;
    if (ratio >= 1 || el.scrollHeight === 0) {
      setThumb(null);
      return;
    }
    const height = Math.max(28, el.clientHeight * ratio);
    const top = (el.scrollTop / (el.scrollHeight - el.clientHeight)) * (el.clientHeight - height);
    setThumb({ height, top });
  }, []);

  const flash = useCallback(() => {
    setVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setVisible(false), 900);
  }, []);

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => {
      observer.disconnect();
      window.clearTimeout(hideTimer.current);
    };
  }, [measure, children]);

  const onThumbPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!thumb) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startY: event.clientY, startTop: thumb.top };
    setVisible(true);
  };
  const onThumbPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = viewport.current;
    if (!drag.current || !el || !thumb) return;
    const track = el.clientHeight - thumb.height;
    const top = Math.min(track, Math.max(0, drag.current.startTop + event.clientY - drag.current.startY));
    el.scrollTop = (top / track) * (el.scrollHeight - el.clientHeight);
  };
  const onThumbPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    flash();
  };

  return (
    <div
      className={cx("group/scroll relative min-h-0 overflow-hidden", className)}
      onPointerEnter={() => thumb && setVisible(true)}
      onPointerLeave={() => !drag.current && setVisible(false)}
    >
      <div
        ref={viewport}
        className={cx("h-full overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", viewportClassName)}
        onScroll={() => {
          measure();
          flash();
        }}
        // A scrollable area has to be reachable with the keyboard.
        tabIndex={thumb ? 0 : undefined}
        {...rest}
      >
        {children}
      </div>
      {thumb ? (
        <div
          role="presentation"
          data-scroll-thumb
          onPointerDown={onThumbPointerDown}
          onPointerMove={onThumbPointerMove}
          onPointerUp={onThumbPointerUp}
          className={cx(
            "absolute right-[2px] w-[6px] cursor-default touch-none rounded-sm bg-muted transition-opacity duration-200",
            visible ? "opacity-70" : "pointer-events-none opacity-0",
          )}
          style={{ height: thumb.height, top: thumb.top }}
        />
      ) : null}
    </div>
  );
}
