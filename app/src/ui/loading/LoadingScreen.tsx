import { animate, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef } from "react";
import { useT } from "../../i18n/runtime.ts";
import { currentVersion } from "../../version.ts";
import { Button } from "../Button.tsx";
import { logoSources, Wordmark } from "../Brand.tsx";
import { ErrorNotice } from "../ErrorNotice.tsx";
import { IconRetry, StepIcon } from "../icons.tsx";
import "./loading.css";
import { currentStepIndex, isComplete, overallProgress } from "./progress.ts";
import type { LoadingAction, LoadingProgress } from "./types.ts";
import { branding } from "../../branding.ts";

export interface LoadingScreenProps {
  progress: LoadingProgress;
  /** A button of the error card was pressed (its id from LoadingError.actions). */
  onAction?: (id: string) => void;
  /**
   * The hand-over animation has finished: the logo has arrived in the header and the screen can be removed.
   * The logo flies to the element marked data-handover-target; without one the screen just fades out.
   */
  onHandoverDone?: () => void;
}

const logoViewBox = 1351; // pixels of branding/icons/icon-512.png's source square

export function actionButtons(actions: readonly LoadingAction[] | undefined, onAction: ((id: string) => void) | undefined) {
  return (actions ?? []).map((action) => (
    <Button
      key={action.id}
      variant={action.primary ? "primary" : "neutral"}
      icon={action.id === "retry" || action.id === "reload" ? <IconRetry /> : undefined}
      onClick={() => onAction?.(action.id)}
    >
      {action.label}
    </Button>
  ));
}

/**
 * Loading screen at program start, variant "Bühne": the logo with a light shimmer, the wordmark, one fine progress
 * line and the current step. Real progress only. A failure replaces the progress in place (full text, copyable); the
 * logo, the wordmark and everything else stay where they are. When all steps are done the logo flies to the header.
 */
export function LoadingScreen({ progress, onAction, onHandoverDone }: LoadingScreenProps) {
  const t = useT();
  const reduced = useReducedMotion() ?? false;
  const root = useRef<HTMLDivElement>(null);
  const logo = useRef<HTMLDivElement>(null);
  const bg = useRef<HTMLDivElement>(null);
  const maskId = useId();
  const gradientId = useId();
  const doneRef = useRef(onHandoverDone);
  useEffect(() => {
    doneRef.current = onHandoverDone;
  }, [onHandoverDone]);

  const { steps, error } = progress;
  const complete = isComplete(progress);
  const fraction = overallProgress(progress);
  const index = currentStepIndex(steps);
  const current = steps[index];
  const total = steps.length;
  const percent = Math.round(fraction * 100);

  // Hand-over: after a short pause the logo flies into the header, everything else fades, then the screen goes away.
  useEffect(() => {
    if (!complete) return;
    const rootEl = root.current;
    const logoEl = logo.current;
    if (!rootEl || !logoEl) return;
    const controls: { stop: () => void }[] = [];
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const target = document.querySelector<HTMLElement>("[data-handover-target]");
        if (reduced || !target) {
          const fade = animate(rootEl, { opacity: 0 }, { duration: reduced ? 0.25 : 0.4 });
          controls.push(fade);
          await fade;
        } else {
          const from = logoEl.getBoundingClientRect();
          const to = target.getBoundingClientRect();
          const scale = to.width / from.width;
          const fadeEls = rootEl.querySelectorAll<HTMLElement>("[data-fade]");
          const flight = animate(
            logoEl,
            { x: to.left - from.left, y: to.top - from.top, scale },
            { duration: 0.9, ease: [0.65, 0, 0.35, 1] },
          );
          const fade = animate(fadeEls, { opacity: 0 }, { duration: 0.5 });
          const backdrop = bg.current ? animate(bg.current, { opacity: 0 }, { duration: 0.7, delay: 0.2 }) : undefined;
          controls.push(flight, fade);
          if (backdrop) controls.push(backdrop);
          await flight;
        }
        if (!cancelled) doneRef.current?.();
      })();
    }, reduced ? 150 : 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      for (const c of controls) c.stop();
    };
  }, [complete, reduced]);

  const failedStep = steps.find((s) => s.state === "failed");
  const lineKey = complete ? "ready" : `${current?.id ?? "none"}:${current?.state ?? ""}`;
  const stepIcon = complete ? "done" : (current?.state ?? "pending");
  const lineText = complete ? t("loading.ready") : (current?.label ?? "");
  const detail = !complete && current?.detail ? ` · ${current.detail}` : "";
  const counter = complete
    ? t("common.stepOf", { current: total, total })
    : t("common.stepOf", { current: Math.min(index + 1, total), total });

  return (
    <div ref={root} className="hc-stage" aria-busy={!complete && !error} data-testid="loading-screen">
      <div ref={bg} className="hc-stage-bg" />
      <div className="hc-stage-inner">
      <div className="hc-halo" data-fade />

      <div ref={logo} className="hc-logo">
        <svg viewBox={`0 0 ${logoViewBox} ${logoViewBox}`} role="img" aria-label={branding.name} className="hc-logo-intro">
          <defs>
            <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={logoViewBox} height={logoViewBox} style={{ maskType: "alpha" }}>
              <image href={logoSources.large} width={logoViewBox} height={logoViewBox} />
            </mask>
            <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor="#fff" stopOpacity="0" />
              <stop offset=".5" stopColor="#fff" stopOpacity=".38" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
          </defs>
          <image href={logoSources.large} width={logoViewBox} height={logoViewBox} />
          <g mask={`url(#${maskId})`}>
            <rect className="hc-sweep" x="0" y="0" width="520" height={logoViewBox} fill={`url(#${gradientId})`} />
          </g>
        </svg>
      </div>

      <div className="hc-word" data-fade>
        <Wordmark size="calc(68 * var(--u))" small={false} />
      </div>
      <div className="hc-slogan" data-fade data-testid="loading-slogan" lang="en">
        {branding.slogan}
      </div>
      <div className="hc-tag" data-fade>
        {t("loading.earlyAccess")}
      </div>

      <div className="hc-vers mono" data-fade>
        {currentVersion().display}
      </div>

      <div className="hc-slot" data-fade>
        <div className="hc-slot-load" data-hidden={error ? "true" : "false"} aria-hidden={error ? true : undefined}>
          <div
            className="hc-track"
            role="progressbar"
            aria-label={t("loading.progress")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div
              className="hc-fill"
              style={{
                width: `${(fraction * 100).toFixed(2)}%`,
                ["--head" as string]: fraction > 0.002 && fraction < 0.999 ? 1 : 0,
              }}
            />
          </div>
          <div key={lineKey} className="hc-stepline hc-fadein" role="status">
            {total > 0 ? <StepIcon state={stepIcon} /> : null}
            <span>{lineText}</span>
          </div>
          <div className="hc-stepsub mono">{total > 0 ? `${counter}${detail}` : ""}</div>
        </div>
        {error ? (
          <div className="hc-slot-error">
            <ErrorNotice
              headline={error.headline}
              code={error.code}
              details={error.details}
              actions={actionButtons(error.actions, onAction)}
              detailsMaxHeight="var(--hc-details-max)"
              defaultOpen={false}
              className="mx-auto"
            />
            {failedStep ? <span className="sr-only">{failedStep.label}</span> : null}
          </div>
        ) : null}
      </div>
      </div>
    </div>
  );
}
