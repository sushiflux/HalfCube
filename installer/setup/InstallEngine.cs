using System.Diagnostics;
using System.Globalization;
using System.Security.Principal;
using Partcraft.Setup.Localization;

namespace Partcraft.Setup;

/// <summary>The choices of the setup window (or the defaults of a headless test install).</summary>
internal sealed record InstallRequest(string InstallDir, bool StartMenu, bool DesktopShortcut, string Language, bool Dark);

/// <summary>The steps the installing page lists.</summary>
internal enum InstallTask
{
    Prepare,
    Package,
    Files,
    Shortcuts,
    Finish,
}

/// <summary>Progress of a run: overall 0..1, the step that is active and a short detail for that step (for example "298 of 480 MB").</summary>
internal readonly record struct InstallProgress(float Value, InstallTask Task, Msg? Detail = null);

/// <summary>A failure with its complete message in both languages (shown in the window's copyable error box).</summary>
internal sealed class InstallException(Msg text, Exception? inner = null) : Exception(text.En, inner)
{
    public Msg Text { get; } = text;
}

/// <summary>
/// The installation itself, without UI. It checks the PC, takes Velopack's <c>Setup.exe</c> out of the payload into a temporary folder
/// and runs it silently (<c>--silent --installto</c>, no window, no administrator rights); the progress is the fill level of the target
/// folder against the known installed size (Velopack reports no progress in silent mode). Afterwards it removes the shortcuts the
/// user switched off and writes <c>setup-choices.json</c> for the app's first start.
/// </summary>
internal sealed class InstallEngine(SetupLayout layout, Payload payload, PayloadInfo info)
{
    /// <summary>How long Velopack's installer may run before it is stopped (a normal install takes seconds).</summary>
    public TimeSpan VelopackTimeout { get; init; } = TimeSpan.FromMinutes(15);

    /// <summary>How often the target folder is measured while Velopack runs.</summary>
    public TimeSpan PollInterval { get; init; } = TimeSpan.FromMilliseconds(150);

    public async Task RunAsync(InstallRequest request, IProgress<InstallProgress> progress, CancellationToken ct)
    {
        var target = Path.GetFullPath(request.InstallDir);
        var wasInstalled = layout.FindInstalled() is not null;

        // 1 - requirements
        progress.Report(new InstallProgress(0.01f, InstallTask.Prepare));
        if (IsElevated()) throw new InstallException(SetupTexts.ErrElevated());
        // The check gets the path as it was given: a relative one is never fully qualified and never accepted
        if (CheckFolder(request.InstallDir) is { } problem) throw new InstallException(problem);
        var temp = Path.Combine(Path.GetTempPath(), "Partcraft-Setup-" + Guid.NewGuid().ToString("N"));
        var neededTarget = info.InstalledBytes + 100L * 1024 * 1024;
        var neededTemp = info.SetupBytes + 50L * 1024 * 1024;
        var sameDrive = string.Equals(Path.GetPathRoot(target), Path.GetPathRoot(temp), StringComparison.OrdinalIgnoreCase);
        var needed = sameDrive ? neededTarget + neededTemp : neededTarget;
        var free = FreeSpace(target);
        if (free is { } available && available < needed) throw new InstallException(SetupTexts.ErrNoSpace(target, Size(needed), Size(available)));
        progress.Report(new InstallProgress(0.04f, InstallTask.Prepare, SetupTexts.DetailRequirements(WindowsName(), free is { } f ? Size(f) : "?")));

        // 2 - the package: check the checksum, take Velopack's Setup.exe out into a temporary folder
        progress.Report(new InstallProgress(0.05f, InstallTask.Package));
        var setupExe = Path.Combine(temp, "Setup.exe");
        try
        {
            var verified = await Task.Run(payload.Verify, ct);
            if (!verified) throw new InstallException(SetupTexts.ErrPayloadBroken("SHA-256"));
            Directory.CreateDirectory(temp);
            await Task.Run(() => payload.ExtractEntry(Payload.VelopackEntry, setupExe,
                new Progress<float>(p => progress.Report(new InstallProgress(0.05f + p * 0.09f, InstallTask.Package, SetupTexts.DetailSize(Size(info.SetupBytes))))), ct), ct);
        }
        catch (InvalidDataException ex)
        {
            TryDelete(temp);
            throw new InstallException(SetupTexts.ErrPayloadBroken(ex.Message), ex);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            TryDelete(temp);
            throw new InstallException(SetupTexts.ErrExtractFailed(temp, ex.Message), ex);
        }
        catch (OperationCanceledException)
        {
            TryDelete(temp);
            throw;
        }

        try
        {
            // 3 - Velopack installs (silently, into the chosen folder)
            progress.Report(new InstallProgress(0.14f, InstallTask.Files, SetupTexts.DetailProgress("0 MB", Size(info.InstalledBytes))));
            await RunVelopackAsync(setupExe, target, Path.Combine(temp, "velopack-setup.log"), progress, ct);

            // 4 - the shortcuts the user did not want (Velopack creates its two fixed locations)
            progress.Report(new InstallProgress(0.95f, InstallTask.Shortcuts));
            await Task.Run(() => RemoveDeclinedShortcuts(target, request), ct);

            // 5 - check the result, write the choices for the app's first start
            progress.Report(new InstallProgress(0.98f, InstallTask.Finish));
            var mainExe = Path.Combine(target, "current", info.MainExe);
            if (!File.Exists(mainExe)) throw new InstallException(SetupTexts.ErrMainExeMissing(mainExe));
            // An update leaves the choices alone: the app has its own settings by then
            if (!wasInstalled || !File.Exists(layout.SetupChoicesFile)) WriteChoices(layout.SetupChoicesFile, request.Language, request.Dark);
            progress.Report(new InstallProgress(1f, InstallTask.Finish));
        }
        finally
        {
            TryDelete(temp);
        }
    }

