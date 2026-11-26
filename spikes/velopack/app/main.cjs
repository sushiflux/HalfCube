"use strict";
// Test application for the Velopack installer and update test. It has no product code.
//
// It writes what it sees (version, install location, update check result) to a log file in its user-data folder and
// exits on its own. By default it creates no window.
//
// Arguments (all optional):
//   --feed=<dir|url>     update source for the update check (a local folder or an http(s) address)
//   --action=info|check|update
//                        info   (default) log the facts and exit
//                        check  also look for an update
//                        update also download and apply it, then restart into the new version (the restarted
//                               process gets the same arguments, finds no further update and exits)
//   --window=inactive    show a small window with the logo for two seconds, never focused (test runs only)
//   --timeout=<seconds>  safety exit (default 120)

// Velopack has to be the first thing that runs: during install, update and uninstall it starts this executable with
// a hook argument and expects it to exit quickly. Code placed before run() would run again for every hook.
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { VelopackApp, UpdateManager } = require("velopack");

const userDataDir = app.getPath("userData");
const logDir = path.join(userDataDir, "logs");
const logFile = path.join(logDir, "test.log");
const appVersion = app.getVersion();

// Synchronous so that hook callbacks are logged before the process exits.
function log(message) {
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(logFile, `${new Date().toISOString()} pid=${process.pid} app=${appVersion} ${message}\n`);
}

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

const feed = argValue("feed");
const action = argValue("action") ?? "info";
const windowMode = argValue("window");
const timeoutSeconds = Number(argValue("timeout") ?? "120");
const state = { firstRun: false, restarted: false };

VelopackApp.build()
  .onAfterInstallFastCallback((v) => log(`hook after-install ${v}`))
  .onBeforeUpdateFastCallback((v) => log(`hook before-update ${v}`))
  .onAfterUpdateFastCallback((v) => log(`hook after-update ${v}`))
  .onBeforeUninstallFastCallback((v) => log(`hook before-uninstall ${v}`))
  .onFirstRun((v) => {
    state.firstRun = true;
    log(`hook first-run ${v}`);
  })
  .onRestarted((v) => {
    state.restarted = true;
    log(`hook restarted ${v}`);
  })
  .setLogger((level, msg) => log(`velopack ${level}: ${msg}`))
  .run();

// The user-data file the test checks after an update and after an uninstall.
function touchUserData() {
  const dir = path.join(userDataDir, "userdata");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "user-file.txt");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `created by ${appVersion} at ${new Date().toISOString()}\n`);
    log(`user-data file created: ${file}`);
  } else {
    log(`user-data file exists: ${file}`);
  }
  fs.appendFileSync(file, `seen by ${appVersion} at ${new Date().toISOString()}\n`);
}

function describeAsset(a) {
  return `${a.Type} ${a.Version} ${a.FileName} ${a.Size} bytes`;
}

async function runAction() {
  log(`start args=${JSON.stringify(process.argv.slice(1))} exe=${process.execPath}`);
  log(`electron=${process.versions.electron} chrome=${process.versions.chrome} node=${process.versions.node} firstRun=${state.firstRun} restarted=${state.restarted}`);
  log(`userData=${userDataDir}`);
  touchUserData();

  let manager;
  try {
    manager = feed ? new UpdateManager(feed) : new UpdateManager();
    log(`velopack appId=${manager.getAppId()} version=${manager.getCurrentVersion()} portable=${manager.isPortable()}`);
    const pending = manager.getUpdatePendingRestart();
    log(`velopack updatePendingRestart=${pending ? describeAsset(pending) : "none"}`);
  } catch (e) {
    log(`velopack not installed or not usable: ${e}`);
    return 0;
  }
  if (action === "info") return 0;
  if (!feed) {
    log("no --feed given, cannot check for updates");
    return 3;
  }

  const info = await manager.checkForUpdatesAsync();
  if (!info) {
    log("update check: no update available");
    return 0;
  }
  log(`update check: target ${describeAsset(info.TargetFullRelease)} downgrade=${info.IsDowngrade}`);
  log(`update check: base ${info.BaseRelease ? describeAsset(info.BaseRelease) : "none"}`);
  log(`update check: ${info.DeltasToTarget.length} delta package(s): ${info.DeltasToTarget.map(describeAsset).join(" | ")}`);
  if (action === "check") return 0;

  let lastPercent = -1;
  await manager.downloadUpdateAsync(info, (p) => {
    if (p === 100 || p - lastPercent >= 25) {
      lastPercent = p;
      log(`download progress ${p}%`);
    }
  });
  log("download finished, applying (updater waits for this process to exit, then restarts the app)");
  // Silent: no dialogs. Restart: the new version is started again with the same arguments.
  manager.waitExitThenApplyUpdate(info, true, true, process.argv.slice(1).filter((a) => a.startsWith("--")));
  return 0;
}

function showLogoWindow() {
  return new Promise((resolve) => {
    // Never focusable and shown inactive, so it cannot take the focus from the user.
    const win = new BrowserWindow({
      width: 320,
      height: 320,
      show: false,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      icon: path.join(__dirname, "assets", "halfcube-icon-512.png"),
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.loadFile(path.join(__dirname, "window.html")).then(() => {
      win.showInactive();
      log(`window shown inactive, focused=${win.isFocused()}`);
      setTimeout(() => {
        log(`window closing, focused=${win.isFocused()}`);
        win.destroy();
        resolve();
      }, 2000);
    });
  });
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const failsafe = setTimeout(() => {
    log(`timeout after ${timeoutSeconds} s, exiting with code 2`);
    app.exit(2);
  }, timeoutSeconds * 1000);
  let code = 1;
  try {
    code = await runAction();
    if (windowMode === "inactive") await showLogoWindow();
  } catch (e) {
    log(`error: ${e && e.stack ? e.stack : e}`);
  }
  clearTimeout(failsafe);
  log(`exit code ${code}`);
  app.exit(code);
});
