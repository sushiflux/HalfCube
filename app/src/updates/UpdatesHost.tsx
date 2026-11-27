// The one place in the app shell that runs the update function: it attaches the updater (desktop program only), starts the
// automatic checks once the main window is shown, opens "Was ist neu" by itself on the first start after an update, drops views
// that no longer have anything to show (after a reload, for example) and renders the update windows.
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/runtime.ts";
import { useAnyModalOpen } from "../ui/Modal.tsx";
import { updates, useUpdates } from "./controller.ts";
import { ChangesDialog } from "./ChangesDialog.tsx";
import { NewsDialog } from "./NewsDialog.tsx";
import { decideNewsOnStart, newsReadiness } from "./news-logic.ts";
import { CheckErrorDialog, RestartingDialog, RestartWarning } from "./RestartDialogs.tsx";
import { newsSourceRef, pickUpdatesBridge } from "./runtime.ts";
import { UpdateDialog } from "./UpdateDialog.tsx";
import { updateUi, useUpdateUi } from "./ui-state.ts";
import { detailError, isSupported, updateWindowValid } from "./view-model.ts";
import { restartNeedsWarning, useDesignWork, workStore } from "./work.ts";

/** How often the running program asks again when the setting allows it (the schedule decides whether a check is due). */
export const CHECK_TIMER_MS = 60 * 60 * 1000;

export interface UpdatesHostProps {
  /** The loading screen is gone: the main window is shown. Nothing starts before. */
  ready: boolean;
  /** The welcome screen is open: it owns the screen, "Was ist neu" waits. */
  welcomeOpen: boolean;
}

export function UpdatesHost({ ready, welcomeOpen }: UpdatesHostProps) {
  const { language } = useI18n();
  const snapshot = useUpdates();
  const ui = useUpdateUi();
  const work = useDesignWork();
  const modalOpen = useAnyModalOpen();
  // "pending" until the bridge is chosen; "none" in the browser version.
  const [environment, setEnvironment] = useState<"pending" | "none" | "ready">("pending");

  useEffect(() => {
    let detach: (() => void) | undefined;
    let cancelled = false;
    void pickUpdatesBridge().then((bridge) => {
      if (cancelled) return;
      if (bridge) detach = updates.attach(bridge);
      setEnvironment(bridge ? "ready" : "none");
    });
    return () => {
      cancelled = true;
      detach?.();
    };
  }, []);

  const supported = isSupported(snapshot.state);

  // Automatic checks: one right after the main window is shown, then a timer; the schedule setting decides whether one is due.
  const startupChecked = useRef(false);
  useEffect(() => {
    if (!ready || !supported) return;
    if (!startupChecked.current) {
      startupChecked.current = true;
      void updates.autoCheck(true);
    }
    const timer = window.setInterval(() => void updates.autoCheck(false), CHECK_TIMER_MS);
    return () => window.clearInterval(timer);
  }, [ready, supported]);

  // "Was ist neu" opens by itself once, when nothing else owns the screen.
  const newsDecided = useRef(false);
  const knownState = snapshot.state !== null;
  // The browser version has no updater but gets "Was ist neu" all the same (it is decided once, on the first visit of a newer build).
  const readiness = newsReadiness({ bridge: environment === "ready", state: snapshot.state });
  useEffect(() => {
    if (newsDecided.current || !ready || welcomeOpen || modalOpen || ui.news || environment === "pending" || !readiness.known) return;
    newsDecided.current = true;
    const source = newsSourceRef.current;
    const decision = decideNewsOnStart({
      autoAllowed: source.autoAllowed,
      supported: readiness.supported,
      currentId: source.currentId,
      lastShownId: source.lastShownId(),
      markdown: source.markdown(),
      language,
    });
    if (decision.kind === "open") updateUi.openNews();
    else if (decision.kind === "remember") source.remember(source.currentId);
  }, [ready, welcomeOpen, modalOpen, ui.news, environment, readiness.known, readiness.supported, language]);

  // A view that has nothing to show any more is dropped: an address with ?update=window after the update was installed, an update
  // window in the browser, the restart warning when the design is empty.
  useEffect(() => {
    if (environment === "pending" || !ui.view) return;
    if (environment === "none") {
      updateUi.closeView();
      return;
    }
    if (!knownState) return;
    const phase = isSupported(snapshot.state) ? snapshot.state.phase.kind : null;
    if (ui.view === "window" && !updateWindowValid(snapshot.state)) updateUi.closeView();
    else if (ui.view === "error" && !(isSupported(snapshot.state) && detailError(snapshot.state.phase))) updateUi.closeView();
    else if (ui.view === "restart" && ((phase !== "ready" && phase !== "on-exit") || !restartNeedsWarning(workStore.get()))) updateUi.closeView();
  }, [environment, ui.view, knownState, snapshot.state]);

  // Without an updater there is nothing to show except "Was ist neu" (reachable from the settings), which needs no updater.
  const envKnown = environment !== "pending";
  return (
    <>
      {environment === "ready" ? (
        <>
          <UpdateDialog open={ui.view === "window"} />
          <RestartWarning open={ui.view === "restart"} work={work} />
          <RestartingDialog />
          <CheckErrorDialog open={ui.view === "error"} />
        </>
      ) : null}
      <NewsDialog open={envKnown && ui.news} />
      <ChangesDialog source={envKnown ? ui.changes : null} />
    </>
  );
}
