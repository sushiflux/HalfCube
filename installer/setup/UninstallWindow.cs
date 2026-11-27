using HalfCube.Setup.Localization;
using HalfCube.Setup.Ui;

namespace HalfCube.Setup;

/// <summary>
/// The designed uninstaller (mockup variant B, last three pages): says what is removed and what stays (cancel is preselected),
/// removes with real progress and ends with what is still there. Velopack does the removal underneath; never a Windows message box.
/// </summary>
internal sealed class UninstallWindow : WizardWindow
{
    private readonly UninstallState _state;
    private readonly Func<IProgress<RemoveProgress>, Task> _run;
    private readonly RemovePage _remove;
    private bool _running;

    public UninstallWindow(UninstallState state, Func<IProgress<RemoveProgress>, Task> run, float? forcedScale = null)
        : this(state, run, new ConfirmPage(state), new RemovePage(), new DonePage(state), forcedScale)
    {
    }

    private UninstallWindow(UninstallState state, Func<IProgress<RemoveProgress>, Task> run, ConfirmPage confirm, RemovePage remove, DonePage done, float? forcedScale)
        : base(UninstallTexts.WindowTitle, UninstallTexts.Side, state.DisplayVersion, [confirm, remove, done], forcedScale)
    {
        _state = state;
        _run = run;
        _remove = remove;
        Next.Click += async (_, _) => await OnNextAsync();
        Cancel.Click += (_, _) => OnCloseRequested();
        StepChanged += (_, _) => UpdateButtons();
        GoTo(0);
    }

    public bool Finished => _state.Succeeded;

    /// <summary>The overall progress last reported (0..1); the GUI self-test watches it.</summary>
    public float CurrentProgress => _remove.LastValue;

    protected override void LanguageChanged() => UpdateButtons();

    private void UpdateButtons()
    {
        var cancel = false;
        Hint.Text = string.Empty;
        Next.Glyph = null;
        Cancel.Kind = HcButtonKind.Secondary;
        Failed = StepIndex == 2 && _state.Failed;
        switch (StepIndex)
        {
            case 0:
                cancel = true;
                Cancel.Text = CommonTexts.Cancel;
                Next.Text = UninstallTexts.ButtonUninstall;
                Next.Kind = HcButtonKind.Danger;
                Next.Glyph = Glyphs.Trash;
                Next.Enabled = true;
                ActiveControl = Cancel;
                break;
            case 1:
                Next.Text = CommonTexts.Close;
                Next.Kind = HcButtonKind.Secondary;
                Next.Enabled = false;
                break;
            default:
                Next.Text = CommonTexts.Close;
                Next.Kind = HcButtonKind.Primary;
                Next.Enabled = true;
                break;
        }
        ShowFooterButtons(back: false, cancel);
        Cancel.Invalidate();
        Next.Invalidate();
        Invalidate();
    }

    private async Task OnNextAsync()
    {
        if (StepIndex == 0) await RunUninstallAsync();
        else if (StepIndex == 2) Close();
    }

    /// <summary>Runs the removal (also used by the headless test path).</summary>
    public async Task RunUninstallAsync()
    {
        _running = true;
        GoTo(1);
        UpdateButtons();
        var progress = new Progress<RemoveProgress>(p => _remove.Report(p));
        try
        {
            await _run(progress);
            _state.Succeeded = true;
        }
        catch (InstallException ex)
        {
            _state.Failed = true;
            _state.Error = ex.Text;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException or OperationCanceledException)
        {
            _state.Failed = true;
            _state.Error = new Msg(ex.Message, ex.Message);
        }
        _running = false;
        GoTo(2);
        UpdateButtons();
    }

    protected override void OnCloseRequested()
    {
        if (_running) return;
        Close();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (_running && e.CloseReason == CloseReason.UserClosing) e.Cancel = true;
        base.OnFormClosing(e);
    }

