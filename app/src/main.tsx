import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { devParams } from "./dev/params.ts";
import "./index.css";
import { ErrorBoundary } from "./screens/crash/ErrorBoundary.tsx";
// Choosing the theme and the language has to happen before the first render (it sets the attributes on <html>).
import "./i18n/runtime.ts";
import "./theme/runtime.ts";

// Dev-only: the 3D view demo (?demo=viewport) is a page of its own, outside the app shell. devParams() is empty in every
// channel except dev, so no other build ever loads this code.
const DemoViewport = lazy(() => import("./dev/viewport-demo.tsx").then((m) => ({ default: m.DemoViewport })));

const container = document.getElementById("root");
if (!container) throw new Error("The page has no #root element.");

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      {devParams().demo === "viewport" ? (
        <Suspense fallback={null}>
          <DemoViewport />
        </Suspense>
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </StrictMode>,
);
