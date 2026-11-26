// Electron main process: one window with the shared UI.
//
// Security baseline: context isolation on, Node integration off, sandboxed renderer, a preload script that exposes
// static facts only, strict CSP, no remote content (built bundles come from the app:// scheme inside the build folder;
// the optional dev server is only accepted on 127.0.0.1), navigation and new windows blocked, every permission
// request denied except writing to the clipboard (copy buttons), one instance per user data folder. Links to outside
// addresses are the one thing that leaves the window: the page asks over IPC and the main process opens plain https
// addresses in the system browser (external-ipc.ts).
//
// Environment (all optional):
//   PARTCRAFT_DEV_URL    load the UI from the Vite dev server instead, e.g. http://127.0.0.1:5313/ (unpackaged only)
//   PARTCRAFT_WINDOW     "inactive": show the window without taking the focus; it can never be activated (tests).
//                        "minimized": show it minimized, without taking the focus and with a taskbar button; it cannot be
//                        activated until the user restores it, then it is a normal window. Unset: a normal window that is
//                        shown and focused.
//   PARTCRAFT_WINDOW_DISPLAY  "secondary": open the window on the secondary display (landscape first, then the largest;
//                        the primary one when there is only one display); "primary": on the primary display. Applied
//                        before the window is shown, so it never appears elsewhere first. Unset: the system decides.
//   PARTCRAFT_USER_DATA  folder for the settings and caches of this run (default: Electron's per-user folder)
//   PARTCRAFT_ENGINE_EXE path of another engine program (unpackaged only; default: see engine-path.ts)
//   PARTCRAFT_SETUP_CHOICES_FILE  another first-start file than the one in the roaming Partcraft folder (unpackaged only)
import { app, BrowserWindow, protocol, screen, session } from "electron";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { responseHeaders } from "../../config/security.ts";
import { branding } from "../../app/src/branding.ts";
import { currentVersion } from "../../app/src/version.ts";
import { chooseDisplay, parseDisplayTarget, sameRect, windowRectOn, type DisplayInfo, type DisplayTarget, type Rect } from "./display-choice.ts";
import { installEngineIpc } from "./engine-ipc.ts";
import { installExternalIpc } from "./external-ipc.ts";
import { resolveEngineExecutable, sessionDataDir, setupChoicesPath } from "./engine-path.ts";
import { showMinimizedNoActivate } from "./native-window.ts";
import { readSetupChoices } from "./setup-choices-file.ts";

const log = (line: string) => process.stderr.write(`[main] ${line}\n`);

const buildDir = __dirname; // _build/desktop
const webDir = resolve(buildDir, "../web");
const iconFile = join(buildDir, "icon.png");
const appHost = branding.slug;
const appOrigin = `app://${appHost}`;
const windowTitle = `${branding.name} ${currentVersion().display}`;

type WindowMode = "normal" | "inactive" | "minimized";

function readWindowMode(raw: string | undefined): WindowMode {
  if (raw === undefined || raw === "") return "normal";
  if (raw === "inactive" || raw === "minimized") return raw;
  log(`PARTCRAFT_WINDOW must be "inactive" or "minimized", got "${raw}".`);
  app.exit(1);
  return "normal";
}

function readDevUrl(raw: string | undefined): string | undefined {
  if (!raw || app.isPackaged) return undefined;
  if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(raw)) {
    log(`PARTCRAFT_DEV_URL must look like http://127.0.0.1:<port>/, got "${raw}".`);
    app.exit(1);
    return undefined;
  }
  return raw;
}

function readWindowDisplay(raw: string | undefined): DisplayTarget | undefined {
  const target = parseDisplayTarget(raw);
  if (target !== null) return target;
  log(`PARTCRAFT_WINDOW_DISPLAY must be "primary" or "secondary", got "${raw}".`);
  app.exit(1);
  return undefined;
}

const windowMode = readWindowMode(process.env.PARTCRAFT_WINDOW);
const windowDisplay = readWindowDisplay(process.env.PARTCRAFT_WINDOW_DISPLAY);
const devUrl = readDevUrl(process.env.PARTCRAFT_DEV_URL);

