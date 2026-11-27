# HalfCube installer

The Windows installer of HalfCube: one file, `HalfCube-Setup-<version>-<channel>.exe`.

- `setup/` is the designed setup window (.NET 11 WinForms, owner-drawn, light and dark, German and English). It carries
  Velopack's own `Setup.exe` (the output of `vpk pack`) as an appended ZIP and runs it silently underneath, per user and
  without administrator rights. Progress is measured as the fill level of the target folder against the known installed size.
  On finish it writes `%APPDATA%\HalfCube\setup-choices.json` (`{ "version": 1, "language", "colorMode" }`) for the program's
  first start. The same file is the uninstaller (`--uninstall`, offered on the first page when HalfCube is already
  installed); it runs Velopack's `Update.exe --uninstall --silent`. That removes `%LOCALAPPDATA%\HalfCube` with the
  program and, inside it, the program's settings: they are kept for now in Chromium's storage under
  `%LOCALAPPDATA%\HalfCube\session` (an interim store; SQLite is planned). What stays is `%APPDATA%\HalfCube` with
  the setup's `setup-choices.json`.
- `app/` holds `entry.cjs`, the entry point of the packaged program: Velopack's hooks first, then the built main process.
  `package.json` and the lock file pin the `velopack` npm package to the version of `vpk` (1.2.161).
- Fonts: Geist and Geist Mono (SIL Open Font License 1.1, `setup/Resources/fonts/OFL.txt`), registered for the setup's
  own process only.

Build it with `scripts/build-installer.ps1` (local build into `_build/installer/`). `vpk` is a local .NET tool from
`.config/dotnet-tools.json`: run `dotnet tool restore` once, nothing is installed globally.

Setup options for tests: `--headless` (no window), `--install-dir`, `--appdata`, `--lang de|en`, `--light`/`--dark`,
`--uninstall`, `--test-layout <folder>` (renders every page offscreen to PNG and checks the layout) and
`--selftest-gui <folder>` (drives the real window code through a real install or removal without showing a window).
