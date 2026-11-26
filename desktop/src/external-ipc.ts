// The two calls that open something outside the program window: an https address in the system browser, and the Chromium
// licence file that ships with Electron. The page can only ask; the address is checked here again and the licence file
// path is fixed in the main process, so the page never names a file.
import { ipcMain, shell } from "electron";
import { existsSync } from "node:fs";
import { parseExternalUrl } from "../../app/src/about/external-url.ts";
import { IPC_OPEN_CHROMIUM_LICENCES, IPC_OPEN_EXTERNAL } from "../../app/src/engine/bridge.ts";
import type { OpenResult } from "../../app/src/platform.ts";

export interface ExternalIpcOptions {
  /** True when the frame that sent a request is the main frame of our own page. Everything else is refused. */
  isTrustedFrame: (frame: { url: string; parent: unknown } | null) => boolean;
  /** Full path of LICENSES.chromium.html next to the Electron executable. */
  chromiumLicencesFile: string;
  log: (line: string) => void;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function installExternalIpc(opts: ExternalIpcOptions): void {
  ipcMain.handle(IPC_OPEN_EXTERNAL, async (event, raw: unknown): Promise<OpenResult> => {
    if (!opts.isTrustedFrame(event.senderFrame)) {
      opts.log(`open-external refused: request from an untrusted frame (${event.senderFrame?.url ?? "unknown"})`);
      return { ok: false, message: "Only the program's own page may open addresses." };
    }
    const url = parseExternalUrl(raw);
    if (url === null) {
      opts.log("open-external refused: not a plain https address");
      return { ok: false, message: "Only plain https addresses can be opened outside the program." };
    }
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (error) {
      opts.log(`open-external failed: ${describe(error)}`);
      return { ok: false, message: `The system browser could not be started for ${url}: ${describe(error)}` };
    }
  });

  ipcMain.handle(IPC_OPEN_CHROMIUM_LICENCES, async (event): Promise<OpenResult> => {
    if (!opts.isTrustedFrame(event.senderFrame)) {
      opts.log(`open-chromium-licences refused: request from an untrusted frame (${event.senderFrame?.url ?? "unknown"})`);
      return { ok: false, message: "Only the program's own page may open files." };
    }
    const file = opts.chromiumLicencesFile;
    if (!existsSync(file)) return { ok: false, message: `The file LICENSES.chromium.html does not exist: ${file}` };
    // openPath answers with an empty string on success and an error text otherwise.
    const failure = await shell.openPath(file);
    return failure === "" ? { ok: true } : { ok: false, message: `The file ${file} could not be opened: ${failure}` };
  });
}
