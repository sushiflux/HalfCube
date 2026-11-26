using Partcraft.Setup.Localization;

namespace Partcraft.Setup;

/// <summary>Every text of the setup and the uninstaller, German and English side by side.</summary>
internal static class SetupTexts
{
    public static readonly Msg WindowTitle = new("Partcraft installieren", "Install Partcraft");
    public static readonly Msg SideInstall = new("Installation", "Setup");
    public static readonly Msg SideUpdate = new("Aktualisierung", "Update");

    public static readonly Msg StepWelcome = new("Willkommen", "Welcome");
    public static readonly Msg StepLicence = new("Lizenz", "Licence");
    public static readonly Msg StepLocation = new("Ort", "Location");
    public static readonly Msg StepInstall = new("Installieren", "Installing");
    public static readonly Msg StepDone = new("Fertig", "Done");

    public static readonly Msg Install = new("Installieren", "Install");
    public static readonly Msg Update = new("Aktualisieren", "Update");
    public static readonly Msg StartNow = new("Partcraft starten", "Start Partcraft");
    public static readonly Msg Uninstall = new("Deinstallieren", "Uninstall");

    // ---- welcome -------------------------------------------------------------------------------------------------------------
    public static readonly Msg WelcomeKicker = new("Willkommen", "Welcome");
    public static readonly Msg WelcomeTitle = new("Willkommen bei Partcraft", "Welcome to Partcraft");
    public static readonly Msg WelcomeSubtitle = new(
        "Parametrisches CAD für Windows: erst skizzieren, dann Körper bauen. Wähle deine Sprache.",
        "Parametric CAD for Windows: sketch first, then build solid bodies. Choose your language.");
    public static readonly Msg UpdateTitle = new("Partcraft aktualisieren", "Update Partcraft");
    public static Msg UpdateSubtitle(string installed) => new(
        $"Partcraft {installed} ist schon installiert und wird ersetzt. Deine Projekte und Einstellungen bleiben erhalten. Wähle deine Sprache.",
        $"Partcraft {installed} is already installed and will be replaced. Your projects and settings are kept. Choose your language.");
    public static readonly Msg GermanText = new("Programm und Handbuch auf Deutsch.", "Programm und Handbuch auf Deutsch.");
    public static readonly Msg EnglishText = new("Program and manual in English.", "Program and manual in English.");
    public static readonly Msg FeatureSketch = new("Skizzen mit Bedingungen und Maßen", "Sketches with constraints and dimensions");
    public static readonly Msg FeatureTimeline = new("Zeitleiste: jeder Schritt bleibt änderbar", "Timeline: every step stays editable");
    public static readonly Msg FeatureFree = new("Kostenlos nutzbar, quelloffen, ohne Konto", "Free to use, source-available, no account");

    // ---- licence -------------------------------------------------------------------------------------------------------------
    public static readonly Msg LicenceKicker = new("Lizenz", "Licence");
    public static readonly Msg LicenceTitle = new("Quelloffene Software", "Source-available software");
    public static readonly Msg LicenceSubtitle = new(
        "Partcraft wird unter der PolyForm Shield License 1.0.0 bereitgestellt. Sie erlaubt die kostenlose Nutzung, privat und geschäftlich, sowie Änderungen für den eigenen Gebrauch. Ausgenommen ist das Anbieten von Produkten, die mit Partcraft im Wettbewerb stehen. Ohne Gewährleistung.",
        "Partcraft is provided under the PolyForm Shield License 1.0.0. It permits free use, private and commercial, and changes for your own use. Offering products that compete with Partcraft is excluded. No warranty.");
    public static readonly Msg LicenceSource = new(
        "Quellcode: github.com/sushiflux/Partcraft · der Lizenztext ist das englische Original des PolyForm Project (polyformproject.org).",
        "Source code: github.com/sushiflux/Partcraft · the licence text is the original published by the PolyForm Project (polyformproject.org).");
    public static readonly Msg LicenceAgree = new("Ich stimme den Lizenzbedingungen zu", "I agree to the licence terms");
    public static readonly Msg LicenceAgreeHint = new("Bitte stimme den Lizenzbedingungen zu, um fortzufahren.", "Please agree to the licence terms to continue.");
    // Heading of the second section in the licence box (the NOTICE file: Required Notice, LGPL permission, OCCT notice, history)
    public static readonly Msg NoticeHeading = new("Hinweise (Datei NOTICE, englisches Original)", "Notices (file NOTICE)");
    public static readonly Msg LicenceMissing = new(
        "Der Lizenztext fehlt im Installationspaket (PC-SETUP-005). Bitte die Installationsdatei erneut herunterladen.",
        "The licence text is missing from the setup package (PC-SETUP-005). Please download the setup file again.");
    public static readonly Msg LibOcct = new("Open CASCADE", "Open CASCADE");
    public static readonly Msg LibOcctLicence = new("LGPL-2.1 mit Ausnahme", "LGPL-2.1 with exception");
    public static readonly Msg LibPlanegcs = new("planegcs", "planegcs");
    public static readonly Msg LibPlanegcsLicence = new("LGPL", "LGPL");
    public static readonly Msg LibEigen = new("Eigen", "Eigen");
    public static readonly Msg LibEigenLicence = new("MPL-2.0", "MPL-2.0");