    /// <summary>Test states for the offscreen pictures.</summary>
    public IEnumerable<(string Name, Action Show)> TestStates()
    {
        yield return ("confirm", () => { GoTo(0); UpdateButtons(); });
        yield return ("removing", () =>
        {
            GoTo(1);
            _running = true;
            _remove.Report(new RemoveProgress(0.39f, 1, SetupTexts.DetailProgress("188", "480 MB")));
            UpdateButtons();
        });
        yield return ("done", () =>
        {
            _running = false;
            _state.Failed = false;
            _state.Succeeded = true;
            GoTo(2);
            UpdateButtons();
        });
        yield return ("failed", () =>
        {
            _state.Failed = true;
            _state.Error = UninstallTexts.ErrFailed(1, $@"C:\Users\Name\AppData\Local\{ProductInfo.Name}", $@"C:\Users\Name\AppData\Local\Temp\{ProductInfo.Name}-Uninstall-0f3a.log",
                string.Join('\n', Enumerable.Repeat($"[12:04:11] [ERROR] Unable to remove directory C:\\Users\\Name\\AppData\\Local\\{ProductInfo.Name}\\current: access denied", 4)));
            GoTo(2);
            UpdateButtons();
        });
        // The same page after a click on "Copy" (the layout check compares it with "failed")
        yield return ("failed-copied", () => Controls.Find("btnCopyUninstallError", true).OfType<HcButton>().Single().PerformClick());
    }

    // ---- pages -------------------------------------------------------------------------------------------------------------------

    private sealed class ConfirmPage(UninstallState state) : WizardPage
    {
        public override Msg StepLabel => UninstallTexts.StepConfirm;
        public override Msg Kicker => UninstallTexts.ConfirmKicker;
        public override Msg Title => UninstallTexts.ConfirmTitle;
        public override Msg Subtitle => UninstallTexts.ConfirmSubtitle;

        public override void Build(PageCanvas c)
        {
            c.Add(new KeepCard { Text = UninstallTexts.RemovedTitle, Description = UninstallTexts.RemovedText(state.SizeText), Removed = true }, 0, 0, PageCanvas.Width, 86, "cardRemoved");
            c.Add(new KeepCard { Text = UninstallTexts.KeptTitle, Description = UninstallTexts.KeptText, Removed = false }, 0, 102, PageCanvas.Width, 86, "cardKept");
        }
    }

    private sealed class RemovePage : WizardPage
    {
        private HcProgress? _bar;
        private HcText? _percent;
        private HcText? _amount;
        private readonly Dictionary<int, UninstallRow> _rows = [];
        private Msg? _detail;
        private RemoveProgress _last = new(0f, 0);

        public override Msg StepLabel => UninstallTexts.StepRemove;
        public override Msg Kicker => UninstallTexts.RemoveKicker;
        public override Msg Title => UninstallTexts.RemoveTitle;
        public override Msg Subtitle => UninstallTexts.RemoveSubtitle;

        public float LastValue => _last.Value;

        public void Report(RemoveProgress p)
        {
            _last = p;
            if (p.Detail is { } detail) _detail = detail;
            Apply();
        }

        private void Apply()
        {
            if (_bar is not null) _bar.Value = _last.Value;
            if (_percent is not null) _percent.Text = $"{_last.Value * 100:0} %";
            if (_amount is not null) _amount.Text = _detail?.ToString() ?? string.Empty;
            foreach (var (step, row) in _rows)
            {
                row.State = step < _last.Step || _last.Value >= 1f ? RowState.Done : step == _last.Step ? RowState.Active : RowState.Pending;
                row.Text = (step, row.State == RowState.Done) switch
                {
                    (0, true) => UninstallTexts.TaskStopDone,
                    (0, false) => UninstallTexts.TaskStop,
                    (1, true) => UninstallTexts.TaskFilesDone,
                    (1, false) => UninstallTexts.TaskFiles,
                    (_, true) => UninstallTexts.TaskShortcutsDone,
                    _ => UninstallTexts.TaskShortcuts,
                };
                row.Detail = step == 1 && _detail is { } d ? d.ToString() : string.Empty;
                row.Invalidate();
            }
        }

