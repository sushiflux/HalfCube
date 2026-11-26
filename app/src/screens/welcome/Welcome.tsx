import { motion } from "motion/react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useT } from "../../i18n/runtime.ts";
import type { MessageKey } from "../../i18n/types.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { CreditLine, Logo, Wordmark } from "../../ui/Brand.tsx";
import { Checkbox } from "../../ui/Checkbox.tsx";
import { cx } from "../../ui/cx.ts";
import { IconChevronRight, IconClose, IconCube, IconFree, IconOpen, IconPlus, IconSketch, IconTimeline, IconTour } from "../../ui/icons.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { ScrollArea } from "../../ui/ScrollArea.tsx";
import { currentVersion } from "../../version.ts";
import "./welcome.css";

export interface WelcomeProps {
  open: boolean;
  /** Esc, the close button, "Skip" and "Later": the dialog goes away for this start. */
  onClose: () => void;
  onNewProject: () => void;
  onOpenProject: () => void;
  onTour: () => void;
  /** The licence hint line: opens "About HalfCube" on the Lizenzen tab with the HalfCube licence. */
  onShowLicence: () => void;
  /** The checkbox "Don't show this at the next start". */
  dontShowAgain: boolean;
  onDontShowAgainChange: (value: boolean) => void;
}

type Page = 1 | 2;

const points: readonly { icon: ReactNode; key: MessageKey }[] = [
  { icon: <IconSketch />, key: "welcome.pointSketch" },
  { icon: <IconCube />, key: "welcome.pointBodies" },
  { icon: <IconTimeline />, key: "welcome.pointTimeline" },
  { icon: <IconFree />, key: "welcome.pointFree" },
];

/**
 * Welcome at program start, two pages: "Sketch first, then build" with the early-access note, then "How do you want
 * to start?". It appears at every start until the user ticks "Don't show this at the next start". The language page
 * is not here: the setup chooses the language.
 */
