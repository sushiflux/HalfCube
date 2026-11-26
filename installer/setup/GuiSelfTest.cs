using HalfCube.Setup.Localization;
using HalfCube.Setup.Ui;

namespace HalfCube.Setup;

/// <summary>
/// <c>--selftest-gui &lt;folder&gt;</c> (with the usual <c>--install-dir</c>, <c>--appdata</c>, <c>--payload</c> options): drives the real window
/// code through a real installation - or, with <c>--uninstall</c>, a real removal - without ever showing a window. The window is only
/// created, its handlers and progress reports run through a message pump, and pictures of it are saved to the folder while the work
/// goes on. It proves that the page flow, the progress reporting and the engine are wired together; nothing appears on the desktop.
/// </summary>
internal static class GuiSelfTest
{
    public static int RunInstall(SetupState state, InstallEngine engine, string folder)
    {
        Directory.CreateDirectory(folder);
        SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
        using var window = new SetupWindow(state, (request, progress) => engine.RunAsync(request, progress, CancellationToken.None), 1f);
        window.Next.Visible = true;
        // The user goes through the pages: welcome, licence, location (pictures), then "Install"
        foreach (var (index, name) in new[] { (0, "1-welcome"), (1, "2-licence"), (2, "3-location") })
        {
            window.GoTo(index);
            window.SavePicture(Path.Combine(folder, $"selftest-{name}.png"));
        }
        window.GoTo(3);
        var shots = new HashSet<int>();
        var task = window.RunInstallAsync();
        while (!task.IsCompleted)
        {
            Application.DoEvents();
            var share = (int)(window.CurrentProgress * 100);
            foreach (var mark in new[] { 25, 50, 75 })
            {
                if (share >= mark && shots.Add(mark)) window.SavePicture(Path.Combine(folder, $"selftest-4-installing-{mark}.png"));
            }
            Thread.Sleep(10);
        }
        Application.DoEvents();
        task.GetAwaiter().GetResult();
        window.SavePicture(Path.Combine(folder, "selftest-5-done.png"));
        Console.Out.WriteLine($"GUI self-test (install): succeeded={state.Succeeded} failed={state.Failed} page={window.CurrentPage.GetType().Name} pictures-in-progress={shots.Count}");
        return state.Succeeded && !state.Failed && window.CurrentPage.GetType().Name == "DonePage" ? 0 : 1;
    }

    public static int RunUninstall(UninstallState state, UninstallEngine engine, string folder)
    {
        Directory.CreateDirectory(folder);
        SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
        using var window = new UninstallWindow(state, progress => engine.RunAsync(progress, CancellationToken.None), 1f);
        window.SavePicture(Path.Combine(folder, "selftest-uninstall-1-confirm.png"));
        var task = window.RunUninstallAsync();
        var shot = false;
        while (!task.IsCompleted)
        {
            Application.DoEvents();
            if (!shot && window.CurrentProgress > 0.3f)
            {
                shot = true;
                window.SavePicture(Path.Combine(folder, "selftest-uninstall-2-removing.png"));
            }
            Thread.Sleep(10);
        }
        Application.DoEvents();
        task.GetAwaiter().GetResult();
        window.SavePicture(Path.Combine(folder, "selftest-uninstall-3-done.png"));
        Console.Out.WriteLine($"GUI self-test (uninstall): succeeded={state.Succeeded} failed={state.Failed}");
        return state.Succeeded && !state.Failed ? 0 : 1;
    }
}