    // ---- location ------------------------------------------------------------------------------------------------------------
    public static readonly Msg LocationKicker = new("Ort", "Location");
    public static readonly Msg LocationTitle = new("Wohin kommt Partcraft?", "Where does Partcraft go?");
    public static readonly Msg LocationSubtitle = new(
        "Nur für dich installiert – ohne Administratorrechte.",
        "Installed just for you – no administrator rights.");
    public static readonly Msg LocationUpdateSubtitle = new(
        "Der bisherige Programmordner wird durch die neue Version ersetzt.",
        "The previous program folder is replaced by the new version.");
    public static readonly Msg ProgramFolder = new("Programmordner", "Program folder");
    public static readonly Msg ChangeFolder = new("Ändern …", "Change …");
    public static readonly Msg StartMenuTitle = new("Eintrag im Startmenü", "Start menu entry");
    public static readonly Msg DesktopTitle = new("Verknüpfung auf dem Desktop", "Desktop shortcut");
    public static readonly Msg DataNote = new(
        "Deine Projekte und Einstellungen liegen getrennt vom Programm und bleiben bei Updates und beim Deinstallieren erhalten.",
        "Your projects and settings are kept apart from the program and stay on updates and uninstall.");
    public static Msg FolderSpace(string needed, string free) => new(
        $"Benötigt etwa {needed}, frei sind {free}",
        $"Needs about {needed}, {free} free");
    public static Msg FolderUnsafe(string path) => new(
        $"„{path}“ kann nicht der Programmordner sein (Laufwerk, Benutzer- oder Systemordner). Bitte einen eigenen Unterordner wählen, z. B. …\\Partcraft.",
        $"“{path}” cannot be the program folder (a drive, user or system folder). Please choose a folder of its own, e.g. …\\Partcraft.");
    public static Msg FolderNotEmpty(string path) => new(
        $"Im Ordner „{path}“ liegen schon andere Dateien. Bitte einen leeren Ordner oder einen neuen Unterordner wählen.",
        $"The folder “{path}” already contains other files. Please choose an empty folder or a new subfolder.");

    // ---- installing ----------------------------------------------------------------------------------------------------------
    public static readonly Msg InstallKicker = new("Installation", "Installing");
    public static readonly Msg InstallTitle = new("Partcraft wird installiert", "Installing Partcraft");
    public static readonly Msg UpdatingTitle = new("Partcraft wird aktualisiert", "Updating Partcraft");
    public static readonly Msg InstallSubtitle = new("Das dauert meist weniger als eine Minute.", "This usually takes less than a minute.");
    public static readonly Msg FailedTitle = new("Installation unterbrochen", "Setup interrupted");
    public static readonly Msg FailedSubtitle = new("Der Grund steht unten vollständig.", "The full reason is shown below.");
    public static readonly Msg MeasuredHint = new("Fortschritt gemessen am Zielordner", "Progress measured on the target folder");