export function Welcome({ open, onClose, onNewProject, onOpenProject, onTour, onShowLicence, dontShowAgain, onDontShowAgainChange }: WelcomeProps) {
  const t = useT();
  const [page, setPage] = useState<Page>(1);
  const titleId = useId();
  const nextRef = useRef<HTMLButtonElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);

  // Keep the keyboard focus on the main control of the page that is showing.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    (page === 1 ? nextRef : firstActionRef).current?.focus();
  }, [page]);

  const steps: readonly { page: Page; label: string }[] = [
    { page: 1, label: t("welcome.stepIntro") },
    { page: 2, label: t("welcome.stepStart") },
  ];

  const actions: readonly { icon: ReactNode; title: string; hint: string; run: () => void; primary?: boolean; ref?: typeof firstActionRef }[] = [
    { icon: <IconPlus />, title: t("welcome.newProject"), hint: t("welcome.newProjectHint"), run: onNewProject, primary: true, ref: firstActionRef },
    { icon: <IconOpen />, title: t("welcome.openProject"), hint: t("welcome.openProjectHint"), run: onOpenProject },
    { icon: <IconTour />, title: t("welcome.tour"), hint: t("welcome.tourHint"), run: onTour },
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      aria-labelledby={titleId}
      initialFocus={nextRef}
      closeOnBackdrop={false}
      className="grid h-[min(600px,calc(100vh-min(12vh,120px)-16px))] w-[920px] grid-cols-[300px_1fr] overflow-hidden rounded-card border border-line bg-surface text-fg shadow-dialog max-[860px]:grid-cols-1"
    >
      <aside className="hc-night flex flex-col px-[30px] pt-[30px] max-[860px]:hidden" aria-hidden="true">
        <div className="hc-night-grid" />
        <Logo size={300} source="medium" className="hc-night-mark" />
        <div className="relative z-[1] flex items-center gap-3">
          <Logo size={40} source="medium" />
          <Wordmark size={27} />
        </div>
        <div className="hc-night-what relative z-[1] mt-3 text-[11.5px] font-semibold tracking-[0.16em] uppercase">
          {t("welcome.firstStart")}
        </div>
        <ol className="relative z-[1] mt-10 flex list-none flex-col p-0">
          {steps.map((step) => {
            const state = step.page < page ? "done" : step.page === page ? "active" : "todo";
            return (
              <li key={step.page} className="hc-night-step" data-state={state}>
                <span className="hc-night-dot">
                  {state === "done" ? (
                    <svg width="12" height="12" viewBox="0 0 16 16">
                      <path d="M3.4 8.4l3 3 6.2-7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    step.page
                  )}
                </span>
                {step.label}
              </li>
            );
          })}
        </ol>
        <div className="hc-night-foot relative z-[1] mt-auto pt-3.5 pb-5">
          <div className="mono text-[#d5e2ea]">{currentVersion().display}</div>
          <CreditLine onDark className="mt-1 block" />
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-col bg-surface">
        <div className="flex h-11 flex-none justify-end pr-1">
          <IconButton label={t("common.close")} onClick={onClose} className="mt-0.5">
            <IconClose />
          </IconButton>
        </div>

        <ScrollArea className="flex-1" viewportClassName="px-10 pt-1.5 pb-4">
          {page === 1 ? (
            <section aria-labelledby={titleId}>
              <div className="text-[11.5px] font-semibold tracking-[0.16em] text-primary uppercase">{t("welcome.introKicker")}</div>
              <h2 id={titleId} className="mt-2 text-[27px] leading-[1.2] font-semibold tracking-[-0.015em]">
                {t("welcome.introTitle")}
              </h2>
              <ul className="mt-[22px] flex list-none flex-col gap-1.5 p-0">
                {points.map((point, index) => (
                  <motion.li
                    key={point.key}
                    className="flex min-h-[30px] items-center gap-3 text-[13.5px]"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.08 + index * 0.06, duration: 0.25 }}
                  >
                    <span className="grid size-7 flex-none place-items-center rounded-ctl bg-primary-soft text-base text-primary">{point.icon}</span>
                    {t(point.key)}
                  </motion.li>
                ))}
              </ul>
              <div className="relative mt-[22px] overflow-hidden rounded-card border border-line bg-surface-2 py-3 pr-4 pl-[19px] text-[13px] text-muted">
                <span className="absolute top-0 bottom-0 left-0 w-[3px] bg-primary" aria-hidden="true" />
                <b className="font-semibold text-fg">{t("welcome.earlyTitle")}</b> {t("welcome.earlyText")}
              </div>
            </section>
          ) : (
            <section aria-labelledby={titleId}>
              <div className="text-[11.5px] font-semibold tracking-[0.16em] text-primary uppercase">{t("welcome.startKicker")}</div>
              <h2 id={titleId} className="mt-2 text-[27px] leading-[1.2] font-semibold tracking-[-0.015em]">
                {t("welcome.startTitle")}
              </h2>
              <div className="mt-[22px] grid gap-2.5">
                {actions.map((action, index) => (
                  <motion.button
                    key={action.title}
                    ref={action.ref}
                    type="button"
                    onClick={action.run}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.06 + index * 0.06, duration: 0.25 }}
                    className={cx(
                      "relative grid w-full cursor-pointer grid-cols-[40px_1fr_auto] items-center gap-3.5 overflow-hidden rounded-card border px-4 py-3.5 text-left",
                      action.primary ? "border-primary bg-primary-soft" : "border-line bg-surface-2 hover:border-line-strong",
                    )}
                  >
                    {action.primary ? <span className="absolute top-0 bottom-0 left-0 w-[3px] bg-primary" aria-hidden="true" /> : null}
                    <span
                      className={cx(
                        "grid size-10 place-items-center rounded-ctl text-xl",
                        action.primary ? "bg-primary text-on-primary" : "bg-surface text-primary",
                      )}
                    >
                      {action.icon}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[15px] font-semibold">{action.title}</span>
                      <span className="block text-[13px] text-muted">{action.hint}</span>
                    </span>
                    <span className="text-lg text-muted">
                      <IconChevronRight />
                    </span>
                  </motion.button>
                ))}
              </div>
            </section>
          )}
        </ScrollArea>

        {/* The licence hint is on both pages and in both versions; the link opens the licence text in "About HalfCube". It has a row
            of its own, as wide as the dialog's content, so it never wraps and nothing moves between the pages. */}
        <p className="m-0 flex h-8 flex-none items-center px-10 text-[12px] whitespace-nowrap text-muted" data-testid="welcome-licence-hint">
          {t("welcome.licenceHint")}&nbsp;<span aria-hidden="true">·</span>&nbsp;
          <button type="button" onClick={onShowLicence} data-testid="welcome-licence-link" className="cursor-pointer rounded-sm font-medium text-primary hover:underline">
            {t("welcome.licenceLink")}
          </button>
        </p>

        <div className="flex h-[76px] flex-none items-center gap-3.5 border-t border-line px-10">
          <Checkbox checked={dontShowAgain} onChange={onDontShowAgainChange} label={t("welcome.dontShowAgain")} className="min-w-0 flex-1" />
          {page === 1 ? (
            <>
              <Button variant="quiet" size="lg" onClick={onClose}>
                {t("common.skip")}
              </Button>
              <Button ref={nextRef} variant="primary" size="lg" className="min-w-[104px]" onClick={() => setPage(2)}>
                {t("common.next")}
              </Button>
            </>
          ) : (
            <>
              <Button size="lg" onClick={() => setPage(1)}>
                {t("common.back")}
              </Button>
              <Button size="lg" onClick={onClose}>
                {t("common.later")}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
