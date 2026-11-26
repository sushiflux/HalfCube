# Foreground watcher: logs every change of the foreground window (process, PID, window title, extended style) while
# tests or background starts run, and counts the moments a HalfCube/Electron window was in front ("Treffer").
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\foreground-watch.ps1 -Log <file> [-StopFile <file>] [-Seconds <n>]
#
# It creates no window and never activates anything: an out-of-context WinEvent hook (EVENT_SYSTEM_FOREGROUND) plus a
# 50 ms poll of GetForegroundWindow as a second source. It also logs every top-level window of an electron/HalfCube
# process when it is shown, with its extended style (WS_EX_NOACTIVATE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW), so a test run
# shows whether the windows can be activated at all. Ends when -StopFile exists or after -Seconds; prints a summary.
param(
    [Parameter(Mandatory = $true)][string]$Log,
    [string]$StopFile = '',
    [int]$Seconds = 3600,
    # Process names counted as hits (regular expression, case-insensitive).
    [string]$Match = '^(electron|halfcube)$'
)
$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Management -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

public static class ForegroundWatch {
    delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
    [DllImport("user32.dll")] static extern bool PeekMessage(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);
    [DllImport("user32.dll")] static extern uint MsgWaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint ms, uint mask);

    const uint EVENT_SYSTEM_FOREGROUND = 0x0003, EVENT_SYSTEM_MINIMIZEEND = 0x0017, EVENT_OBJECT_SHOW = 0x8002;
    const uint WINEVENT_OUTOFCONTEXT = 0x0000, WINEVENT_SKIPOWNPROCESS = 0x0002;
    const int GWL_EXSTYLE = -20;
    const long WS_EX_NOACTIVATE = 0x08000000, WS_EX_APPWINDOW = 0x00040000, WS_EX_TOOLWINDOW = 0x00000080, WS_EX_TOPMOST = 0x00000008;

    static StreamWriter writer;
    static Regex match;
    static IntPtr last = IntPtr.Zero;
    static readonly Dictionary<uint, string> names = new Dictionary<uint, string>();
    static readonly Dictionary<uint, string> commandLines = new Dictionary<uint, string>();
    static readonly HashSet<uint> hitPids = new HashSet<uint>();
    public static int Hits, Changes;
    static WinEventProc keepAlive; // the delegate must not be collected while the hook exists

    static string Name(uint pid) {
        string n;
        if (names.TryGetValue(pid, out n)) return n;
        try { n = Process.GetProcessById((int)pid).ProcessName; } catch { n = "?"; }
        names[pid] = n;
        return n;
    }

    static string CommandLine(uint pid) {
        string c;
        if (commandLines.TryGetValue(pid, out c)) return c;
        c = "?";
        try {
            using (var s = new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId=" + pid))
                foreach (ManagementObject o in s.Get()) c = (o["CommandLine"] as string) ?? "?";
        } catch { }
        commandLines[pid] = c;
        return c;
    }

    static string Text(IntPtr hwnd) { var sb = new StringBuilder(256); GetWindowText(hwnd, sb, sb.Capacity); return sb.ToString(); }
    static string Class(IntPtr hwnd) { var sb = new StringBuilder(128); GetClassName(hwnd, sb, sb.Capacity); return sb.ToString(); }

    static string Style(IntPtr hwnd) {
        long ex = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
        var parts = new List<string>();
        if ((ex & WS_EX_NOACTIVATE) != 0) parts.Add("NOACTIVATE");
        if ((ex & WS_EX_APPWINDOW) != 0) parts.Add("APPWINDOW");
        if ((ex & WS_EX_TOOLWINDOW) != 0) parts.Add("TOOLWINDOW");
        if ((ex & WS_EX_TOPMOST) != 0) parts.Add("TOPMOST");
        return "0x" + ex.ToString("X8") + (parts.Count > 0 ? " " + string.Join("|", parts) : "");
    }

    // Position in the Z order among the visible, not cloaked, not minimized top-level windows, and the window right above.
    // Windows activates the next such window when the foreground window is closed or minimized.
    static string ZOrder(IntPtr hwnd) {
        int above = 0;
        string first = "";
        for (IntPtr h = GetWindow(hwnd, 3); h != IntPtr.Zero; h = GetWindow(h, 3)) { // GW_HWNDPREV
            int cloaked;
            if (!IsWindowVisible(h) || IsIconic(h)) continue;
            if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) continue; // DWMWA_CLOAKED
            if ((GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64() & WS_EX_TOPMOST) != 0) continue; // always-on-top layer
            if (above == 0) { uint pid; GetWindowThreadProcessId(h, out pid); first = Name(pid) + " \"" + Text(h) + "\""; }
            above++;
        }
        return "Z-Rang " + (above + 1) + (above > 0 ? " unter " + first : " (oberstes normales Fenster)");
    }

    static void Write(string line) {
        writer.WriteLine(DateTime.Now.ToString("HH:mm:ss.fff") + " " + line);
        writer.Flush();
    }

    static void Foreground(IntPtr hwnd, string source) {
        if (hwnd == last) return;
        last = hwnd;
        Changes++;
        if (hwnd == IntPtr.Zero) { Write("VORDERGRUND (" + source + "): kein Fenster"); return; }
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        string name = Name(pid);
        bool hit = match.IsMatch(name);
        string line = (hit ? "TREFFER " : "") + "VORDERGRUND (" + source + "): " + name + " PID " + pid + " hwnd 0x" + hwnd.ToInt64().ToString("X") +
            " Klasse \"" + Class(hwnd) + "\" Titel \"" + Text(hwnd) + "\" Stil " + Style(hwnd);
        if (hit) {
            Hits++;
            hitPids.Add(pid);
            line += " Befehlszeile: " + CommandLine(pid);
        }
        Write(line);
    }

    static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
        try {
            if (ev == EVENT_SYSTEM_FOREGROUND) { Foreground(hwnd, "Hook"); return; }
            if (idObject != 0 || hwnd == IntPtr.Zero || GetAncestor(hwnd, 2) != hwnd) return; // top-level windows only
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            string name = Name(pid);
            if (!match.IsMatch(name)) return;
            string what = ev == EVENT_OBJECT_SHOW ? "SICHTBAR" : "WIEDERHERGESTELLT";
            Write(what + ": " + name + " PID " + pid + " hwnd 0x" + hwnd.ToInt64().ToString("X") + " Klasse \"" + Class(hwnd) + "\" Titel \"" + Text(hwnd) +
                "\" Stil " + Style(hwnd) + (IsIconic(hwnd) ? " minimiert" : "") + ", " + ZOrder(hwnd));
        } catch (Exception e) { Write("Fehler im Hook: " + e.Message); }
    }

    public static void Run(string log, string stopFile, int seconds, string pattern) {
        match = new Regex(pattern, RegexOptions.IgnoreCase);
        writer = new StreamWriter(log, true, new UTF8Encoding(false));
        keepAlive = OnEvent;
        IntPtr h1 = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, keepAlive, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        IntPtr h2 = SetWinEventHook(EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZEEND, IntPtr.Zero, keepAlive, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        IntPtr h3 = SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW, IntPtr.Zero, keepAlive, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        Write("Waechter gestartet (PID " + Process.GetCurrentProcess().Id + "), Treffer-Muster " + pattern + ", Hooks " + (h1 != IntPtr.Zero && h2 != IntPtr.Zero && h3 != IntPtr.Zero ? "aktiv" : "FEHLGESCHLAGEN"));
        Foreground(GetForegroundWindow(), "Start");
        var end = DateTime.Now.AddSeconds(seconds);
        MSG msg;
        while (DateTime.Now < end && (stopFile.Length == 0 || !File.Exists(stopFile))) {
            MsgWaitForMultipleObjects(0, null, false, 50, 0x04FF);
            while (PeekMessage(out msg, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref msg); DispatchMessage(ref msg); }
            Foreground(GetForegroundWindow(), "Abfrage");
        }
        UnhookWinEvent(h1); UnhookWinEvent(h2); UnhookWinEvent(h3);
        Write("Waechter beendet: " + Changes + " Vordergrundwechsel, " + Hits + " Treffer" + (hitPids.Count > 0 ? " (PIDs " + string.Join(", ", hitPids) + ")" : ""));
        writer.Dispose();
    }
}
'@

[ForegroundWatch]::Run([IO.Path]::GetFullPath($Log), $StopFile, $Seconds, $Match)
"Vordergrundwechsel: $([ForegroundWatch]::Changes), Treffer: $([ForegroundWatch]::Hits). Log: $Log"
