import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";

interface Thumb {
  height: number;
  top: number;
}

/**
 * Full-window scroll container for the crash page. The native scrollbar is hidden and a slim overlay thumb is drawn
 * instead, so becoming scrollable never takes layout space or shifts the content sideways. Self-contained on purpose
 * (plain CSS from crash.css, no Tailwind, no theme tokens), because the crash page must work when theming is broken.
 */
export function CrashScroll({
  className,
  testId,
  children,
}: {
  className: string;
  testId: string;
  children: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<Thumb | null>(null);
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<number | undefined>(undefined);
  const drag = useRef<{ startY: number; startTop: number } | null>(null);

  const measure = useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight + 1) {
      setThumb(null);
      return;
    }
    const height = Math.max(32, (el.clientHeight * el.clientHeight) / el.scrollHeight);
    const range = el.scrollHeight - el.clientHeight;
    const top = (el.scrollTop / range) * (el.clientHeight - height);
    setThumb({ height, top });
  }, []);

  const flash = useCallback(() => {
    setVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setVisible(false), 900);
  }, []);

  useEffect(() => {
    const observer = new ResizeObserver(measure);
    if (viewport.current) observer.observe(viewport.current);
    if (content.current) observer.observe(content.current);
    measure();
    return () => {
      observer.disconnect();
      window.clearTimeout(hideTimer.current);
    };
  }, [measure]);

  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!thumb) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startY: event.clientY, startTop: thumb.top };
    setVisible(true);
  };
  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const el = viewport.current;
    if (!drag.current || !el || !thumb) return;
    const track = el.clientHeight - thumb.height;
    const top = Math.min(track, Math.max(0, drag.current.startTop + event.clientY - drag.current.startY));
    el.scrollTop = (top / track) * (el.scrollHeight - el.clientHeight);
  };
  const onUp = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    flash();
  };

  return (
    <div
      className={className}
      role="alert"
      data-testid={testId}
      onPointerEnter={() => thumb && setVisible(true)}
      onPointerLeave={() => !drag.current && setVisible(false)}
    >
      <div ref={viewport} className="pcc-viewport" onScroll={() => (measure(), flash())}>
        <div ref={content}>{children}</div>
      </div>
      {thumb ? (
        <div
          role="presentation"
          data-scroll-thumb
          className="pcc-thumb"
          data-visible={visible}
          style={{ height: thumb.height, top: thumb.top }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
        />
      ) : null}
    </div>
  );
}
