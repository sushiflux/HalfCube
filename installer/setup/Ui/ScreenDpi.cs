using System.Runtime.InteropServices;

namespace HalfCube.Setup.Ui;

/// <summary>
/// DPI of a monitor (or of a point/window on it) for windows that size themselves before their handle exists. The setup is system-DPI
/// aware, so Windows answers with the system scaling (GetDpiForMonitor, learn.microsoft.com).
/// </summary>
public static class ScreenDpi
{
    public static float ScaleAt(Point screenPoint) => ScaleOfMonitor(MonitorFromPoint(screenPoint, 2));

    public static float ScaleOfWindow(IntPtr hwnd)
    {
        try
        {
            var dpi = GetDpiForWindow(hwnd);
            return dpi == 0 ? 1f : dpi / 96f;
        }
        catch (EntryPointNotFoundException)
        {
            return 1f;
        }
    }

    private static float ScaleOfMonitor(IntPtr monitor)
    {
        try
        {
            return monitor != IntPtr.Zero && GetDpiForMonitor(monitor, 0, out var dpi, out _) == 0 && dpi > 0 ? dpi / 96f : 1f;
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException)
        {
            return 1f;
        }
    }

    [DllImport("user32.dll")] private static extern IntPtr MonitorFromPoint(Point point, uint flags);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("shcore.dll")] private static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);
}
