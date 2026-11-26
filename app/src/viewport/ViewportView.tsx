// React host of the 3D view: creates the viewport inside a div, keeps its style in step with the active theme (a theme or
// mode switch updates the view live), shows the axis navigator over it, and cleans everything up on unmount. Also safe in
// React's strict mode, where an effect runs, is cleaned up and runs again.
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/runtime.ts";
import { themeStore, useTheme } from "../theme/runtime.ts";
import { cx } from "../ui/cx.ts";
import { ErrorNotice } from "../ui/ErrorNotice.tsx";
import { AxisNavigator } from "./AxisNavigator.tsx";
import { createViewport } from "./index.ts";
import type { AxisLabelMode } from "./navigator-model.ts";
import type { NavigationPreset, WheelZoomDirection } from "./navigation.ts";
import { styleFromTheme } from "./style.ts";
import type { RendererRequest, Viewport } from "./types.ts";

export interface ViewportViewProps {
  className?: string;
  navigationPreset?: NavigationPreset;
  /** Which way the mouse wheel zooms (a pinch is not affected). Set in the settings dialog. */
  wheelZoom?: WheelZoomDirection;
  /** Letters of the axis navigator: view initials (default) or X, Y, Z. Set in the settings dialog. */
  axisLabels?: AxisLabelMode;
  /** "webgl2" forces the fallback backend (tests, diagnosis). */
  renderer?: RendererRequest;
  /** Called with the viewport once it runs, and with null when it is gone. */
  onViewport?: (viewport: Viewport | null) => void;
}

export function ViewportView({ className, navigationPreset = "mouse", wheelZoom = "down-out", axisLabels = "views", renderer = "auto", onViewport }: ViewportViewProps) {
  const { t } = useI18n();
  const { theme, mode } = useTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [failure, setFailure] = useState<Error | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let created: Viewport | null = null;
    setFailure(null);
    // The theme store has the newest state; the preset and later theme changes are applied by the effects below.
    const now = themeStore.getState();
    createViewport(host, { style: styleFromTheme(now.theme, now.mode), renderer }).then(
      (vp) => {
        if (cancelled) {
          vp.dispose();
          return;
        }
        created = vp;
        setViewport(vp);
      },
      (error: unknown) => {
        if (!cancelled) setFailure(error instanceof Error ? error : new Error(String(error)));
      },
    );
    return () => {
      cancelled = true;
      created?.dispose();
      setViewport(null);
    };
  }, [renderer]);

  useEffect(() => {
    onViewport?.(viewport);
  }, [viewport, onViewport]);

  useEffect(() => {
    viewport?.setStyle(styleFromTheme(theme, mode));
  }, [viewport, theme, mode]);

  useEffect(() => {
    viewport?.setNavigationPreset(navigationPreset);
  }, [viewport, navigationPreset]);

  useEffect(() => {
    viewport?.setWheelZoomDirection(wheelZoom);
  }, [viewport, wheelZoom]);

  return (
    <div className={cx("relative overflow-hidden bg-bg", className)} data-testid="viewport">
      <div ref={hostRef} className="absolute inset-0" data-testid="viewport-host" />
      {viewport ? <AxisNavigator viewport={viewport} labels={axisLabels} className="absolute top-3 right-3" /> : null}
      {failure ? (
        <div className="absolute inset-0 grid place-items-center p-6" role="alert">
          <ErrorNotice
            className="max-w-xl"
            headline={t("viewport.unavailableTitle")}
            code="PC-VIEW-001"
            defaultOpen
            details={[
              { kind: "text", text: t("viewport.unavailableText") },
              { kind: "code", text: `${failure.name}: ${failure.message}` },
            ]}
          />
        </div>
      ) : null}
    </div>
  );
}