    private async Task RunVelopackAsync(string setupExe, string target, string logFile, IProgress<InstallProgress> progress, CancellationToken ct)
    {
        var start = new ProcessStartInfo(setupExe)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            WorkingDirectory = Path.GetDirectoryName(setupExe)!,
        };
        start.ArgumentList.Add("--silent");
        start.ArgumentList.Add("--installto");
        start.ArgumentList.Add(target);
        start.ArgumentList.Add("--log");
        start.ArgumentList.Add(logFile);

        Process process;
        try
        {
            process = Process.Start(start) ?? throw new InstallException(SetupTexts.ErrStartFailed("Process.Start returned nothing."));
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
        {
            throw new InstallException(SetupTexts.ErrStartFailed(ex.Message), ex);
        }

        using (process)
        {
            var limit = Stopwatch.StartNew();
            var exited = process.WaitForExitAsync(ct);
            var total = Math.Max(1L, info.InstalledBytes);
            // An update starts with the old program folder still in place: Velopack moves it away first, so the folder only counts once
            // it has become (nearly) empty again; otherwise the bar would jump to the end and back
            var baseline = await Task.Run(() => FolderSize(target), ct);
            var emptied = baseline < total / 20;
            while (!process.HasExited)
            {
                if (limit.Elapsed > VelopackTimeout)
                {
                    try { process.Kill(entireProcessTree: true); } catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception) { }
                    throw new InstallException(SetupTexts.ErrVelopackTimeout((int)VelopackTimeout.TotalMinutes));
                }
                ct.ThrowIfCancellationRequested();
                var measured = await Task.Run(() => FolderSize(target), ct);
                if (!emptied && measured < baseline / 2) emptied = true;
                var done = emptied ? Math.Min(total, measured) : 0;
                var share = done / (float)total;
                // Never 100 % while Velopack still runs (hooks, shortcuts and the registry entry come last)
                progress.Report(new InstallProgress(0.14f + Math.Min(0.98f, share) * 0.80f, InstallTask.Files, SetupTexts.DetailProgress(Size(done, omitUnit: true), Size(total))));
                await Task.WhenAny(exited, Task.Delay(PollInterval, ct));
            }
            await exited;
            if (process.ExitCode != 0)
                throw new InstallException(SetupTexts.ErrVelopackFailed(process.ExitCode, logFile, LogTail(logFile)));
            progress.Report(new InstallProgress(0.94f, InstallTask.Files, SetupTexts.DetailProgress(Size(total, omitUnit: true), Size(total))));
        }
    }

    /// <summary>Null when the folder may become the program folder, else what is wrong with it.</summary>
    public Msg? CheckFolder(string folder)
    {
        if (!SetupLayout.IsSafeProgramFolder(folder)) return SetupTexts.ErrFolderUnsafe(folder);
        // Velopack empties the folder it installs into: only a missing, empty or already installed folder qualifies
        if (Directory.Exists(folder) && Directory.EnumerateFileSystemEntries(folder).Any() && !SetupLayout.IsVelopackFolder(folder))
            return SetupTexts.ErrFolderNotEmpty(folder);
        return null;
    }

    /// <summary>
    /// Velopack creates a desktop and a start menu shortcut named after the app (their places are fixed in the package). The ones the user
    /// switched off are deleted again - only shortcuts that point into the new program folder.
    /// </summary>
    private void RemoveDeclinedShortcuts(string target, InstallRequest request)
    {
        if (!request.DesktopShortcut) DeleteShortcutTo(layout.DesktopShortcut, target);
        if (!request.StartMenu) DeleteShortcutTo(layout.StartMenuShortcut, target);
    }

    private static void DeleteShortcutTo(string shortcut, string folder)
    {
        try
        {
            if (!File.Exists(shortcut)) return;
            if (ShortcutTarget(shortcut) is not { } link || !link.StartsWith(folder.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) return;
            File.Delete(shortcut);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // A shortcut that stays is harmless: the user can delete it by hand
        }
    }

    /// <summary>The target of a .lnk file (Windows Script Host); null when it cannot be read.</summary>
    internal static string? ShortcutTarget(string shortcut)
    {
        try
        {
            var type = Type.GetTypeFromProgID("WScript.Shell");
            if (type is null) return null;
            dynamic shell = Activator.CreateInstance(type)!;
            dynamic link = shell.CreateShortcut(shortcut);
            return (string?)link.TargetPath;
        }
        catch (Exception ex) when (ex is System.Runtime.InteropServices.COMException or InvalidCastException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException or NotSupportedException)
        {
            return null;
        }
    }

    /// <summary>
    /// <c>%APPDATA%\Partcraft\setup-choices.json</c>: what the user chose in the setup, for the app's first start
    /// (<c>{ "version": 1, "language": "de"|"en", "colorMode": "light"|"dark" }</c>). Written through a temporary file so the app never
    /// reads half a file.
    /// </summary>
    public static void WriteChoices(string file, string language, bool dark)
    {
        var lang = language == UiLang.English ? "en" : "de";
        var json = "{\n  \"version\": 1,\n  \"language\": \"" + lang + "\",\n  \"colorMode\": \"" + (dark ? "dark" : "light") + "\"\n}\n";
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var temp = file + ".tmp";
        File.WriteAllText(temp, json, new System.Text.UTF8Encoding(false));
        File.Move(temp, file, overwrite: true);
    }

    // ---- helpers -----------------------------------------------------------------------------------------------------------------

    public static long FolderSize(string folder)
    {
        long total = 0;
        try
        {
            if (!Directory.Exists(folder)) return 0;
            foreach (var file in new DirectoryInfo(folder).EnumerateFiles("*", new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true }))
            {
                try { total += file.Length; }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* the file vanished while we looked */ }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Measuring is best effort
        }
        return total;
    }

    public static string LogTail(string logFile, int lines = 25)
    {
        try
        {
            if (!File.Exists(logFile)) return "(no log file was written)";
            var all = File.ReadAllLines(logFile);
            return string.Join('\n', all.TakeLast(lines));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return "(the log file could not be read: " + ex.Message + ")";
        }
    }

    public static long? FreeSpace(string folder)
    {
        try
        {
            var root = Path.GetPathRoot(Path.GetFullPath(folder));
            return root is null ? null : new DriveInfo(root).AvailableFreeSpace;
        }
        catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    // The setup runs with invariant globalization: the decimal comma for German is set by hand
    public static string Size(long bytes, bool omitUnit = false)
    {
        string text;
        if (bytes < 1L << 30) text = (bytes / (1L << 20)).ToString(CultureInfo.InvariantCulture) + (omitUnit ? string.Empty : " MB");
        else
        {
            var number = (bytes / (double)(1L << 30)).ToString("0.0", CultureInfo.InvariantCulture);
            text = (UiLang.Current == UiLang.English ? number : number.Replace('.', ',')) + (omitUnit ? string.Empty : " GB");
        }
        return text;
    }

    private static string WindowsName() => Environment.OSVersion.Version.Build >= 22000 ? "Windows 11" : "Windows 10";

    private static bool IsElevated()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }

    internal static void TryDelete(string folder)
    {
        try
        {
            if (Directory.Exists(folder)) Directory.Delete(folder, recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // A leftover in the temp folder is harmless
        }
    }
}

