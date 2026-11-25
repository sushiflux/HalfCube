import { MotionConfig } from "motion/react";
import { lazy, Suspense, useState } from "react";
import { devParams } from "./dev/params.ts";
import { useI18n } from "./i18n/runtime.ts";
import { detectPlatform } from "./platform.ts";
import { isWelcomeHidden, setWelcomeHidden } from "./screens/welcome/preference.ts";
import { Welcome } from "./screens/welcome/Welcome.tsx";
import { Logo, Wordmark } from "./ui/Brand.tsx";
import { ConfirmProvider, useConfirm } from "./ui/Confirm.tsx";
import { cx } from "./ui/cx.ts";
import { engineStatusToProgress, selectEngineView } from "./ui/loading/engine.ts";
import { LoadingPanel } from "./ui/loading/LoadingPanel.tsx";
import { LoadingScreen } from "./ui/loading/LoadingScreen.tsx";
import { useEngineSession } from "./ui/loading/useEngineSession.ts";
import { currentVersion } from "./version.ts";

// Dev-only demo scenes: loaded on demand and only reachable in the dev channel (see dev/params.ts).
const DemoStartup = lazy(() => import("./dev/demos.tsx").then((m) => ({ default: m.DemoStartup })));
const DemoPanel = lazy(() => import("./dev/demos.tsx").then((m) => ({ default: m.DemoPanel })));
const DemoGallery = lazy(() => import("./dev/demos.tsx").then((m) => ({ default: m.DemoGallery })));
const DemoCrash = lazy(() => import("./dev/demos.tsx").then((m) => ({ default: m.DemoCrash })));

/** Placeholder header until the main window exists: logo and wordmark top left. */
function AppHeader({ arrived }: { arrived: boolean }) {
  return (
    <header className="flex h-10 flex-none items-center gap-2.5 border-b border-line bg-surface px-2.5">
      {/* The logo of the loading screen flies to this spot and is shown once it has arrived. */}
      <Logo size={24} source="small" data-handover-target="" className={cx(!arrived && "opacity-0")} />
      <Wordmark size={18} className={cx("transition-opacity duration-300", !arrived && "opacity-0")} />
    </header>
  );
}

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
  const [welcomeOpen, setWelcomeOpen] = useState(() => (demo === "welcome" ? true : panelDemo === undefined && demo !== "crash" && !isWelcomeHidden()));
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

  const version = currentVersion();
  const platform = detectPlatform();

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <AppHeader arrived={startupDone} />
      <main className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4">
        <p className="text-base text-fg">{t("app.status")}</p>
        <p className="text-sm text-muted">{t("app.workAreaPlaceholder")}</p>
        <p className="mono text-sm text-muted" data-testid="version">
          {t("app.versionLabel")} {version.display}
        </p>
        <p className="text-xs text-muted" data-testid="platform" data-platform={platform}>
          {platform === "desktop" ? t("app.platformDesktop") : t("app.platformBrowser")}
        </p>
        <Suspense fallback={null}>
          {panelDemo ? <DemoPanel name={panelDemo} /> : null}
          {demo === "crash" ? <DemoCrash /> : null}
        </Suspense>
        {engine && view === "panel" ? (
          <LoadingPanel progress={engineStatusToProgress(engine.status, t, "running")} onAction={onEngineAction} />
        ) : null}
      </main>

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
        onClose={() => setWelcomeOpen(false)}
        onNewProject={() => setWelcomeOpen(false)}
        onOpenProject={() => notAvailable("app.notAvailableOpen")}
        onTour={() => notAvailable("app.notAvailableTour")}
        dontShowAgain={dontShowAgain}
        onDontShowAgainChange={(value) => {
          setDontShowAgain(value);
          setWelcomeHidden(value);
        }}
      />
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