// The lock belongs to the user data folder, so set the folder first.
app.setName(branding.name);
if (process.env.PARTCRAFT_USER_DATA) app.setPath("userData", resolve(process.env.PARTCRAFT_USER_DATA));
// Chromium caches go to the local Partcraft folder (see sessionDataDir), not to the roaming profile.
const sessionDir = sessionDataDir({ packaged: app.isPackaged, platform: process.platform, env: process.env, productName: branding.name });
if (sessionDir) app.setPath("sessionData", sessionDir);

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

app.enableSandbox();

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Serves files of the web build over app://; nothing outside that folder. */
async function serveApp(request: Request): Promise<Response> {
  const notFound = () => new Response("Not found", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const url = new URL(request.url);
  if (url.host !== appHost) return notFound();
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  } catch {
    return notFound();
  }
  const file = normalize(join(webDir, rel));
  const inside = relative(webDir, file);
  if (inside === "" || inside.startsWith("..") || inside.includes(`..${sep}`)) return notFound();
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) return notFound();
  const headers = new Headers({
    "Content-Type": mimeTypes[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": "no-store",
    ...responseHeaders,
  });
  return new Response(request.method === "HEAD" ? null : await readFile(file), { status: 200, headers });
}

function isOwnUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (devUrl) return u.origin === new URL(devUrl).origin;
    // URL.origin is "null" for non-special schemes such as app:, so compare scheme and host.
    return u.protocol === "app:" && u.host === appHost;
  } catch {
    return false;
  }
}

const defaultSize = { width: 1440, height: 900 };

/** The display and the rectangle for the window when PARTCRAFT_WINDOW_DISPLAY is set (needs the app to be ready). */
function planPlacement(): { display: DisplayInfo; rect: Rect } | undefined {
  if (!windowDisplay) return undefined;
  const display = chooseDisplay(screen.getAllDisplays(), screen.getPrimaryDisplay().id, windowDisplay);
  return display ? { display, rect: windowRectOn(display, defaultSize) } : undefined;
}

// Mixed scale factors make Windows convert size and position of a window created on another display with the wrong
// factor, so the rectangle is applied again to the hidden window until the real bounds match, and the result is logged.
function placeOnDisplay(win: BrowserWindow, plan: { display: DisplayInfo; rect: Rect }): void {
  let bounds = win.getBounds();
  for (let attempt = 0; attempt < 3 && !sameRect(bounds, plan.rect); attempt++) {
    win.setBounds(plan.rect);
    bounds = win.getBounds();
  }
  const actual = screen.getDisplayMatching(bounds);
  log(`Fenster auf Monitor ${actual.id} platziert: ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height} (Ziel: Monitor ${plan.display.id}, ${plan.rect.x},${plan.rect.y} ${plan.rect.width}x${plan.rect.height}, Skalierung ${plan.display.scaleFactor})`);
  if (actual.id !== plan.display.id || !sameRect(bounds, plan.rect)) log(`WARNUNG: Das Fenster liegt nicht wie geplant auf Monitor ${plan.display.id}.`);
}

