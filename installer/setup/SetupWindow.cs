using System.Text.RegularExpressions;
using Partcraft.Setup.Localization;
using Partcraft.Setup.Ui;

namespace Partcraft.Setup;

/// <summary>
/// The designed setup (mockup variant B): Welcome (with the language) → Licence → Location → Installing (real progress) → Done. Every
/// message has its room from the start (rigid layout); errors are shown completely in a scrolling, copyable slot. When Partcraft is
/// installed already the setup says so, replaces it (projects and settings stay) and offers the uninstaller on the first page.
/// </summary>
internal sealed partial class SetupWindow : WizardWindow
{
    private readonly SetupState _state;
    private readonly Func<InstallRequest, IProgress<InstallProgress>, Task> _install;
    private readonly InstallingPage _installing;
    private readonly LocationPage _location;
    private bool _running;

    public SetupWindow(SetupState state, Func<InstallRequest, IProgress<InstallProgress>, Task> install, float? forcedScale = null)
        : this(state, install, BuildPages(state), forcedScale)
    {
    }

    private SetupWindow(SetupState state, Func<InstallRequest, IProgress<InstallProgress>, Task> install, IReadOnlyList<WizardPage> pages, float? forcedScale)
        : base(SetupTexts.WindowTitle, state.IsUpdate ? SetupTexts.SideUpdate : SetupTexts.SideInstall, state.Info.DisplayVersion, pages, forcedScale)
    {
        _state = state;
        _install = install;
        _location = pages.OfType<LocationPage>().Single();
        _installing = pages.OfType<InstallingPage>().Single();
        _location.Changed = UpdateButtons;

        Next.Click += async (_, _) => await OnNextAsync();
        Back.Click += (_, _) => OnBack();
        Cancel.Click += (_, _) => OnCancel();
        StepChanged += (_, _) => UpdateButtons();
        GoTo(0);
    }

    private static IReadOnlyList<WizardPage> BuildPages(SetupState state) =>
        [new WelcomePage(state), new LicencePage(state), new LocationPage(state), new InstallingPage(state), new DonePage(state)];

    /// <summary>The user wants Partcraft started after "Start Partcraft".</summary>
    public bool LaunchAfterFinish { get; private set; }

    /// <summary>The overall progress last reported (0..1); the GUI self-test watches it.</summary>
    public float CurrentProgress => _installing.LastValue;

    /// <summary>The user chose "Uninstall …" on the first page: the program closes this window and opens the uninstaller.</summary>
    public bool UninstallRequested { get; private set; }

    protected override void LanguageChanged() => UpdateButtons();

    private int InstallingIndex => 3;

    private void UpdateButtons()
    {
        var page = CurrentPage;
        Back.Text = CommonTexts.Back;
        Cancel.Text = CommonTexts.Cancel;
        var back = StepIndex > 0 && page is not InstallingPage and not DonePage;
        var cancel = page is not InstallingPage and not DonePage;
        Cancel.Kind = PcButtonKind.Ghost;
        Next.Kind = PcButtonKind.Primary;
        Next.Glyph = null;
        Next.Visible = true;
        Hint.Text = string.Empty;
        Failed = false;
        switch (page)
        {
            case WelcomePage:
                Next.Text = CommonTexts.Next;
                Next.Enabled = true;
                if (_state.IsUpdate)
                {
                    // The first page has no "Back": that place offers the uninstaller of the installation that was found
                    back = true;
                    Back.Text = SetupTexts.Uninstall;
                }
                break;
            case LicencePage:
                Next.Text = CommonTexts.Next;
                // The GPL is not a contract to accept (using Partcraft needs no consent); only a broken package stops here
                Next.Enabled = _state.LicenceText is not null;
                break;
            case LocationPage:
                Next.Text = _state.IsUpdate ? SetupTexts.Update : SetupTexts.Install;
                Next.Enabled = _location.Problem is null;
                break;
            case InstallingPage:
                Failed = _state.Failed;
                if (_state.Failed)
                {
                    back = true;
                    Back.Text = CommonTexts.Back;
                    Next.Text = CommonTexts.Retry;
                    Next.Glyph = Glyphs.Retry;
                    Next.Enabled = !_running;
                }
                else
                {
                    // While it runs there is nothing to press: the disabled "Next" and a note on how the progress is measured
                    Next.Text = CommonTexts.Next;
                    Next.Enabled = false;
                    Hint.Text = SetupTexts.MeasuredHint;
                }
                break;
            case DonePage:
                cancel = true;
                Cancel.Kind = PcButtonKind.Secondary;
                Cancel.Text = CommonTexts.Close;
                Next.Text = SetupTexts.StartNow;
                Next.Glyph = Glyphs.Play;
                Next.Enabled = true;
                break;
        }
        ShowFooterButtons(back, cancel);
        Back.Invalidate();
        Next.Invalidate();
        Cancel.Invalidate();
        Hint.Invalidate();
        Invalidate();
    }

