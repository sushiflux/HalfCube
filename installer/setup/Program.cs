using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using HalfCube.Setup.Localization;
using HalfCube.Setup.Ui;

namespace HalfCube.Setup;

/// <summary>
/// HalfCube-Setup-&lt;version&gt;.exe: the designed installer. It carries Velopack's Setup.exe as an appended ZIP (see <see cref="Payload"/>)
/// and runs it silently underneath, per user and without administrator rights. Started again while HalfCube is installed it replaces
/// the installation (projects and settings stay) and offers the uninstaller.
/// Options for the build and for tests: <c>--append-payload &lt;exe&gt; &lt;zip&gt;</c> (build script), <c>--payload &lt;zip&gt;</c>,
/// <c>--install-dir &lt;folder&gt;</c>, <c>--appdata &lt;folder&gt;</c> (where %APPDATA% is taken from, tests never touch the real one),
/// <c>--lang de|en</c>, <c>--light</c> / <c>--dark</c>, <c>--uninstall</c> (the uninstall window), <c>--headless</c> (do it with the given
/// choices, no window; with <c>--log &lt;file&gt;</c> the lines also go to a file), <c>--no-start-menu</c>, <c>--no-desktop</c>,
/// <c>--test-layout &lt;folder&gt;</c> (offscreen pictures of every page, nothing is shown or installed), <c>--selftest-gui &lt;folder&gt;</c> (the
/// window code drives a real installation or, with <c>--uninstall</c>, removal without ever being shown; pictures go to the folder).
/// </summary>
internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        var headlessRun = args.Any(a => a.Equals("--headless", StringComparison.OrdinalIgnoreCase) || a.Equals("--test-layout", StringComparison.OrdinalIgnoreCase) || a.Equals("--selftest-gui", StringComparison.OrdinalIgnoreCase));
        Dialogs.Headless = headlessRun;
        try
        {
            return Run(args);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // Never Windows' crash box: the complete reason in our own window (a headless run only writes it to stderr)
            Console.Error.WriteLine(ex);
            if (!Dialogs.Headless) Dialogs.Error(null, ex.ToString());
            return 1;
        }
    }

    private static int Run(string[] args)
    {
        string? Arg(string name) => args.SkipWhile(a => !a.Equals(name, StringComparison.OrdinalIgnoreCase)).Skip(1).FirstOrDefault();
        bool Has(string name) => args.Any(a => a.Equals(name, StringComparison.OrdinalIgnoreCase));

        if (Has("--append-payload"))
        {
            var index = Array.FindIndex(args, a => a.Equals("--append-payload", StringComparison.OrdinalIgnoreCase));
            Payload.Append(args[index + 1], args[index + 2]);
            return 0;
        }

        ApplicationConfiguration.Initialize();
        if (Arg("--lang") is { } lang) UiLang.Current = lang;
        if (Has("--dark")) ThemeMode.Set(true);
        if (Has("--light")) ThemeMode.Set(false);

        using var payload = Arg("--payload") is { } zip ? Payload.FromZip(zip) : Payload.FromExe(Environment.ProcessPath!);
        var info = payload?.ReadInfo();
        if (payload is null || info is null)
        {
            Fatal(SetupTexts.ErrPayloadBroken("no payload"), args);
            return 1;
        }
        ErrorReport.AppVersion = info.DisplayVersion;
        var layout = new SetupLayout(info.PackId, info.Title, Arg("--appdata"));
        var installed = layout.FindInstalled();
        var state = new SetupState
        {
            Info = info,
            InstalledVersion = installed?.Version,
            LicenceText = payload.ReadText(Payload.LicenceEntry),
            NoticeText = payload.ReadText(Payload.NoticeEntry),
            InstallDir = Arg("--install-dir") ?? installed?.Folder ?? layout.DefaultInstallDir,
            StartMenu = !Has("--no-start-menu"),
            DesktopShortcut = !Has("--no-desktop"),
        };

        if (Has("--font-info"))
        {
            AttachConsole(-1);
            Console.Out.WriteLine(Fonts.HasGeist ? "Geist" : "fallback: " + (Fonts.FailureReason ?? "families not found"));
            return 0;
        }

        if (Arg("--test-layout") is { } folder) return SetupLayoutCheck.Run(state, folder);

        var engine = new InstallEngine(layout, payload, info);
        var remover = new UninstallEngine(layout);

        if (Arg("--selftest-gui") is { } shots)
        {
            AttachConsole(-1);
            if (!Has("--uninstall")) return GuiSelfTest.RunInstall(state, engine, shots);
            var selfState = new UninstallState { DisplayVersion = info.DisplayVersion, SizeText = InstallEngine.Size(InstallEngine.FolderSize(installed?.Folder ?? string.Empty)) };
            return GuiSelfTest.RunUninstall(selfState, remover, shots);
        }

        if (Has("--headless")) return Has("--uninstall") ? RunHeadlessUninstall(remover, Arg("--log")) : RunHeadlessInstall(engine, state, Arg("--log"));

        var uninstall = Has("--uninstall");
        InstallState? done = null;
        while (true)
        {
            if (uninstall)
            {
                if (installed is null)
                {
                    Dialogs.Error(null, UninstallTexts.ErrNotFound());
                    return 1;
                }
                var uninstallState = new UninstallState { DisplayVersion = info.DisplayVersion, SizeText = InstallEngine.Size(InstallEngine.FolderSize(installed.Folder)) };
                using var removeWindow = new UninstallWindow(uninstallState, progress => remover.RunAsync(progress, CancellationToken.None));
                Application.Run(removeWindow);
                return uninstallState.Succeeded ? 0 : 1;
            }

            using var window = new SetupWindow(state, (request, progress) => engine.RunAsync(request, progress, CancellationToken.None));
            Application.Run(window);
            if (window.UninstallRequested)
            {
                uninstall = true;
                installed = layout.FindInstalled();
                continue;
            }
            done = new InstallState(state.Succeeded, window.LaunchAfterFinish);
            break;
        }

        if (done.LaunchRequested && done.Succeeded) Launch(Path.Combine(state.InstallDir, "current", info.MainExe), Path.Combine(state.InstallDir, "current"));
        return done.Succeeded ? 0 : 1;
    }

    private sealed record InstallState(bool Succeeded, bool LaunchRequested);

    private static void Launch(string exe, string folder)
    {
        try
        {
            Process.Start(new ProcessStartInfo(exe) { UseShellExecute = false, WorkingDirectory = folder })?.Dispose();
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            Dialogs.Error(null, SetupTexts.ErrStartFailed(ex.Message));
        }
    }

    private static void Fatal(Msg message, string[] args)
    {
        if (args.Any(a => a.Equals("--headless", StringComparison.OrdinalIgnoreCase) || a.Equals("--test-layout", StringComparison.OrdinalIgnoreCase)))
            Console.Error.WriteLine(message.En);
        else Dialogs.Error(null, message);
    }

    private static int RunHeadlessInstall(InstallEngine engine, SetupState state, string? logFile)
    {
        AttachConsole(-1);
        var log = new StringBuilder();
        void Line(string text)
        {
            log.AppendLine(text);
            Console.Out.WriteLine(text);
        }
        try
        {
            var last = -1;
            engine.RunAsync(state.Request(), new SyncProgress(p =>
            {
                var step = (int)(p.Value * 100);
                if (step == last) return;
                last = step;
                Line($"{p.Value * 100:0}% {p.Task}{(p.Detail is { } d ? " - " + d.En : string.Empty)}");
            }), CancellationToken.None).GetAwaiter().GetResult();
            Line("OK");
            return 0;
        }
        catch (InstallException ex)
        {
            Line("ERROR: " + ex.Text.En);
            return 1;
        }
        finally
        {
            if (logFile is not null) File.WriteAllText(logFile, log.ToString(), new UTF8Encoding(false));
        }
    }

    private static int RunHeadlessUninstall(UninstallEngine engine, string? logFile)
    {
        AttachConsole(-1);
        var log = new StringBuilder();
        void Line(string text)
        {
            log.AppendLine(text);
            Console.Out.WriteLine(text);
        }
        try
        {
            var last = -1;
            engine.RunAsync(new SyncProgress<RemoveProgress>(p =>
            {
                var step = (int)(p.Value * 100);
                if (step == last) return;
                last = step;
                Line($"{p.Value * 100:0}% step {p.Step}{(p.Detail is { } d ? " - " + d.En : string.Empty)}");
            }), CancellationToken.None).GetAwaiter().GetResult();
            Line("OK");
            return 0;
        }
        catch (InstallException ex)
        {
            Line("ERROR: " + ex.Text.En);
            return 1;
        }
        finally
        {
            if (logFile is not null) File.WriteAllText(logFile, log.ToString(), new UTF8Encoding(false));
        }
    }

    /// <summary>Progress without a UI thread (a headless run reports synchronously).</summary>
    private sealed class SyncProgress(Action<InstallProgress> report) : IProgress<InstallProgress>
    {
        public void Report(InstallProgress value) => report(value);
    }

    private sealed class SyncProgress<T>(Action<T> report) : IProgress<T>
    {
        public void Report(T value) => report(value);
    }

    [DllImport("kernel32.dll")]
    private static extern bool AttachConsole(int processId);
}
