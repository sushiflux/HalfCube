// Entry point of the shared UI. Desktop (Electron, preload bridge present) uses the native engine; the browser
// page uses the WebAssembly engine in a Web Worker. Query parameters (spike diagnostics only):
//   renderer=auto|webgl|nogpu   viewport backend (auto: WebGPU with fallback; webgl: forced; nogpu: WebGPU hidden)
//   engine=native|wasm          override the engine (wasm also works inside Electron)
import { createRoot } from "react-dom/client";
import p1a from "../../recipes/p1a.json";
import type { Recipe } from "../../protocol/protocol.ts";
import { App } from "./App.tsx";
import { installAutotest } from "./autotest.ts";
import { EngineSession, type EngineKind } from "./engine-session.ts";
import { NoticeStore, errorText } from "./notices.ts";
import { RecipeStore } from "./recipe-store.ts";
import type { RendererMode } from "./viewport.ts";
import "./styles.css";

const params = new URLSearchParams(location.search);
const rendererParam = params.get("renderer");
const rendererMode: RendererMode = rendererParam === "webgl" || rendererParam === "nogpu" ? rendererParam : "auto";
const engineParam = params.get("engine");
const engineKind: EngineKind =
  engineParam === "wasm" || engineParam === "native" ? engineParam : window.halfCubeDesktop ? "native" : "wasm";

const notices = new NoticeStore();
const store = new RecipeStore(p1a as Recipe);
const session = new EngineSession(store, notices, engineKind);

// The UI must survive anything the engine or the view does; uncaught errors go to the notice panel.
window.addEventListener("error", (e) => notices.push("error", "Unerwarteter Fehler in der Oberfläche", errorText(e.error ?? e.message)));
window.addEventListener("unhandledrejection", (e) => notices.push("error", "Unerwarteter Fehler in der Oberfläche", errorText(e.reason)));

installAutotest({ store, session, notices, rendererMode });
createRoot(document.getElementById("root")!).render(
  <App store={store} session={session} notices={notices} rendererMode={rendererMode} />,
);
void session.start();
