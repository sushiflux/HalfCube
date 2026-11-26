# Velopack test with Electron

Throwaway spike for phase 0. It checks that [Velopack](https://velopack.io) (MIT) packs, installs, updates and
uninstalls an Electron application cleanly on Windows, without admin rights and without any window in front of the
user. The test app (`HalfCubeVelopackTest`) has no product code: it logs what it sees (its version, install location,
update check result) to a file in its user-data folder and exits on its own. It creates no window unless
`--window=inactive` is given (then a never-focusable window with the logo is shown for two seconds).

## Layout

| Path | What |
|---|---|
| `app/main.cjs`, `app/window.html`, `app/package.json` | The test app. `VelopackApp.build()...run()` is the first statement; arguments `--feed=<folder or url>`, `--action=info\|check\|update`, `--window=inactive` |
| `scripts/build.mjs` | Stages the app with a version, packages Electron with `@electron/packager`, runs `vpk pack` |
| `scripts/run-test.ps1` | The whole test: pack 1.0.0, silent install, update to 1.0.1 from a local feed, user-data check, silent uninstall, clean up |
| `scripts/lib.ps1`, `scripts/watch-windows.ps1` | Helpers that run a program hidden and record every window it opens |
| `scripts/serve.mjs` | Static file server on 127.0.0.1 for the update feed (`-Feed http`) |
| `scripts/make-icon.ps1` | Builds `assets/halfcube.ico` from the logo (scaled only) |
| `_build/` | Tools, staged sources, packages, feeds and evidence (git-ignored) |

## Run it

Needs Node 24 or newer, the .NET SDK (for `vpk`, installed into `_build/tools-<version>`, never globally) and Windows.
No admin rights. Nothing is published anywhere.

```powershell
npm install
node node_modules/electron/install.js        # downloads the Electron binary if npm did not

# folder feed, the pinned stable version
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-test.ps1

# local HTTP feed on a free 127.0.0.1 port, plus the inactive-window check and two read-only GitHub checks
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-test.ps1 -Feed http -WindowCheck -GithubCheck

# the newest pre-release of Velopack (npm package and vpk of the same version)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-test.ps1 -VelopackVersion 1.3.39-g8d2844f
```

The script refuses to run when the test app is already installed, uninstalls it again at the end (also after a
failure), and removes its user-data folder unless `-KeepUserData` is given. Evidence (transcript, installer log,
test log, Velopack log, result table) is written to `_build/run-<version>-<feed>/evidence/`.

## Versions used

| Part | Version | Licence |
|---|---|---|
| Velopack (npm `velopack`, `vpk`, Setup.exe, Update.exe) | 1.2.161 (stable), also 1.3.39-g8d2844f (pre-release) | MIT |
| `@electron/packager` | 20.3.0 | BSD-2-Clause |
| Electron | 45.4.1 | MIT |
| `@neon-rs/load` (dependency of `velopack`) | 0.2.6 | MIT |

The Velopack npm package declares `node >=20 <26`; npm prints an engine warning under Node 26 and installs anyway.
The packaged app runs on Electron's own Node, so the warning does not matter for the product.