        public override void Build(PageCanvas c)
        {
            _rows.Clear();
            _percent = c.Text(string.Empty, 0, 0, 160, 40, 21f, FontStyle.Bold, p => p.Text, "lblPercent");
            _amount = c.Text(string.Empty, PageCanvas.Width - 260, 12, 260, 24, 9.8f, color: p => p.Muted, name: "lblAmount");
            _amount.Mono = true;
            _amount.Align = TextFormatFlags.Right;
            _bar = c.Add(new HcProgress { Value = _last.Value, Running = true }, 0, 46, PageCanvas.Width, 8, "progress");
            var y = 70;
            for (var step = 0; step < 3; step++)
            {
                _rows[step] = c.Add(new UninstallRow(), 0, y, PageCanvas.Width, 34, "row" + step);
                y += 40;
            }
            Apply();
        }
    }

    private sealed class DonePage(UninstallState state) : WizardPage
    {
        public override Msg StepLabel => UninstallTexts.StepDone;
        public override Msg Kicker => UninstallTexts.DoneKicker;
        public override Msg Title => state.Failed ? UninstallTexts.FailedTitle : UninstallTexts.DoneTitle;
        public override Msg Subtitle => state.Failed ? UninstallTexts.FailedSubtitle : UninstallTexts.DoneSubtitle;

        public override void Build(PageCanvas c)
        {
            if (state.Failed && state.Error is { } error)
            {
                c.AddErrorBox(() => error, p => p.Text, 0, 0, PageCanvas.Width, 250, "txtUninstallError");
                return;
            }
            c.Add(new KeepCard { Text = UninstallTexts.StillThereTitle, Description = UninstallTexts.StillThereText, Removed = false }, 0, 0, PageCanvas.Width, 86, "cardStillThere");
        }
    }

    private enum RowState { Pending, Active, Done }

    private sealed class UninstallRow : HcControl
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

    /// <summary>A card with a coloured bar on its left edge: red for what goes, green for what stays (the mockup's "krow").</summary>
    private sealed class KeepCard : HcControl
    {
        public string Description { get; set; } = string.Empty;

        public bool Removed { get; set; }

        public int NeededHeight => (int)U(13) + TextRenderer.MeasureText("Ag", Fonts.Get(10.5f, S, FontStyle.Bold), Size.Empty, TextFormatFlags.NoPadding).Height
            + (int)U(2) + Draw.Measure(Description, Fonts.Get(9.5f, S), Width - (int)U(16 + 36 + 12 + 16)).Height;

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            Draw.Smooth(g);
            var accent = Removed ? P.Danger : P.Emerald;
            var card = new RectangleF(U(0.5f), U(0.5f), Width - U(1), Height - U(1));
            Draw.FillRounded(g, card, U(6), P.Surface);
            Draw.StrokeRounded(g, card, U(6), P.Border, Math.Max(1f, U(1)));
            var state = g.Save();
            using (var clip = Draw.Rounded(card, U(6))) g.SetClip(clip);
            using (var bar = new SolidBrush(accent)) g.FillRectangle(bar, card.Left, card.Top, U(3), card.Height);
            g.Restore(state);

            var square = new RectangleF(U(20), U(14), U(36), U(36));
            Draw.FillRounded(g, square, U(4), Removed ? P.DangerSoft : P.EmeraldSoft);
            var inner = RectangleF.Inflate(square, -U(8), -U(8));
            if (Removed) Glyphs.Trash(g, inner, P.Danger);
            else Glyphs.Shield(g, inner, P.Emerald);

            var left = (int)U(68);
            var width = Width - left - (int)U(16);
            var title = Fonts.Get(10.5f, S, FontStyle.Bold);
            var titleHeight = TextRenderer.MeasureText("Ag", title, Size.Empty, TextFormatFlags.NoPadding).Height;
            Draw.Text(g, Text, title, P.Text, new Rectangle(left, (int)U(13), width, titleHeight + 2));
            Draw.Text(g, Description, Fonts.Get(9.5f, S), P.Muted, new Rectangle(left, (int)U(13) + titleHeight + (int)U(2), width, Height - titleHeight - (int)U(18)));
        }
    }
}

/// <summary>What the uninstaller knows and how it ended.</summary>
internal sealed class UninstallState
{
    public required string DisplayVersion { get; init; }
    public required string SizeText { get; init; }
    public bool Failed { get; set; }
    public bool Succeeded { get; set; }
    public Msg? Error { get; set; }
}