/// <summary>Progress of the removal: overall 0..1, the step that is active and a short detail.</summary>
internal readonly record struct RemoveProgress(float Value, int Step, Msg? Detail = null);

/// <summary>
/// The removal, without UI: runs the installation's own <c>Update.exe --uninstall --silent</c> (the command Velopack registers as the
/// quiet uninstall string) and measures the shrinking program folder. Velopack closes a running Partcraft, runs the app's uninstall
/// hook, removes the shortcuts and the Apps entry and deletes the folder. Projects and settings in %APPDATA%\Partcraft are not touched.
/// </summary>
internal sealed class UninstallEngine(SetupLayout layout)
{
    public TimeSpan Timeout { get; init; } = TimeSpan.FromMinutes(5);

    public TimeSpan FolderGone { get; init; } = TimeSpan.FromSeconds(30);

    public TimeSpan PollInterval { get; init; } = TimeSpan.FromMilliseconds(150);

    public async Task RunAsync(IProgress<RemoveProgress> progress, CancellationToken ct)
    {
        var installed = layout.FindInstalled() ?? throw new InstallException(UninstallTexts.ErrNotFound());
        var folder = installed.Folder;
        var total = Math.Max(1L, await Task.Run(() => InstallEngine.FolderSize(folder), ct));
        var logFile = Path.Combine(Path.GetTempPath(), "Partcraft-Uninstall-" + Guid.NewGuid().ToString("N") + ".log");
        progress.Report(new RemoveProgress(0.02f, 0));

        var start = new ProcessStartInfo(installed.Updater)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            // Not the program folder itself: it is about to be deleted
            WorkingDirectory = Path.GetTempPath(),
        };
        start.ArgumentList.Add("--uninstall");
        start.ArgumentList.Add("--silent");
        start.ArgumentList.Add("--log");
        start.ArgumentList.Add(logFile);