    private void OnBack()
    {
        if (CurrentPage is WelcomePage)
        {
            UninstallRequested = true;
            Close();
            return;
        }
        // After a failure "Back" returns to the location page
        GoTo(CurrentPage is InstallingPage ? InstallingIndex - 1 : StepIndex - 1);
    }

    private void OnCancel()
    {
        if (CurrentPage is DonePage) Close();
        else OnCloseRequested();
    }

    private async Task OnNextAsync()
    {
        switch (CurrentPage)
        {
            case DonePage:
                LaunchAfterFinish = true;
                Close();
                return;
            case InstallingPage when _state.Failed:
                await RunInstallAsync();
                return;
            case LocationPage:
                GoTo(InstallingIndex);
                await RunInstallAsync();
                return;
            default:
                GoTo(StepIndex + 1);
                return;
        }
    }

    /// <summary>Runs the installation with the window's choices (also the headless/test path).</summary>
    public async Task RunInstallAsync()
    {
        _running = true;
        _state.Failed = false;
        _state.Error = null;
        _installing.Reset();
        RebuildPage();
        UpdateButtons();
        var progress = new Progress<InstallProgress>(p => _installing.Report(p));
        try
        {
            await _install(_state.Request(), progress);
            _state.Succeeded = true;
            _running = false;
            GoTo(InstallingIndex + 1);
        }
        catch (InstallException ex)
        {
            Fail(ex.Text);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException or OperationCanceledException)
        {
            Fail(new Msg(ex.Message, ex.Message));
        }
        UpdateButtons();
    }

    private void Fail(Msg error)
    {
        _state.Failed = true;
        _state.Error = error;
        _running = false;
        RebuildPage();
    }

    protected override void OnCloseRequested()
    {
        if (_running) return; // the installer underneath is not interrupted halfway
        if (_state.Succeeded || _state.Failed || Headless)
        {
            Close();
            return;
        }
        var answer = Dialogs.Show(this, DialogKind.Question, SetupTexts.CancelQuestion,
            [new DialogButton(SetupTexts.CancelYes, DialogResult.Yes), new DialogButton(SetupTexts.CancelNo, DialogResult.No, PcButtonKind.Primary)],
            DialogResult.No, focusIndex: 1);
        if (answer == DialogResult.Yes) Close();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (_running && e.CloseReason == CloseReason.UserClosing) e.Cancel = true;
        base.OnFormClosing(e);
    }

