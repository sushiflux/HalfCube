// Shows a window minimized without activating anything (Windows: ShowWindow with SW_SHOWMINNOACTIVE).
//
// Why not BrowserWindow.minimize(): it ends in SW_MINIMIZE, which "minimizes the specified window and activates the
// next top-level window in the Z order" (Win32 ShowWindow documentation). With a game or another program in front,
// that moved the focus. SW_SHOWMINNOACTIVE displays the window minimized and does not activate it. Electron has no
// API for it, so a short-lived hidden PowerShell process makes the one call (no native npm dependency).
import { spawn } from "node:child_process";
import type { BrowserWindow } from "electron";

const SW_SHOWMINNOACTIVE = 7;

const script = (handle: string) =>
  [
    "Add-Type -Namespace Native -Name Win -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(System.IntPtr h, int cmd);'",
    `[void][Native.Win]::ShowWindow([System.IntPtr]::new(${handle}), ${SW_SHOWMINNOACTIVE})`,
  ].join("; ");

/** Resolves true when the window was shown minimized and not activated. */
export function showMinimizedNoActivate(win: BrowserWindow, log: (line: string) => void): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);
  // The native handle is a pointer-sized little-endian integer (HWND).
  const buffer = win.getNativeWindowHandle();
  const handle = (buffer.length >= 8 ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0))).toString();
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script(handle)],
      { windowsHide: true, stdio: "ignore" },
    );
    child.once("error", (error) => {
      log(`ShowWindow helper could not start: ${error.message}`);
      resolve(false);
    });
    child.once("exit", (code) => resolve(code === 0));
  });
}