    // Each task has the wording while it runs and the wording once it is done
    public static readonly Msg TaskPrepare = new("Voraussetzungen werden geprüft", "Checking requirements");
    public static readonly Msg TaskPrepareDone = new("Voraussetzungen geprüft", "Requirements checked");
    public static readonly Msg TaskPackage = new("Paket wird vorbereitet", "Preparing the package");
    public static readonly Msg TaskPackageDone = new("Paket vorbereitet", "Package prepared");
    public static readonly Msg TaskFiles = new("Programmdateien werden entpackt", "Extracting program files");
    public static readonly Msg TaskFilesDone = new("Programmdateien entpackt", "Program files extracted");
    public static readonly Msg TaskShortcuts = new("Verknüpfungen werden angelegt", "Creating shortcuts");
    public static readonly Msg TaskShortcutsDone = new("Verknüpfungen angelegt", "Shortcuts created");
    public static readonly Msg TaskFinish = new("Abschließen", "Finishing");
    public static readonly Msg TaskFinishDone = new("Abgeschlossen", "Finished");

    public static Msg DetailRequirements(string windows, string free) => new($"{windows} · {free} frei", $"{windows} · {free} free");
    public static Msg DetailSize(string size) => new(size, size);
    public static Msg DetailProgress(string done, string total) => new($"{done} von {total}", $"{done} of {total}");

    public static readonly Msg CancelQuestion = new(
        "Installation abbrechen? Es wurde noch nichts installiert.",
        "Cancel setup? Nothing has been installed yet.");
    public static readonly Msg CancelYes = new("Installation abbrechen", "Cancel setup");
    public static readonly Msg CancelNo = new("Weiter installieren", "Continue setup");

    // ---- errors (complete, with a code; the window shows them in a copyable box) ---------------------------------------------
    private static Msg Fail(string code, Msg headline, Msg details) => new(
        $"{headline.De} ({code})\n\n{details.De}",
        $"{headline.En} ({code})\n\n{details.En}");

    public static Msg ErrElevated() => Fail("PC-SETUP-001",
        new("Das Setup läuft mit Administratorrechten", "Setup is running with administrator rights"),
        new("Partcraft wird nur für dich installiert. Als Administrator landeten Programm und Einstellungen womöglich im Konto des Administrators statt in deinem. Bitte die Installationsdatei normal per Doppelklick starten (nicht „Als Administrator ausführen“).",
            "Partcraft is installed just for you. As administrator, program and settings could end up in the administrator's account instead of yours. Please start the setup file normally with a double-click (not “Run as administrator”)."));

    public static Msg ErrFolderUnsafe(string path) => Fail("PC-SETUP-002",
        new("Dieser Ordner kann nicht der Programmordner sein", "This folder cannot be the program folder"), FolderUnsafe(path));

    public static Msg ErrFolderNotEmpty(string path) => Fail("PC-SETUP-003",
        new("Der Zielordner ist nicht leer", "The target folder is not empty"), FolderNotEmpty(path));

    public static Msg ErrNoSpace(string folder, string needed, string free) => Fail("PC-SETUP-004",
        new("Nicht genug Platz auf dem Laufwerk", "Not enough space on the drive"),
        new($"Für „{folder}“ werden etwa {needed} gebraucht, frei sind {free}. Schaffe Platz oder wähle einen anderen Ordner.",
            $"“{folder}” needs about {needed}, {free} free. Free some space or choose another folder."));

    public static Msg ErrPayloadBroken(string what) => Fail("PC-SETUP-005",
        new("Die Installationsdatei ist beschädigt", "The setup file is damaged"),
        new($"Die Datei ist unvollständig heruntergeladen oder verändert worden ({what}). Bitte erneut herunterladen.",
            $"The file was not downloaded completely or was changed ({what}). Please download it again."));

    public static Msg ErrExtractFailed(string folder, string reason) => Fail("PC-SETUP-006",
        new("Das Installationspaket ließ sich nicht entpacken", "The installation package could not be extracted"),
        new($"Der Zwischenordner „{folder}“ ließ sich nicht beschreiben: {reason} Ein Virenschutz kann die Datei gerade prüfen: kurz warten und erneut versuchen.",
            $"The temporary folder “{folder}” could not be written: {reason} A virus scanner may be checking the file: wait a moment and try again."));

    public static Msg ErrVelopackFailed(int exitCode, string logFile, string logTail) => Fail("PC-SETUP-007",
        new("Programmdateien konnten nicht installiert werden", "The program files could not be installed"),
        new($"Das Installationsprogramm (Velopack) endete mit Code {exitCode}. Häufige Ursache: Ein anderes Programm hält Dateien im Zielordner fest, zum Beispiel ein Virenschutz. Warte einen Moment und versuche es erneut. Deine Projekte sind nicht betroffen.\n\nProtokoll ({logFile}):\n{logTail}",
            $"The installer (Velopack) ended with code {exitCode}. Common cause: another program holds files in the target folder, for example a virus scanner. Wait a moment and try again. Your projects are not affected.\n\nLog ({logFile}):\n{logTail}"));

