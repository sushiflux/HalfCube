// Electron main process of the architecture spike: one window with the shared UI, one native engine per window.
//
// Security baseline: context isolation on, Node integration off, sandboxed renderer, a preload that exposes one
// function, no remote content (the UI comes from the app:// scheme inside the build folder; the optional dev
// server is only accepted on 127.0.0.1), navigation and new windows blocked, permissions denied except writing
// to the clipboard (Copy buttons of the error panel).
//
// Environment (all optional):
//   HC_ENGINE_EXE        path of halfcube-engine.exe (default: ../engine-win/ next to this build)
//   HC_SPIKE_DEV_URL     load the UI from the Vite dev server instead, e.g. http://127.0.0.1:5310/
//   HC_SPIKE_QUERY       query string appended to the UI address, e.g. renderer=webgl
//   HC_SPIKE_NO_DEBUG=1  start the engine without its test commands (the crash buttons then report an error)
//   HC_SPIKE_TEST_WINDOW test runs only: "hidden" never shows the window, "inactive" shows it without taking the
//                        focus (showInactive); both keep the page rendering in the background (no throttling)
import { app, BrowserWindow, ipcMain, protocol, session, type WebContents } from "electron";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { EngineHost } from "./engine-host.ts";

const buildDir = __dirname; // _build/app-desktop
const webDir = resolve(buildDir, "../app-web");
const engineExe = process.env.HC_ENGINE_EXE ?? resolve(buildDir, "../engine-win/halfcube-engine.exe");
const devUrl = process.env.HC_SPIKE_DEV_URL;
const query = process.env.HC_SPIKE_QUERY ?? "";
const debugCommands = process.env.HC_SPIKE_NO_DEBUG !== "1";
const testWindow = process.env.HC_SPIKE_TEST_WINDOW; // undefined: a normal window that is shown and focused
// The project's logo (assets/ in the spike folder), used as the window icon.
const iconFile = resolve(buildDir, "../../assets/halfcube-icon-512.png");

const APP_ORIGIN = "app://halfcube";
const log = (line: string) => process.stderr.write(`[halfcube-main] ${line}\n`);

if (devUrl && !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(devUrl)) {
  log(`HC_SPIKE_DEV_URL must be http://127.0.0.1:<port>/, got ${devUrl}`);
  app.exit(1);
}

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "worker-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** Serves files of the web build; nothing outside it. */
async function serveApp(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.host !== "halfcube") return new Response("Not found", { status: 404 });
  const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const file = normalize(join(webDir, rel));
  const inside = relative(webDir, file);
  if (inside.startsWith("..") || inside.includes(`..${sep}`) || !existsSync(file)) {
    return new Response("Not found", { status: 404 });
  }
  const headers = new Headers({
    "Content-Type": mimeTypes[extname(file)] ?? "application/octet-stream",
    "Content-Security-Policy": contentSecurityPolicy,
    // Same isolation as the browser page, so the WebAssembly engine could run here too (?engine=wasm).
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-store",
  });
  return new Response(await readFile(file), { status: 200, headers });
}

const hosts = new Map<number, EngineHost>();

function hostFor(wc: WebContents): EngineHost {
  let h = hosts.get(wc.id);
  if (!h) {
    h = new EngineHost({ exe: engineExe, debugCommands, log });
    hosts.set(wc.id, h);
    wc.once("destroyed", () => {
      void h!.stop(0);
      hosts.delete(wc.id);
    });
  }
  return h;
}

function isOwnUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (devUrl) return u.origin === new URL(devUrl).origin;
    // URL.origin is "null" for non-special schemes such as app:, so compare scheme and host.
    return u.protocol === "app:" && u.host === "halfcube";
  } catch {
    return false;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: "#f5f7f9",
    title: "HalfCube – Architektur-Spike",
    show: false,
    icon: existsSync(iconFile) ? iconFile : undefined,
    webPreferences: {
      backgroundThrottling: !testWindow,
      preload: join(buildDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  win.removeMenu();
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (e, url) => {
    if (!isOwnUrl(url)) e.preventDefault();
  });
  wc.on("will-attach-webview", (e) => e.preventDefault());
  win.once("ready-to-show", () => {
    if (testWindow === "hidden") return;
    if (testWindow === "inactive") win.showInactive();
    else win.show();
  });
  const base = devUrl ?? `${APP_ORIGIN}/index.html`;
  void win.loadURL(query ? `${base}${base.includes("?") ? "&" : "?"}${query}` : base);
}

app.whenReady().then(() => {
  protocol.handle("app", serveApp);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "clipboard-sanitized-write");
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === "clipboard-sanitized-write");
  // No network access from the renderer except the own origin.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const ok =
      details.url.startsWith(`${APP_ORIGIN}/`) ||
      details.url.startsWith("devtools://") ||
      details.url.startsWith("blob:") ||
      details.url.startsWith("data:") ||
      (!!devUrl && (details.url.startsWith(devUrl) || details.url.startsWith(devUrl.replace(/^http/, "ws"))));
    callback({ cancel: !ok });
  });

  ipcMain.handle("halfcube:start-engine", (event) => {
    if (!isOwnUrl(event.senderFrame?.url ?? "")) {
      return { ok: false, message: "Refused: the request did not come from the HalfCube window." };
    }
    if (!existsSync(engineExe)) {
      return {
        ok: false,
        message: `The native engine was not found at ${engineExe}. Build it with engine\\scripts\\build-windows.ps1.`,
      };
    }
    return hostFor(event.sender).start(event.sender);
  });

  log(`electron ${process.versions.electron}, chrome ${process.versions.chrome}, node ${process.versions.node}`);
  createWindow();
});

let quitting = false;
app.on("before-quit", (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  void Promise.all([...hosts.values()].map((h) => h.stop())).finally(() => app.quit());
});

app.on("window-all-closed", () => app.quit());
