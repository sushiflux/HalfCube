using Microsoft.Win32;

namespace Partcraft.Setup;

/// <summary>What the setup finds on this PC: where Velopack puts the program, whether it is installed already, where the app's data lives.</summary>
internal sealed class SetupLayout
{
    private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall";

    public SetupLayout(string packId, string title, string? appDataOverride = null)
    {
        PackId = packId;
        Title = title;
        // The app's own per-user data folder (Electron's userData, named after the product). Tests redirect it.
        AppDataDir = Path.Combine(appDataOverride ?? Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Partcraft");
    }

    public string PackId { get; }

    public string Title { get; }

    /// <summary>The folder of settings and projects that stays on uninstall (%APPDATA%\Partcraft).</summary>
    public string AppDataDir { get; }

    public string SetupChoicesFile => Path.Combine(AppDataDir, "setup-choices.json");

    /// <summary>Velopack's default program folder: %LOCALAPPDATA%\&lt;packId&gt;.</summary>
    public string DefaultInstallDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), PackId);

    public string DesktopShortcut => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Title + ".lnk");

    public string StartMenuShortcut => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Title + ".lnk");

    /// <summary>The installation Velopack registered for this app id (HKCU), or null when there is none or its program folder is gone.</summary>
    public InstalledApp? FindInstalled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey($@"{UninstallKey}\{PackId}");
            if (key?.GetValue("InstallLocation") is not string location || location.Length == 0) return null;
            var updater = Path.Combine(location, "Update.exe");
            if (!File.Exists(updater)) return null;
            return new InstalledApp(location, updater, key.GetValue("DisplayVersion") as string ?? string.Empty);
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            return null;
        }
    }

    /// <summary>True while Velopack's uninstall entry for this app id exists (HKCU).</summary>
    public bool HasUninstallEntry()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey($@"{UninstallKey}\{PackId}");
            return key is not null;
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            return false;
        }
    }

    /// <summary>
    /// Whether a folder may become the program folder. Velopack empties the folder it installs into (an existing one is renamed away and
    /// replaced), so a mistyped drive, user or system folder must never get that far: only a folder of its own qualifies - one that is
    /// missing, empty, or already a Velopack installation of this app.
    /// </summary>
    public static bool IsSafeProgramFolder(string folder)
    {
        if (string.IsNullOrWhiteSpace(folder) || !Path.IsPathFullyQualified(folder)) return false;
        // Characters Windows does not allow in a path (quotes, angle brackets, pipes, wildcards, control characters) would make the installer
        // fail halfway; Path.GetInvalidPathChars() lists only some of them on current .NET
        if (folder.Any(ch => ch < ' ' || "\"<>|?*".Contains(ch)) || folder.IndexOf(':', 2) >= 0) return false;
        string full;
        try { full = Path.GetFullPath(folder).TrimEnd('\\', '/'); }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException) { return false; }
        if (!Path.IsPathFullyQualified(full)) return false;
        var root = Path.GetPathRoot(full)?.TrimEnd('\\', '/') ?? string.Empty;
        if (full.Length <= root.Length + 1) return false;

        var forbidden = new[]
        {
            Environment.SpecialFolder.UserProfile, Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolder.ApplicationData,
            Environment.SpecialFolder.Desktop, Environment.SpecialFolder.MyDocuments, Environment.SpecialFolder.Windows,
            Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.System,
            Environment.SpecialFolder.Programs, Environment.SpecialFolder.MyPictures, Environment.SpecialFolder.MyMusic,
            Environment.SpecialFolder.MyVideos, Environment.SpecialFolder.CommonApplicationData,
        };
        foreach (var special in forbidden)
        {
            var path = Environment.GetFolderPath(special);
            if (path.Length > 0 && SamePath(path, full)) return false;
        }
        var downloads = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        var localPrograms = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs");
        return !SamePath(localPrograms, full) && !SamePath(downloads, full);
    }

    /// <summary>True when the folder holds a Velopack installation (Update.exe next to a current or packages folder).</summary>
    public static bool IsVelopackFolder(string folder) =>
        File.Exists(Path.Combine(folder, "Update.exe")) && (Directory.Exists(Path.Combine(folder, "current")) || Directory.Exists(Path.Combine(folder, "packages")));

    private static bool SamePath(string a, string b) =>
        string.Equals(Path.GetFullPath(a).TrimEnd('\\', '/'), Path.GetFullPath(b).TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase);
}

/// <summary>An installation found through Velopack's uninstall entry.</summary>
internal sealed record InstalledApp(string Folder, string Updater, string Version);
