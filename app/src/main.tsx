import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";
import { ErrorBoundary } from "./screens/crash/ErrorBoundary.tsx";
// Choosing the theme and the language has to happen before the first render (it sets the attributes on <html>).
import "./i18n/runtime.ts";
import "./theme/runtime.ts";

const container = document.getElementById("root");
if (!container) throw new Error("The page has no #root element.");

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
