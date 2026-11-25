"use strict";
// Entry point of the installed (Velopack) Partcraft. scripts/build-installer.ps1 puts it next to the built main process
// (_build/desktop/main.cjs) and makes it the "main" of the packaged app; the program's own sources stay untouched.
//
// Velopack has to be the first thing that runs: during install, update and uninstall it starts this executable with a
// hook argument (--veloapp-*) and expects it to exit quickly without opening a window. run() handles those arguments
// and ends the process; for a normal start it returns and the program loads.
const { VelopackApp } = require("velopack");

VelopackApp.build().run();

require("./_build/desktop/main.cjs");
