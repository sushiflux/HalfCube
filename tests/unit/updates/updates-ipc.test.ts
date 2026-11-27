// The updater's IPC handlers (desktop/src/updates/updates-ipc.ts): only the main frame of the program's own page may call, and
// the arguments are checked again in the main process (the preload's coercion is not a boundary). Electron is replaced by a fake
// ipcMain that records the handlers, so each one is called the way a page or an embedded frame would call it.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: { senderFrame: { url: string; parent: unknown } | null }, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();

vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
  BrowserWindow: { getAllWindows: () => [] },
}));

const { installUpdatesIpc } = await import("../../../desktop/src/updates/updates-ipc.ts");
const types = await import("../../../app/src/updates/types.ts");

const own = { url: "app://halfcube/index.html", parent: null };
const iframe = { url: "app://halfcube/index.html", parent: own };
const foreign = { url: "https://example.com/", parent: null };

function setup() {
  handlers.clear();
  const state = { supported: false, reason: "dev-build" } as const;
  const service = {
    getState: vi.fn<() => typeof state>(() => state),
    check: vi.fn<(manual: boolean) => Promise<{ ok: true }>>(() => Promise.resolve({ ok: true })),
    download: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    restartNow: vi.fn<() => Promise<{ ok: false }>>(() => Promise.resolve({ ok: false })),
    setInstallOnExit: vi.fn<(on: boolean) => typeof state>(() => state),
    onChange: vi.fn<() => () => void>(() => () => undefined),
  };
  const log = vi.fn<(line: string) => void>();
  installUpdatesIpc({
    service: service as never,
    isTrustedFrame: (frame) => frame !== null && frame.parent === null && frame.url.startsWith("app://halfcube/"),
    log,
  });
  return { service, log };
}

const call = (channel: string, frame: { url: string; parent: unknown } | null, ...args: unknown[]) =>
  Promise.resolve().then(() => handlers.get(channel)?.({ senderFrame: frame }, ...args));

describe("updates IPC", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  const channels = [
    [types.IPC_UPDATES_GET, []],
    [types.IPC_UPDATES_CHECK, [true]],
    [types.IPC_UPDATES_DOWNLOAD, []],
    [types.IPC_UPDATES_RESTART, []],
    [types.IPC_UPDATES_ON_EXIT, [true]],
  ] as const;

  it.each(channels)("%s refuses an embedded frame, a foreign page and a missing frame", async (channel, args) => {
    for (const frame of [iframe, foreign, null]) {
      await expect(call(channel, frame, ...args)).rejects.toThrow("Only the program's own page may use the updater.");
    }
    expect(ctx.service.check).not.toHaveBeenCalled();
    expect(ctx.service.download).not.toHaveBeenCalled();
    expect(ctx.service.restartNow).not.toHaveBeenCalled();
    expect(ctx.service.setInstallOnExit).not.toHaveBeenCalled();
  });

  it.each([["yes"], [1], [null], [undefined], [{ valueOf: (): boolean => true }]])("check and setInstallOnExit refuse %s as the flag", async (value) => {
    await expect(call(types.IPC_UPDATES_CHECK, own, value)).rejects.toThrow("A boolean is expected.");
    await expect(call(types.IPC_UPDATES_ON_EXIT, own, value)).rejects.toThrow("A boolean is expected.");
    expect(ctx.service.check).not.toHaveBeenCalled();
    expect(ctx.service.setInstallOnExit).not.toHaveBeenCalled();
  });

  it("the own page reaches the service", async () => {
    await call(types.IPC_UPDATES_CHECK, own, false);
    await call(types.IPC_UPDATES_ON_EXIT, own, true);
    await call(types.IPC_UPDATES_DOWNLOAD, own);
    await call(types.IPC_UPDATES_RESTART, own);
    expect(ctx.service.check).toHaveBeenCalledWith(false);
    expect(ctx.service.setInstallOnExit).toHaveBeenCalledWith(true);
    expect(ctx.service.download).toHaveBeenCalledOnce();
    expect(ctx.service.restartNow).toHaveBeenCalledOnce();
  });
});
