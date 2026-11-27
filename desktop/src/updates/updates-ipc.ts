// IPC of the update function: the page asks, the update service answers, and every state change is pushed to the window.
// Like external-ipc.ts, only the main frame of the program's own page may call; arguments are validated here again.
import { BrowserWindow, ipcMain } from "electron";
import {
  IPC_UPDATES_CHECK,
  IPC_UPDATES_DOWNLOAD,
  IPC_UPDATES_GET,
  IPC_UPDATES_ON_EXIT,
  IPC_UPDATES_RESTART,
  IPC_UPDATES_STATE,
  type UpdateCheckResult,
  type UpdateError,
  type UpdateState,
} from "../../../app/src/updates/types.ts";
import type { UpdateService } from "./service.ts";

export interface UpdatesIpcOptions {
  service: UpdateService;
  /** True when the frame that sent a request is the main frame of our own page. Everything else is refused. */
  isTrustedFrame: (frame: { url: string; parent: unknown } | null) => boolean;
  log: (line: string) => void;
}

export function installUpdatesIpc(opts: UpdatesIpcOptions): void {
  const { service } = opts;

  /** Throws for a request from anywhere but our own page; the promise of the caller then rejects. */
  const requireOwnPage = (channel: string, frame: { url: string; parent: unknown } | null): void => {
    if (opts.isTrustedFrame(frame)) return;
    opts.log(`${channel} abgelehnt: Anfrage aus einem fremden Frame (${frame?.url ?? "unbekannt"})`);
    throw new Error("Only the program's own page may use the updater.");
  };
  const requireBoolean = (channel: string, value: unknown): boolean => {
    if (typeof value === "boolean") return value;
    opts.log(`${channel} abgelehnt: ein Wahrheitswert wurde erwartet`);
    throw new TypeError("A boolean is expected.");
  };

  ipcMain.handle(IPC_UPDATES_GET, (event): UpdateState => {
    requireOwnPage(IPC_UPDATES_GET, event.senderFrame);
    return service.getState();
  });
  ipcMain.handle(IPC_UPDATES_CHECK, async (event, manual: unknown): Promise<UpdateCheckResult> => {
    requireOwnPage(IPC_UPDATES_CHECK, event.senderFrame);
    return service.check(requireBoolean(IPC_UPDATES_CHECK, manual));
  });
  ipcMain.handle(IPC_UPDATES_DOWNLOAD, async (event): Promise<void> => {
    requireOwnPage(IPC_UPDATES_DOWNLOAD, event.senderFrame);
    await service.download();
  });
  ipcMain.handle(IPC_UPDATES_RESTART, async (event): Promise<{ ok: false; error: UpdateError }> => {
    requireOwnPage(IPC_UPDATES_RESTART, event.senderFrame);
    return service.restartNow();
  });
  ipcMain.handle(IPC_UPDATES_ON_EXIT, (event, on: unknown): UpdateState => {
    requireOwnPage(IPC_UPDATES_ON_EXIT, event.senderFrame);
    return service.setInstallOnExit(requireBoolean(IPC_UPDATES_ON_EXIT, on));
  });

  // Every change goes to every window of the program (there is one), also download progress.
  service.onChange((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(IPC_UPDATES_STATE, state);
    }
  });
}