    public static Msg ErrVelopackTimeout(int minutes) => Fail("PC-SETUP-008",
        new("Die Installation brauchte zu lange", "The installation took too long"),
        new($"Das Installationsprogramm war nach {minutes} Minuten nicht fertig und wurde beendet. Der Zielordner kann unvollständig sein; ein neuer Versuch ersetzt ihn.",
            $"The installer was not finished after {minutes} minutes and was stopped. The target folder may be incomplete; a new attempt replaces it."));

    public static Msg ErrMainExeMissing(string path) => Fail("PC-SETUP-009",
        new("Das Programm fehlt nach der Installation", "The program is missing after installation"),
        new($"Die Datei „{path}“ wurde nicht angelegt. Ein Virenschutz kann sie entfernt haben. Prüfe dessen Meldungen und versuche es erneut.",
            $"The file “{path}” was not created. A virus scanner may have removed it. Check its messages and try again."));

    public static Msg ErrStartFailed(string reason) => Fail("PC-SETUP-010",
        new("Das Installationsprogramm ließ sich nicht starten", "The installer could not be started"),
        new($"{reason} Ein Virenschutz kann den Start verhindern. Bitte erneut versuchen.",
            $"{reason} A virus scanner may be blocking it. Please try again."));

    // ---- done ----------------------------------------------------------------------------------------------------------------
    public static readonly Msg DoneKicker = new("Geschafft", "All set");
    public static readonly Msg DoneTitle = new("Partcraft ist bereit", "Partcraft is ready");
    public static readonly Msg DoneUpdatedTitle = new("Partcraft ist aktuell", "Partcraft is up to date");
    public static readonly Msg DoneSubtitle = new(
        "Beim ersten Start zeigt dir Partcraft in einer kurzen Tour, wo alles ist.",
        "On the first start a short tour shows you where everything is.");
    public static readonly Msg TipSearchTitle = new("Jeder Befehl mit S", "Every command with S");
    public static readonly Msg TipSearchText = new("Die Befehlssuche findet jedes Werkzeug beim Namen.", "The command search finds every tool by name.");
    public static readonly Msg TipLookTitle = new("Farben und Linien nach deinem Geschmack", "Colours and lines your way");
    public static readonly Msg TipLookText = new("Sieben Farbthemen und jede Linienfarbe im Einstellungsdialog.", "Seven colour themes and every line colour in the settings dialog.");
    public static readonly Msg TipEarlyTitle = new("Frühphase", "Early access");
    public static readonly Msg TipEarlyText = new("Vieles kommt noch. Fehler und Wünsche gern auf GitHub.", "Much is still to come. Bugs and wishes are welcome on GitHub.");
}

/// <summary>The texts of the uninstall window.</summary>
internal static class UninstallTexts
{
    public static readonly Msg WindowTitle = new("Partcraft deinstallieren", "Uninstall Partcraft");
    public static readonly Msg Side = new("Deinstallation", "Uninstall");

    public static readonly Msg StepConfirm = new("Bestätigen", "Confirm");
    public static readonly Msg StepRemove = new("Entfernen", "Removing");
    public static readonly Msg StepDone = new("Fertig", "Done");

    public static readonly Msg ConfirmKicker = new("Deinstallation", "Uninstall");
    public static readonly Msg ConfirmTitle = new("Partcraft deinstallieren?", "Uninstall Partcraft?");
    public static readonly Msg ConfirmSubtitle = new(
        "Das Programm wird von diesem PC entfernt. Das lässt sich nicht rückgängig machen, du kannst Partcraft aber jederzeit neu installieren.",
        "The program is removed from this PC. This cannot be undone, but you can reinstall Partcraft at any time.");
    public static readonly Msg RemovedTitle = new("Wird entfernt", "Removed");
    public static Msg RemovedText(string size) => new(
        $"Das Programm ({size}), der Eintrag im Startmenü und die Verknüpfung auf dem Desktop",
        $"The program ({size}), the start menu entry and the desktop shortcut");
    public static readonly Msg KeptTitle = new("Bleibt erhalten", "Kept");
    public static readonly Msg KeptText = new(
        "Deine Projekte (.pcraft) und deine Einstellungen. Nach einer neuen Installation ist alles wie vorher.",
        "Your projects (.pcraft) and your settings. After a new installation everything is as before.");
    public static readonly Msg ButtonUninstall = new("Deinstallieren", "Uninstall");

