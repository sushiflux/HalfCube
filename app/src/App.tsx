import { MotionConfig } from "motion/react";
import { lazy, Suspense, useState } from "react";
import { AboutDialog } from "./about/AboutDialog.tsx";
import { LICENCE_ITEM } from "./about/catalogue.ts";
import { aboutStore } from "./about/state.ts";
import { devParams } from "./dev/params.ts";
import { useI18n } from "./i18n/runtime.ts";
import { MainWindow } from "./screens/main/MainWindow.tsx";
import { getMainModel, startNewDocument } from "./screens/main/main-model.ts";
import { patchUrl, readUrlState } from "./screens/main/url-state.ts";
import { isWelcomeHidden, setWelcomeHidden } from "./screens/welcome/preference.ts";
import { Welcome } from "./screens/welcome/Welcome.tsx";
import { ConfirmProvider, useConfirm } from "./ui/Confirm.tsx";
import { engineStatusToProgress, selectEngineView } from "./ui/loading/engine.ts";
import { LoadingPanel } from "./ui/loading/LoadingPanel.tsx";
import { LoadingScreen } from "./ui/loading/LoadingScreen.tsx";
import { useEngineSession } from "./ui/loading/useEngineSession.ts";

// Dev-only demo scenes: loaded on demand and only reachable in the dev channel (see dev/params.ts).
const DemoStartup = lazy(() => import("./dev/demos.tsx").then((m) => ({ default: m.DemoStartup })));
const DemoPanel = lazy(() => import("./dev/demos.tsx").then((m) => ({ default: m.DemoPanel })));
const DemoGallery = lazy(() => import("./dev/demos.tsx").then((m) => ({ default: m.DemoGallery })));
const DemoCrash = lazy(() => import("./dev/demos.tsx").then((m) => ({ default: m.DemoCrash })));

function Shell() {
  const { t } = useI18n();
  const confirm = useConfirm();
  const { demo } = devParams();
  const startupDemo = demo?.startsWith("start") ? demo : undefined;
  const panelDemo = demo?.startsWith("panel-") ? demo : undefined;

  // Without a demo parameter the real engine starts. Demo scenes (dev channel only) replace it with a made-up sequence.
  const real = demo === undefined;
  const engine = useEngineSession(real);
  const [startupDone, setStartupDone] = useState(!real && startupDemo === undefined);
  // Once the welcome screen was dealt with the address says so (screen=main), so a reload goes straight to the main window.
  const [welcomeOpen, setWelcomeOpen] = useState(() =>
    demo === "welcome" ? true : panelDemo === undefined && demo !== "crash" && !isWelcomeHidden() && readUrlState().screen !== "main",
  );
  const closeWelcome = () => {
    setWelcomeOpen(false);
    patchUrl({ screen: "main" });
  };
  const [dontShowAgain, setDontShowAgain] = useState(() => isWelcomeHidden());

  const notAvailable = (messageKey: "app.notAvailableOpen" | "app.notAvailableTour") => {
    void confirm({ title: t("app.notAvailableTitle"), message: t(messageKey), confirmLabel: t("common.ok"), hideCancel: true });
  };

  if (demo === "gallery") {
    return (
      <Suspense fallback={null}>
        <DemoGallery />
      </Suspense>
    );
  }

  const view = engine ? selectEngineView(engine.status.phase, startupDone) : "none";
  const onEngineAction = (id: string) => {
    if (id === "retry") void engine?.session.retry();
  };

  return (
    <div className="h-full bg-bg text-fg">
      <MainWindow
        session={engine?.session ?? null}
        engineReady={engine?.status.phase === "ready"}
        arrived={startupDone}
        overlay={
          <>
            <Suspense fallback={null}>
              {panelDemo ? <DemoPanel name={panelDemo} /> : null}
              {demo === "crash" ? <DemoCrash /> : null}
            </Suspense>
            {engine && view === "panel" ? (
              <LoadingPanel progress={engineStatusToProgress(engine.status, t, "running")} onAction={onEngineAction} />
            ) : null}
          </>
        }
      />

      {engine && view === "screen" ? (
        <LoadingScreen
          progress={engineStatusToProgress(engine.status, t, "start")}
          onAction={onEngineAction}
          onHandoverDone={() => setStartupDone(true)}
        />
      ) : null}

      {startupDemo && !startupDone ? (
        <Suspense fallback={null}>
          <DemoStartup name={startupDemo} onDone={() => setStartupDone(true)} />
        </Suspense>
      ) : null}

      <Welcome
        open={welcomeOpen && startupDone}
        onClose={closeWelcome}
        onNewProject={() => {
          // The main window is already there behind the welcome screen; "new" makes sure it holds an empty document.
          startNewDocument(getMainModel(engine?.session ?? null));
          closeWelcome();
        }}
        onOpenProject={() => notAvailable("app.notAvailableOpen")}
        onTour={() => notAvailable("app.notAvailableTour")}
        onShowLicence={() => aboutStore.open({ tab: "licenses", item: LICENCE_ITEM })}
        dontShowAgain={dontShowAgain}
        onDontShowAgainChange={(value) => {
          setDontShowAgain(value);
          setWelcomeHidden(value);
        }}
      />

      {/* One view for the whole window, over the main window and over the welcome screen; its state is in the address. */}
      <AboutDialog ready={startupDone} />
    </div>
  );
}

export function App() {
  return (
    <MotionConfig reducedMotion="user">
      <ConfirmProvider>
        <Shell />
      </ConfirmProvider>
    </MotionConfig>
  );
}
