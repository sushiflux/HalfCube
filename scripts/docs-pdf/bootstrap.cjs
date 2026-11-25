// Entry point of every Electron job of this folder. The job script and the job file come from the environment
// variables PARTCRAFT_JOB_SCRIPT and PARTCRAFT_JOB_FILE (set by run-electron.mjs).
// Electron shows an error dialog for an uncaught error in the main process. These jobs must never show a window,
// so every error is written to the error output and ends the process with code 1 instead.
"use strict";
const { app, dialog } = require("electron");

dialog.showErrorBox = (title, content) => {
  process.stderr.write(`${title}\n${content}\n`);
};
const fail = (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

try {
  require(process.env.PARTCRAFT_JOB_SCRIPT);
} catch (error) {
  fail(error);
}