    public static readonly Msg RemoveKicker = new("Deinstallation", "Uninstall");
    public static readonly Msg RemoveTitle = new("Partcraft wird entfernt", "Removing Partcraft");
    public static readonly Msg RemoveSubtitle = new("Deine Projekte und Einstellungen bleiben erhalten.", "Your projects and settings are kept.");
    public static readonly Msg TaskStop = new("Partcraft wird beendet", "Closing Partcraft");
    public static readonly Msg TaskStopDone = new("Partcraft beendet", "Partcraft closed");
    public static readonly Msg TaskFiles = new("Programmdateien werden entfernt", "Removing program files");
    public static readonly Msg TaskFilesDone = new("Programmdateien entfernt", "Program files removed");
    public static readonly Msg TaskShortcuts = new("Verknüpfungen werden entfernt", "Removing shortcuts");
    public static readonly Msg TaskShortcutsDone = new("Verknüpfungen entfernt", "Shortcuts removed");

    public static readonly Msg DoneKicker = new("Fertig", "Done");
    public static readonly Msg DoneTitle = new("Partcraft wurde entfernt", "Partcraft was removed");
    public static readonly Msg DoneSubtitle = new("Danke, dass du Partcraft ausprobiert hast.", "Thank you for trying Partcraft.");
    public static readonly Msg StillThereTitle = new("Noch da", "Still there");
    public static readonly Msg StillThereText = new(
        "Deine Projekte (.pcraft) und deine Einstellungen. Wenn du Partcraft wieder installierst, ist alles wie vorher.",
        "Your projects (.pcraft) and your settings. If you install Partcraft again, everything is as before.");
    public static readonly Msg FailedTitle = new("Deinstallation unterbrochen", "Uninstall interrupted");
    public static readonly Msg FailedSubtitle = new("Der Grund steht unten vollständig.", "The full reason is shown below.");

    private static Msg Fail(string code, Msg headline, Msg details) => new(
        $"{headline.De} ({code})\n\n{details.De}",
        $"{headline.En} ({code})\n\n{details.En}");

    public static Msg ErrNotFound() => Fail("PC-UNINST-001",
        new("Partcraft ist nicht installiert", "Partcraft is not installed"),
        new("Es wurde keine Installation gefunden, die sich entfernen ließe.", "No installation was found that could be removed."));

    public static Msg ErrStartFailed(string reason) => Fail("PC-UNINST-002",
        new("Das Deinstallationsprogramm ließ sich nicht starten", "The uninstaller could not be started"),
        new(reason, reason));

    public static Msg ErrFailed(int exitCode, string folder, string logFile, string logTail) => Fail("PC-UNINST-003",
        new("Partcraft konnte nicht vollständig entfernt werden", "Partcraft could not be removed completely"),
        new($"Das Deinstallationsprogramm (Velopack) endete mit Code {exitCode}. Der Programmordner „{folder}“ kann teilweise noch vorhanden sein. Beende Partcraft und versuche es erneut. Deine Projekte und Einstellungen sind nicht betroffen.\n\nProtokoll ({logFile}):\n{logTail}",
            $"The uninstaller (Velopack) ended with code {exitCode}. The program folder “{folder}” may still be partly there. Close Partcraft and try again. Your projects and settings are not affected.\n\nLog ({logFile}):\n{logTail}"));

    public static Msg ErrLeftover(string folder) => Fail("PC-UNINST-004",
        new("Der Programmordner ist noch vorhanden", "The program folder is still there"),
        new($"Der Ordner „{folder}“ wurde nach der Deinstallation nicht entfernt, vermutlich hält ihn ein anderes Programm fest. Er lässt sich nach einem Neustart von Hand löschen. Deine Projekte und Einstellungen sind nicht betroffen.",
            $"The folder “{folder}” was not removed after uninstalling, probably because another program holds it. It can be deleted by hand after a restart. Your projects and settings are not affected."));
}