function createWindow(): BrowserWindow {
  const background = windowMode !== "normal";
  const plan = planPlacement();
  const win = new BrowserWindow({
    ...defaultSize,
    ...plan?.rect,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#ffffff",
    title: windowTitle,
    show: false,
    // A background window (tests, dev restart) must never become the foreground window, whatever asks for it. On Windows
    // `focusable: false` creates it with WS_EX_NOACTIVATE (clicks and the system's own "activate the next window" skip it)
    // and makes Chromium refuse every activation of its own (show(), focus(), restore paths, a page asking for focus).
    // The extended style alone would not do: SetForegroundWindow still activates a WS_EX_NOACTIVATE window.
    // Set it here, never later with setFocusable(false): that also blurs the window, and Chromium's blur hands the
    // foreground to the next visible window.
    focusable: !background,
    icon: existsSync(iconFile) ? iconFile : undefined,
    webPreferences: {
      // A window in the background (tests, dev restart) must keep rendering.
      backgroundThrottling: !background,
      preload: join(buildDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  if (plan) placeOnDisplay(win, plan);
  win.removeMenu();
  // The window title is "<name> <version>"; the page title must not replace it.
  win.on("page-title-updated", (event) => event.preventDefault());
  if (background) {
    // Diagnostics for background starts: any activation or restore of the window shows up in the log. With focusable
    // false a "focus" line before the user restored the window means Chromium activated it after all (a regression);
    // the foreground itself is measured with scripts/foreground-watch.ps1.
    const note = (name: string) => () => log(`window event ${name} at ${new Date().toISOString()}`);
    win.on("focus", note("focus"));
    win.on("restore", note("restore"));
    win.on("show", note("show"));
  }
  win.once("ready-to-show", () => {
    if (windowMode === "inactive") win.showInactive();
    else if (windowMode === "minimized") {
      // Never minimize(): it activates the next window in the Z order (see native-window.ts). If the helper
      // fails, the window stays hidden rather than taking the focus.
      void showMinimizedNoActivate(win, log).then((ok) => {
        log(ok ? `window shown minimized without activation at ${new Date().toISOString()}` : "Could not show the window minimized without activating it; it stays hidden.");
        if (!ok || win.isDestroyed()) return;
        // A window that cannot be activated gets no taskbar button by itself; the user needs one to bring it up.
        win.setSkipTaskbar(false);
        if (plan) {
          const normal = win.getNormalBounds();
          log(`Wiederherstellungsposition: Monitor ${screen.getDisplayMatching(normal).id}, ${normal.x},${normal.y} ${normal.width}x${normal.height}`);
        }
      });
      // Only the user restores a minimized background window (taskbar, Alt+Tab, a normal second start): from then on it
      // is a normal window that can be activated, and it takes the activation the user asked for.
      win.once("restore", () => {
        win.setFocusable(true);
        win.focus();
        log("Fenster vom Benutzer wiederhergestellt: ab jetzt ein normales Fenster.");
      });
    } else win.show();
  });
  void win.loadURL(devUrl ?? `${appOrigin}/index.html`);
  return win;
}

// Every web contents, also ones created later: no navigation away, no new windows, no webviews.
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (!isOwnUrl(url)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!isOwnUrl(url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

let mainWindow: BrowserWindow | undefined;

if (!app.requestSingleInstanceLock({ background: windowMode !== "normal" })) {
  log("Another instance is already running; this one exits.");
  app.quit();
} else {
  app.on("second-instance", (_event, _argv, _cwd, additionalData) => {
    // A second start brings the running window forward, unless it was started in the background.
    const background = (additionalData as { background?: boolean } | undefined)?.background === true;
    if (background || !mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    protocol.handle("app", serveApp);

    // The only permission the page may use is writing to the clipboard (copy buttons); everything else is denied.
    const allowed = (permission: string) => permission === "clipboard-sanitized-write";
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed(permission)));
    session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed(permission));

    // No network access from the page except the own origin (and the dev server in dev).
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const ok =
        details.url.startsWith(`${appOrigin}/`) ||
        details.url.startsWith("blob:") ||
        details.url.startsWith("data:") ||
        (!app.isPackaged && details.url.startsWith("devtools://")) ||
        (!!devUrl && (details.url.startsWith(devUrl) || details.url.startsWith(devUrl.replace(/^http/, "ws"))));
      callback({ cancel: !ok });
    });

    log(`electron ${process.versions.electron}, chrome ${process.versions.chrome}, node ${process.versions.node}`);
    log(`window mode: ${windowMode}${windowDisplay ? `; display: ${windowDisplay}` : ""}; source: ${devUrl ?? appOrigin}`);

    // The native engine: the page asks for it through the preload bridge, the host starts it and hands over a port.
    const engines = installEngineIpc({
      locate: () =>
        resolveEngineExecutable({
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          repoRoot: resolve(buildDir, "../.."),
          platform: process.platform,
          env: process.env,
          exists: existsSync,
        }),
      isTrustedFrame: (frame) => frame !== null && frame.parent === null && isOwnUrl(frame.url),
      setupChoices: readSetupChoices(
        setupChoicesPath({ appData: app.getPath("appData"), productName: branding.name, packaged: app.isPackaged, env: process.env }),
        log,
      ),
      log: (line) => log(line),
    });
    app.on("before-quit", () => engines.killAll());

    // Links to outside addresses open in the system browser, never inside the window; the Chromium licence file sits next
    // to the Electron executable.
    installExternalIpc({
      isTrustedFrame: (frame) => frame !== null && frame.parent === null && isOwnUrl(frame.url),
      chromiumLicencesFile: join(dirname(process.execPath), "LICENSES.chromium.html"),
      log,
    });

    mainWindow = createWindow();
  });

  app.on("window-all-closed", () => app.quit());
}