        Process process;
        try
        {
            process = Process.Start(start) ?? throw new InstallException(UninstallTexts.ErrStartFailed("Process.Start returned nothing."));
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
        {
            throw new InstallException(UninstallTexts.ErrStartFailed(ex.Message), ex);
        }

        using (process)
        {
            var limit = Stopwatch.StartNew();
            var exited = process.WaitForExitAsync(ct);
            while (!process.HasExited)
            {
                if (limit.Elapsed > Timeout)
                {
                    try { process.Kill(entireProcessTree: true); } catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception) { }
                    throw new InstallException(UninstallTexts.ErrFailed(-1, folder, logFile, InstallEngine.LogTail(logFile)));
                }
                ct.ThrowIfCancellationRequested();
                Report(await Task.Run(() => InstallEngine.FolderSize(folder), ct));
                await Task.WhenAny(exited, Task.Delay(PollInterval, ct));
            }
            await exited;
            if (process.ExitCode != 0) throw new InstallException(UninstallTexts.ErrFailed(process.ExitCode, folder, logFile, InstallEngine.LogTail(logFile)));
        }

        // Velopack schedules the deletion of its own folder (Update.exe lives in it) a few seconds after it ends
        var wait = Stopwatch.StartNew();
        while (Directory.Exists(folder) && wait.Elapsed < FolderGone)
        {
            Report(await Task.Run(() => InstallEngine.FolderSize(folder), ct));
            await Task.Delay(PollInterval, ct);
        }
        if (Directory.Exists(folder) && Directory.EnumerateFileSystemEntries(folder).Any())
            throw new InstallException(UninstallTexts.ErrLeftover(folder));
        try { File.Delete(logFile); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        progress.Report(new RemoveProgress(1f, 2));

        void Report(long left)
        {
            var removed = total - Math.Min(total, left);
            var share = removed / (float)total;
            // Step 0 closes the program (nothing removed yet), step 1 removes the files, step 2 the shortcuts and entries
            var step = removed == 0 ? 0 : share < 0.97f ? 1 : 2;
            progress.Report(new RemoveProgress(0.02f + share * 0.96f, step, SetupTexts.DetailProgress(InstallEngine.Size(removed, omitUnit: true), InstallEngine.Size(total))));
        }
    }
}