    /// <summary>Every state of every page, for the offscreen pictures of the layout check.</summary>
    public IEnumerable<(string Name, Action Show)> TestStates()
    {
        var original = _state.InstallDir;
        yield return ("welcome", () => { GoTo(0); UpdateButtons(); });
        yield return ("licence", () => { GoTo(1); UpdateButtons(); });
        yield return ("location", () => { GoTo(2); UpdateButtons(); });
        if (!_state.IsUpdate)
        {
            yield return ("location-unsafe-folder", () => { _location.SetFolder(@"C:\"); GoTo(2); UpdateButtons(); });
            yield return ("location-long-path", () => { _location.SetFolder(@"C:\Users\Beispielbenutzer\AppData\Local\Programs\Partcraft\VeryLongFolderNameForTheLayoutCheck\AnotherLongSubfolder\Partcraft"); GoTo(2); UpdateButtons(); });
            yield return ("location-ok", () => { _location.SetFolder(original); GoTo(2); UpdateButtons(); });
        }
        yield return ("installing", () =>
        {
            GoTo(InstallingIndex);
            _running = true;
            _installing.Reset();
            _installing.Report(new InstallProgress(0.14f, InstallTask.Prepare));
            _installing.Report(new InstallProgress(0.62f, InstallTask.Files, SetupTexts.DetailProgress("298", "480 MB")));
            UpdateButtons();
        });
        yield return ("failed", () =>
        {
            _running = false;
            _state.Failed = true;
            _state.Error = SetupTexts.ErrVelopackFailed(1, @"C:\Users\Name\AppData\Local\Temp\Partcraft-Setup-0f3a\velopack-setup.log",
                string.Join('\n', Enumerable.Repeat("[12:04:11] [ERROR] An error has occurred: Unable to write file C:\\Users\\Name\\AppData\\Local\\Partcraft\\current\\resources\\engine\\partcraft-engine.exe: access denied", 4)));
            GoTo(InstallingIndex);
            UpdateButtons();
        });
        // The same page after a click on "Copy": the status slot fills, nothing else may move (compared by the layout check)
        yield return ("failed-copied", () => Controls.Find("btnCopyInstallError", true).OfType<PcButton>().Single().PerformClick());
        yield return ("failed-copy-not-possible", () =>
        {
            var status = Controls.Find("lblCopyStatusInstallError", true).OfType<PcText>().Single();
            status.Color = p => p.Danger;
            status.Text = CommonTexts.CopyFailed;
        });
        yield return ("done", () =>
        {
            _state.Failed = false;
            _state.Succeeded = true;
            GoTo(InstallingIndex + 1);
            UpdateButtons();
        });
    }

    // ---- pages -------------------------------------------------------------------------------------------------------------------

    private sealed class WelcomePage(SetupState state) : WizardPage
    {
        public override Msg StepLabel => SetupTexts.StepWelcome;
        public override Msg Kicker => state.IsUpdate ? SetupTexts.SideUpdate : SetupTexts.WelcomeKicker;
        public override Msg Title => state.IsUpdate ? SetupTexts.UpdateTitle : SetupTexts.WelcomeTitle;
        public override Msg Subtitle => state.IsUpdate ? SetupTexts.UpdateSubtitle(state.InstalledVersion!) : SetupTexts.WelcomeSubtitle;

        public override void Build(PageCanvas c)
        {
            var german = c.Add(new PcChoice { Text = "Deutsch", Description = SetupTexts.GermanText.De, Badge = "DE", Selected = UiLang.Current == UiLang.German }, 0, 0, PageCanvas.Width, 68, "choiceGerman");
            var english = c.Add(new PcChoice { Text = "English", Description = SetupTexts.EnglishText.En, Badge = "EN", Selected = UiLang.Current == UiLang.English }, 0, 78, PageCanvas.Width, 68, "choiceEnglish");
            // Switching re-renders the whole window in the chosen language at once
            german.Click += (_, _) => UiLang.Current = UiLang.German;
            english.Click += (_, _) => UiLang.Current = UiLang.English;

            var y = 170;
            c.Add(new PcFeature { Text = SetupTexts.FeatureSketch, Icon = Glyphs.Sketch, Compact = true }, 0, y, PageCanvas.Width, 28, "featureSketch");
            c.Add(new PcFeature { Text = SetupTexts.FeatureTimeline, Icon = Glyphs.Timeline, Compact = true }, 0, y + 34, PageCanvas.Width, 28, "featureTimeline");
            c.Add(new PcFeature { Text = SetupTexts.FeatureFree, Icon = Glyphs.Branch, Compact = true }, 0, y + 68, PageCanvas.Width, 28, "featureFree");
        }
    }

    private sealed class LicencePage(SetupState state) : WizardPage
    {
        public override Msg StepLabel => SetupTexts.StepLicence;
        public override Msg Kicker => SetupTexts.LicenceKicker;
        public override Msg Title => SetupTexts.LicenceTitle;
        public override Msg Subtitle => SetupTexts.LicenceSubtitle;

        public override void Build(PageCanvas c)
        {
            // The official GNU GPL v3 text (English only, like every official GNU licence text). Nothing to tick: the licence grants
            // rights and needs no consent to use the program
            var box = c.Add(new PcScrollText { Framed = true, Points = 8.8f }, 0, 0, PageCanvas.Width, 150, "txtLicence");
            if (state.LicenceText is { } text) box.SetText(LicenceForDisplay(text), p => p.Text);
            else box.SetText(SetupTexts.LicenceMissing, p => p.Danger);
            c.Text(SetupTexts.LicenceSource, 0, 160, PageCanvas.Width, 38, 9.5f, color: p => p.Muted, name: "lblLicenceSource");
            var width = (PageCanvas.Width - 20) / 3;
            c.Add(new LibraryCard { Text = SetupTexts.LibOcct, Licence = SetupTexts.LibOcctLicence }, 0, 206, width, 52, "libOcct");
            c.Add(new LibraryCard { Text = SetupTexts.LibPlanegcs, Licence = SetupTexts.LibPlanegcsLicence }, width + 10, 206, width, 52, "libPlanegcs");
            c.Add(new LibraryCard { Text = SetupTexts.LibEigen, Licence = SetupTexts.LibEigenLicence }, 2 * (width + 10), 206, width, 52, "libEigen");
        }
    }

    /// <summary>A small bordered card with a library's name and its licence (the licence page's third-party row).</summary>
    private sealed class LibraryCard : PcControl
    {
        public string Licence { get; set; } = string.Empty;

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            Draw.Smooth(g);
            var card = new RectangleF(U(0.5f), U(0.5f), Width - U(1), Height - U(1));
            Draw.FillRounded(g, card, U(6), P.Surface);
            Draw.StrokeRounded(g, card, U(6), P.Border, Math.Max(1f, U(1)));
            Draw.Text(g, Text, Fonts.Get(10f, S, FontStyle.Bold), P.Text, new Rectangle((int)U(12), (int)U(8), Width - (int)U(24), (int)U(20)));
            Draw.Text(g, Licence, Fonts.Get(9f, S), P.Muted, new Rectangle((int)U(12), (int)U(28), Width - (int)U(24), (int)U(18)));
        }
    }

    private sealed class LocationPage(SetupState state) : WizardPage
    {
        private PcScrollText? _path;
        private PcScrollText? _problemText;
        private SpaceBar? _space;

        public Action? Changed { get; set; }

        public Msg? Problem { get; private set; } = Check(state, state.InstallDir);

        public override Msg StepLabel => SetupTexts.StepLocation;
        public override Msg Kicker => SetupTexts.LocationKicker;
        public override Msg Title => SetupTexts.LocationTitle;
        public override Msg Subtitle => state.IsUpdate ? SetupTexts.LocationUpdateSubtitle : SetupTexts.LocationSubtitle;

        private static Msg? Check(SetupState s, string folder)
        {
            if (!SetupLayout.IsSafeProgramFolder(folder)) return SetupTexts.FolderUnsafe(folder);
            if (Directory.Exists(folder) && Directory.EnumerateFileSystemEntries(folder).Any() && !SetupLayout.IsVelopackFolder(folder))
                return SetupTexts.FolderNotEmpty(folder);
            return null;
        }

        public void SetFolder(string folder)
        {
            state.InstallDir = folder;
            Problem = Check(state, folder);
            _path?.SetText(folder, p => p.Text);
            _problemText?.SetText(ProblemText(), p => Problem is null ? p.Muted : p.Danger);
            _space?.Set(Problem is null ? Needed : 0, Problem is null ? InstallEngine.FreeSpace(folder) ?? 0 : 0);
            Changed?.Invoke();
        }

        private long Needed => state.Info.InstalledBytes + 100L * 1024 * 1024;

        private string ProblemText()
        {
            if (Problem is { } problem) return problem;
            var free = InstallEngine.FreeSpace(state.InstallDir);
            return SetupTexts.FolderSpace(InstallEngine.Size(Needed), free is { } f ? InstallEngine.Size(f) : "?");
        }

        public override void Build(PageCanvas c)
        {
            c.Add(new FolderCard(), 0, 0, PageCanvas.Width, 68, "cardFolder");
            c.Text(SetupTexts.ProgramFolder, 62, 12, 300, 18, 9f, color: p => p.Muted, name: "lblFolderTitle").Surface = c.P.Surface;
            // The whole path in a scrolling slot of two lines: a long path is never cut
            _path = c.Add(new PcScrollText { Points = 9.2f, Mono = true }, 62, 30, PageCanvas.Width - 62 - 132, 34, "lblFolder");
            _path.Surface = c.P.Surface;
            _path.SetText(state.InstallDir, p => p.Text);
            var change = c.Add(new PcButton { Text = SetupTexts.ChangeFolder, Kind = PcButtonKind.Secondary, Enabled = !state.IsUpdate }, PageCanvas.Width - 122, 15, 110, 38, "btnChangeFolder");
            change.Surface = c.P.Surface;
            change.Click += (_, _) => ChooseFolder(c.Host);
            // One reserved slot below the card: free space or what is wrong with the folder (scrolls if a path makes it long)
            _space = c.Add(new SpaceBar(), 2, 82, 120, 6, "barSpace");
            _space.Set(Problem is null ? Needed : 0, Problem is null ? InstallEngine.FreeSpace(state.InstallDir) ?? 0 : 0);
            _problemText = c.Add(new PcScrollText { Points = 9.5f }, 134, 72, PageCanvas.Width - 134, 54, "txtFolderProblem");
            _problemText.SetText(ProblemText(), p => Problem is null ? p.Muted : p.Danger);

            var menu = c.Add(new PcToggle { Text = SetupTexts.StartMenuTitle, Checked = state.StartMenu }, 0, 134, PageCanvas.Width, 46, "tglStartMenu");
            menu.CheckedChanged += (_, _) => state.StartMenu = menu.Checked;
            var desktop = c.Add(new PcToggle { Text = SetupTexts.DesktopTitle, Checked = state.DesktopShortcut }, 0, 188, PageCanvas.Width, 46, "tglDesktop");
            desktop.CheckedChanged += (_, _) => state.DesktopShortcut = desktop.Checked;

            c.Add(new NoteRow { Text = SetupTexts.DataNote }, 0, 250, PageCanvas.Width, 44, "noteData");
        }

        private void ChooseFolder(Control owner)
        {
            // The Windows folder picker is the one system dialog that stays (users expect it)
            using var dialog = new FolderBrowserDialog { InitialDirectory = Path.GetDirectoryName(state.InstallDir) ?? state.InstallDir, ShowNewFolderButton = true, UseDescriptionForTitle = true, Description = SetupTexts.ProgramFolder };
            if (dialog.ShowDialog(owner.FindForm()) != DialogResult.OK) return;
            var chosen = dialog.SelectedPath;
            // A chosen parent folder gets the program's own subfolder, so nothing is ever installed straight into "Documents" or a drive
            if (!string.Equals(Path.GetFileName(chosen.TrimEnd('\\')), "Partcraft", StringComparison.OrdinalIgnoreCase))
                chosen = Path.Combine(chosen, "Partcraft");
            SetFolder(chosen);
        }

        private sealed class FolderCard : PcControl
        {
            protected override void OnPaint(PaintEventArgs e)
            {
                var g = e.Graphics;
                Draw.Smooth(g);
                var card = new RectangleF(U(0.5f), U(0.5f), Width - U(1), Height - U(1));
                Draw.FillRounded(g, card, U(6), P.Surface);
                Draw.StrokeRounded(g, card, U(6), P.Border, Math.Max(1f, U(1)));
                Glyphs.Folder(g, new RectangleF(U(16), (Height - U(28)) / 2f, U(28), U(28)), P.Accent);
            }
        }

        /// <summary>The mockup's small bar next to the space line: the share of the drive the program needs.</summary>
        private sealed class SpaceBar : PcControl
        {
            private long _needed;
            private long _free;

            public void Set(long needed, long free)
            {
                _needed = needed;
                _free = free;
                Invalidate();
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                var g = e.Graphics;
                Draw.Smooth(g);
                var track = new RectangleF(0, 0, Width, Height);
                Draw.FillRounded(g, track, Height / 2f, P.Border);
                if (_needed <= 0 || _free <= 0) return;
                var share = Math.Clamp(_needed / (float)_free, 0.08f, 1f);
                Draw.FillRounded(g, new RectangleF(0, 0, Width * share, Height), Height / 2f, P.Accent);
            }
        }

        /// <summary>A line with the green shield and a muted note (the mockup's "your projects stay" row).</summary>
        private sealed class NoteRow : PcControl
        {
            protected override void OnPaint(PaintEventArgs e)
            {
                var g = e.Graphics;
                Draw.Smooth(g);
                Glyphs.Shield(g, new RectangleF(U(2), U(2), U(16), U(16)), P.Emerald);
                Draw.Text(g, Text, Fonts.Get(9.5f, S), P.Muted, new Rectangle((int)U(30), 0, Width - (int)U(30), Height));
            }

            public int NeededHeight => Draw.Measure(Text, Fonts.Get(9.5f, S), Width - (int)U(30)).Height;
        }
    }

    private sealed class InstallingPage(SetupState state) : WizardPage
    {
        private PcProgress? _bar;
        private PcText? _percent;
        private PcText? _amount;
        private readonly Dictionary<InstallTask, TaskRow> _rows = [];
        private readonly Dictionary<InstallTask, Msg> _details = [];
        private InstallProgress _last = new(0f, InstallTask.Prepare);

        public override Msg StepLabel => SetupTexts.StepInstall;
        public override Msg Kicker => SetupTexts.InstallKicker;
        public override Msg Title => state.Failed ? SetupTexts.FailedTitle : state.IsUpdate ? SetupTexts.UpdatingTitle : SetupTexts.InstallTitle;
        public override Msg Subtitle => state.Failed ? SetupTexts.FailedSubtitle : SetupTexts.InstallSubtitle;

        public float LastValue => _last.Value;

        public void Reset()
        {
            _last = new InstallProgress(0f, InstallTask.Prepare);
            _details.Clear();
        }

        public void Report(InstallProgress p)
        {
            _last = p;
            if (p.Detail is { } detail) _details[p.Task] = detail;
            Apply();
        }

        private void Apply()
        {
            if (_bar is not null) _bar.Value = _last.Value;
            if (_percent is not null) _percent.Text = $"{_last.Value * 100:0} %";
            if (_amount is not null) _amount.Text = _details.TryGetValue(InstallTask.Files, out var files) && _last.Task >= InstallTask.Files ? files.ToString() : string.Empty;
            foreach (var (task, row) in _rows)
            {
                row.State = task < _last.Task || _last.Value >= 1f ? RowState.Done : task == _last.Task ? RowState.Active : RowState.Pending;
                row.Detail = _details.TryGetValue(task, out var d) ? d.ToString() : string.Empty;
                row.Text = TaskText(task, row.State);
                row.Invalidate();
            }
        }

        private static string TaskText(InstallTask task, RowState rowState) => (task, rowState == RowState.Done) switch
        {
            (InstallTask.Prepare, true) => SetupTexts.TaskPrepareDone,
            (InstallTask.Prepare, false) => SetupTexts.TaskPrepare,
            (InstallTask.Package, true) => SetupTexts.TaskPackageDone,
            (InstallTask.Package, false) => SetupTexts.TaskPackage,
            (InstallTask.Files, true) => SetupTexts.TaskFilesDone,
            (InstallTask.Files, false) => SetupTexts.TaskFiles,
            (InstallTask.Shortcuts, true) => SetupTexts.TaskShortcutsDone,
            (InstallTask.Shortcuts, false) => SetupTexts.TaskShortcuts,
            (_, true) => SetupTexts.TaskFinishDone,
            _ => SetupTexts.TaskFinish,
        };

        public override void Build(PageCanvas c)
        {
            _rows.Clear();
            _bar = null;
            _percent = null;
            _amount = null;
            if (!(state.Failed && state.Error is not null))
            {
                _percent = c.Text(string.Empty, 0, 0, 160, 40, 21f, FontStyle.Bold, p => p.Text, "lblPercent");
                _amount = c.Text(string.Empty, PageCanvas.Width - 260, 12, 260, 24, 9.8f, color: p => p.Muted, name: "lblAmount");
                _amount.Mono = true;
                _amount.Align = TextFormatFlags.Right;
            }
            if (state.Failed && state.Error is { } error)
            {
                // The complete reason, scrolling inside its slot; it replaces the step list (a different page state, not a message)
                // (selectable; the Copy button copies all of it plus version and time). The red bar keeps where the installation stopped.
                c.Add(new PcProgress { Value = Math.Max(_last.Value, 0.05f), Running = false, Failed = true }, 0, 4, PageCanvas.Width, 8, "progress");
                c.AddErrorBox(() => error, p => p.Text, 0, 28, PageCanvas.Width, 244, "txtInstallError");
                return;
            }
            _bar = c.Add(new PcProgress { Value = _last.Value, Running = true }, 0, 46, PageCanvas.Width, 8, "progress");

            var y = 70;
            foreach (var task in new[] { InstallTask.Prepare, InstallTask.Package, InstallTask.Files, InstallTask.Shortcuts, InstallTask.Finish })
            {
                _rows[task] = c.Add(new TaskRow(), 0, y, PageCanvas.Width, 34, "row" + task);
                y += 40;
            }
            Apply();
        }
    }

    private enum RowState { Pending, Active, Done }

    /// <summary>One step of the installation: status mark, text and (right, monospace) a detail such as "298 of 480 MB".</summary>
    private sealed class TaskRow : PcControl
    {
        public RowState State { get; set; }

        public string Detail { get; set; } = string.Empty;

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            Draw.Smooth(g);
            var mark = new RectangleF(U(2), (Height - U(16)) / 2f, U(16), U(16));
            switch (State)
            {
                case RowState.Done:
                    Draw.Check(g, RectangleF.Inflate(mark, -U(1.5f), -U(1.5f)), P.Accent, Math.Max(1.5f, U(1.9f)));
                    break;
                case RowState.Active:
                    using (var track = new Pen(Color.FromArgb(56, P.Accent), Math.Max(1.5f, U(2)))) g.DrawEllipse(track, RectangleF.Inflate(mark, -U(1.5f), -U(1.5f)));
                    using (var arc = new Pen(P.Accent, Math.Max(1.5f, U(2))) { StartCap = System.Drawing.Drawing2D.LineCap.Round, EndCap = System.Drawing.Drawing2D.LineCap.Round })
                        g.DrawArc(arc, RectangleF.Inflate(mark, -U(1.5f), -U(1.5f)), -90, 90);
                    break;
                default:
                    using (var ring = new Pen(P.BorderStrong, Math.Max(1f, U(1.5f)))) g.DrawEllipse(ring, RectangleF.Inflate(mark, -U(3.5f), -U(3.5f)));
                    break;
            }
            var detailWidth = Detail.Length > 0 ? TextRenderer.MeasureText(Detail, Fonts.GetMono(9.8f, S), Size.Empty, TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix).Width + (int)U(8) : 0;
            Draw.Text(g, Text, Fonts.Get(10.5f, S, State == RowState.Active ? FontStyle.Bold : FontStyle.Regular),
                State == RowState.Pending ? P.Muted : P.Text,
                new Rectangle((int)U(28), 0, Width - (int)U(28) - detailWidth, Height), TextFormatFlags.VerticalCenter);
            if (Detail.Length > 0)
                Draw.Text(g, Detail, Fonts.GetMono(9.8f, S), P.Muted, new Rectangle(Width - detailWidth, 0, detailWidth, Height), TextFormatFlags.VerticalCenter | TextFormatFlags.Right);
        }
    }

    private sealed class DonePage(SetupState state) : WizardPage
    {
        public override Msg StepLabel => SetupTexts.StepDone;
        public override Msg Kicker => SetupTexts.DoneKicker;
        public override Msg Title => state.IsUpdate ? SetupTexts.DoneUpdatedTitle : SetupTexts.DoneTitle;
        public override Msg Subtitle => SetupTexts.DoneSubtitle;

        public override void Build(PageCanvas c)
        {
            c.Add(new PcFeature { Text = SetupTexts.TipSearchTitle, Description = SetupTexts.TipSearchText, Icon = Glyphs.Search }, 0, 0, PageCanvas.Width, 58, "tipSearch");
            c.Add(new PcFeature { Text = SetupTexts.TipLookTitle, Description = SetupTexts.TipLookText, Icon = Glyphs.Gear }, 0, 78, PageCanvas.Width, 58, "tipLook");
            c.Add(new PcFeature { Text = SetupTexts.TipEarlyTitle, Description = SetupTexts.TipEarlyText, Icon = Glyphs.Bug }, 0, 156, PageCanvas.Width, 58, "tipEarly");
        }
    }

    /// <summary>
    /// The plain licence text for the scrolling box: the hard line breaks of the official text (about 70 characters) are joined within a
    /// paragraph, so the box wraps it to its own width. Blank lines stay paragraph breaks (one at most); a line indented by eight or more
    /// spaces (the centred title lines) stays a line of its own.
    /// </summary>
    public static string LicenceForDisplay(string text)
    {
        var paragraphs = new List<string>();
        var current = new List<string>();
        void Flush()
        {
            if (current.Count > 0) paragraphs.Add(string.Join(' ', current));
            current.Clear();
        }
        foreach (var raw in text.Replace("\r\n", "\n").TrimStart('\uFEFF').Split('\n'))
        {
            var line = raw.TrimEnd();
            if (line.Length == 0)
            {
                Flush();
                if (paragraphs.Count > 0 && paragraphs[^1].Length > 0) paragraphs.Add(string.Empty);
                continue;
            }
            var centred = CentredLine().IsMatch(line);
            if (centred) Flush();
            current.Add(line.Trim());
            if (centred) Flush();
        }
        Flush();
        return string.Join('\n', paragraphs).Trim();
    }

    [GeneratedRegex(@"^ {8,}\S")]
    private static partial Regex CentredLine();
}

/// <summary>What the setup knows and what the user chose (shared by the pages).</summary>
internal sealed class SetupState
{
    public required PayloadInfo Info { get; init; }
    public string? InstalledVersion { get; init; }
    public bool IsUpdate => InstalledVersion is not null;
    public string? LicenceText { get; init; }
    public required string InstallDir { get; set; }
    public bool StartMenu { get; set; } = true;
    public bool DesktopShortcut { get; set; } = true;
    public bool Failed { get; set; }
    public bool Succeeded { get; set; }
    public Msg? Error { get; set; }

    public InstallRequest Request() => new(InstallDir, StartMenu, DesktopShortcut, UiLang.Current, ThemeMode.Current.IsDark);
}
