using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using Partcraft.Setup.Localization;

namespace Partcraft.Setup.Ui;

/// <summary>One step of a <see cref="WizardWindow"/>: builds its controls into the content area (design units, origin = top left of the area).</summary>
public abstract class WizardPage
{
    public abstract Msg StepLabel { get; }

    public abstract Msg Kicker { get; }

    public abstract Msg Title { get; }

    public abstract Msg Subtitle { get; }

    /// <summary>
    /// Design units the subtitle slot is taller than the standard two lines (a long subtitle, like the licence summary); the page starts
    /// that much lower. Fixed per page in every language and scale, so nothing on the page moves when the language changes.
    /// </summary>
    public virtual int ExtraSubtitleHeight => 0;

    /// <summary>Creates the controls of the page. Called again after a language or theme switch (the page keeps its own state).</summary>
    public abstract void Build(PageCanvas canvas);

    /// <summary>Called when the page became the visible one.</summary>
    public virtual void Shown() { }
}

/// <summary>What a page gets to place its controls: the scale, the palette and a helper that converts design units to pixels.</summary>
public sealed class PageCanvas(Control host, float scale, Palette palette)
{
    public const int Width = WizardWindow.ContentWidth;
    public const int Height = WizardWindow.ContentHeight;

    public float S { get; } = scale;

    public Palette P { get; } = palette;

    public Control Host { get; } = host;

    public Rectangle R(int x, int y, int width, int height) =>
        new((int)Math.Round(x * S), (int)Math.Round(y * S), (int)Math.Round(width * S), (int)Math.Round(height * S));

    /// <summary>Adds an owner-drawn control at a fixed place in design units and returns it.</summary>
    public T Add<T>(T control, int x, int y, int width, int height, string? name = null) where T : Control
    {
        control.Bounds = R(x, y, width, height);
        if (name is not null) control.Name = name;
        if (control is PcControl pc)
        {
            pc.S = S;
            pc.P = P;
            pc.Surface = P.Page;
        }
        Host.Controls.Add(control);
        // Later controls lie on top of earlier ones (a card first, then its label and button). WinForms does the opposite: the
        // first child added is the topmost, so a background card covered everything placed on it once it painted - the folder
        // and "Change" of the location step vanished right after the page appeared. DrawToBitmap (the offscreen screenshots)
        // paints children in reverse order and hid the bug, see WizardCanvasTests.
        control.BringToFront();
        return control;
    }

    /// <summary>
    /// An error message with its "Copy" bar: the selectable, scrolling text box and, below it, the button with its status slot (rule
    /// "error messages are always copyable"). The bar copies the complete message plus app version and time. Returns the text box.
    /// </summary>
    public PcScrollText AddErrorBox(Func<string> message, Func<Palette, Color> color, int x, int y, int width, int boxHeight, string name)
    {
        var text = message();
        var box = Add(new PcScrollText { Framed = true, Points = 9.5f }, x, y, width, boxHeight, name);
        box.SetText(text, color);
        var bar = new CopyBar(message, S, P, P.Page, name.Replace("txt", string.Empty, StringComparison.Ordinal));
        bar.Place(R(x, y + boxHeight + 10, width, 36), (int)Math.Round(12 * S));
        foreach (var control in bar.Controls)
        {
            Host.Controls.Add(control);
            control.BringToFront();
        }
        return box;
    }

    public PcText Text(string text, int x, int y, int width, int height, float points = 10f, FontStyle style = FontStyle.Regular,
        Func<Palette, Color>? color = null, string? name = null)
    {
        var label = new PcText { Text = text, Points = points, Style = style };
        if (color is not null) label.Color = color;
        return Add(label, x, y, width, height, name);
    }
}

/// <summary>
/// The designed window of the setup and the uninstaller (mockup variant B): a night-blue brand panel on the left (logo, wordmark,
/// steps, version, "made with" line), a light or dark content area on the right with kicker, title and the page, and an action bar.
/// Borderless with its own title strip (drag, light/dark switch, minimise, close), rounded corners and the system shadow on Windows 11.
/// Pages change with a short slide-and-fade (off when Windows' animations are off). Every position is a fixed design unit (96-dpi
/// pixel) times the scale, so nothing ever moves when a message appears.
/// </summary>
public class WizardWindow : Form
{
    public const int WindowWidth = 920;
    public const int WindowHeight = 600;
    public const int SideWidth = 300;
    public const int HeaderHeight = 44;
    public const int FooterHeight = 76;
    public const int ContentLeft = SideWidth + 48;
    public const int ContentTop = HeaderHeight;
    public const int ContentWidth = WindowWidth - ContentLeft - 48;
    // The page itself starts this far below the content area's top (kicker, title and a two-line subtitle sit above it)
    public const int PageTop = 126;
    public const int NextWidth = 190;
    public const int ContentHeight = WindowHeight - ContentTop - FooterHeight - PageTop;

    private readonly List<WizardPage> _steps;
    private readonly Panel _content;
    private readonly PcText _kicker;
    private readonly PcText _title;
    private readonly PcText _subtitle;
    private readonly Panel _pageHost;
    private readonly TransitionLayer _transition;
    private readonly PcButton _themeButton;
    private readonly PcButton _minimizeButton;
    private readonly PcButton _closeButton;
    private readonly Msg _sideSubtitle;
    private readonly string _version;
    private int _index = -1;

    public WizardWindow(Msg windowTitle, Msg sideSubtitle, string version, IReadOnlyList<WizardPage> steps, float? forcedScale = null)
    {
        _steps = [.. steps];
        _sideSubtitle = sideSubtitle;
        _version = version;
        Headless = forcedScale is not null;

        AutoScaleMode = AutoScaleMode.None;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        Text = windowTitle;
        Icon = Branding.GetIcon(32);
        ShowInTaskbar = !Headless;
        KeyPreview = true;
        DoubleBuffered = true;
        // The scale of the monitor the window opens on (CenterScreen = the monitor under the mouse); DeviceDpi is not known yet
        // before the handle exists. The layout is fixed in design units, so a later move to a monitor with another DPI keeps the size
        // (see OnDpiChanged) instead of shrinking the window around unscaled controls.
        S = forcedScale ?? ScreenDpi.ScaleAt(Cursor.Position);
        ClientSize = new Size(Px(WindowWidth), Px(WindowHeight));
        P = ThemeMode.Current;
        BackColor = P.Page;

        _content = new Panel { Bounds = new Rectangle(Px(ContentLeft), Px(ContentTop), Px(ContentWidth), Px(WindowHeight - ContentTop - FooterHeight)), BackColor = P.Page, Name = "content" };
        _kicker = new PcText { Kicker = true, Points = 8.6f, Style = FontStyle.Bold, Color = p => p.Accent, Name = "kicker" };
        _title = new PcText { Points = 20.25f, Style = FontStyle.Bold, Display = true, Name = "title" };
        _subtitle = new PcText { Points = 10.5f, Color = p => p.Muted, Name = "subtitle" };
        _pageHost = new Panel { BackColor = P.Page, Name = "page" };
        _transition = new TransitionLayer { Visible = false, Name = "transition" };
        PlaceInContent(_kicker, 0, 8, ContentWidth, 18);
        PlaceInContent(_title, 0, 30, ContentWidth, 40);
        // Two lines for the subtitle in every language and scale
        PlaceInContent(_subtitle, 0, 74, ContentWidth, 46);
        _pageHost.Bounds = new Rectangle(0, Px(PageTop), Px(ContentWidth), _content.Height - Px(PageTop));
        _transition.Bounds = _pageHost.Bounds;
        _content.Controls.AddRange([_transition, _kicker, _title, _subtitle, _pageHost]);

        // The glyphs and the hover/close-red of the Windows caption buttons (CaptionGlyphs, CaptionColors)
        _themeButton = ChromeButton("btnTheme", PcButtonKind.WindowButton, (g, r, c) => (P.IsDark ? (Action<Graphics, RectangleF, Color>)CaptionGlyphs.Sun : CaptionGlyphs.Moon)(g, r, c));
        _minimizeButton = ChromeButton("btnMinimize", PcButtonKind.WindowButton, CaptionGlyphs.Minimize);
        _closeButton = ChromeButton("btnClose", PcButtonKind.WindowClose, CaptionGlyphs.Close);
        _themeButton.Bounds = new Rectangle(Px(WindowWidth - 140), Px(6), Px(44), Px(32));
        _minimizeButton.Bounds = new Rectangle(Px(WindowWidth - 94), Px(6), Px(44), Px(32));
        _closeButton.Bounds = new Rectangle(Px(WindowWidth - 48), Px(6), Px(44), Px(32));
        _themeButton.Click += (_, _) => { ThemeMode.Set(!P.IsDark); };
        _minimizeButton.Click += (_, _) => WindowState = FormWindowState.Minimized;
        _closeButton.Click += (_, _) => OnCloseRequested();
        UpdateChromeNames();

        Back = new PcButton { Kind = PcButtonKind.Secondary, Name = "btnBack" };
        Next = new PcButton { Kind = PcButtonKind.Primary, Name = "btnNext" };
        Cancel = new PcButton { Kind = PcButtonKind.Ghost, Name = "btnCancel" };
        Hint = new PcText { Points = 9.5f, Color = p => p.Muted, Name = "lblHint", Align = TextFormatFlags.Left | TextFormatFlags.VerticalCenter };
        // The primary button never changes size between states; Back and Cancel sit to its left in the order of the mockup
        // (Back, Cancel, Next) and only the visible ones are laid out, so the primary action always keeps its place.
        ShowFooterButtons(back: false, cancel: true);
        PlaceInContent(Hint, ContentLeft, WindowHeight - FooterHeight + 17, WindowWidth - 48 - NextWidth - 16 - ContentLeft, 42);

        Controls.AddRange([_content, _themeButton, _minimizeButton, _closeButton, Back, Next, Cancel, Hint]);
        ApplyPalette();

        ThemeMode.Changed += OnThemeChanged;
        UiLang.Changed += OnLanguageChanged;
        FormClosed += (_, _) =>
        {
            ThemeMode.Changed -= OnThemeChanged;
            UiLang.Changed -= OnLanguageChanged;
        };
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            ThemeMode.Changed -= OnThemeChanged;
            UiLang.Changed -= OnLanguageChanged;
        }
        base.Dispose(disposing);
    }

    /// <summary>True for an offscreen test rendering: never shown, no animation.</summary>
    public bool Headless { get; }

    public float S { get; }

    public Palette P { get; private set; }

    public PcButton Back { get; }

    public PcButton Next { get; }

    public PcButton Cancel { get; }

    /// <summary>A short note at the left of the action bar (for example "Progress is measured on the target folder").</summary>
    public PcText Hint { get; }

    public int StepIndex => _index;

    public WizardPage CurrentPage => _steps[_index];

    protected int Px(float designUnits) => (int)Math.Round(designUnits * S);

    private void PlaceInContent(Control control, int x, int y, int width, int height)
    {
        control.Bounds = new Rectangle(Px(x), Px(y), Px(width), Px(height));
        if (control is PcControl pc) pc.S = S;
    }

    private bool _backShown;
    private bool _cancelShown;

    /// <summary>
    /// Shows or hides Back and Cancel and lays out the visible footer buttons from the right: Next, then Cancel, then Back. The window
    /// keeps the wish itself because <see cref="Control.Visible"/> reads false for every child of a window that was never shown (the
    /// offscreen pictures of the layout check).
    /// </summary>
    protected void ShowFooterButtons(bool back, bool cancel)
    {
        _backShown = back;
        _cancelShown = cancel;
        Back.Visible = back;
        Cancel.Visible = cancel;
        PlaceFooter();
    }

    private void PlaceFooter()
    {
        var top = WindowHeight - FooterHeight + 19;
        var x = WindowWidth - 48 - NextWidth;
        PlaceButton(Next, x, NextWidth, top);
        if (_cancelShown) x -= 10 + 128;
        PlaceButton(Cancel, x, 128, top);
        if (_backShown) x -= 10 + 128;
        PlaceButton(Back, x, 128, top);
    }

    private void PlaceButton(PcButton button, int x, int width, int top)
    {
        button.Bounds = new Rectangle(Px(x), Px(top), Px(width), Px(38));
        button.S = S;
    }

    private PcButton ChromeButton(string name, PcButtonKind kind, Action<Graphics, RectangleF, Color> glyph)
    {
        var button = new PcButton { Kind = kind, Name = name, Glyph = glyph, TabStop = false, S = S };
        return button;
    }

    private void UpdateChromeNames()
    {
        _themeButton.AccessibleName = P.IsDark ? CommonTexts.ThemeToLight : CommonTexts.ThemeToDark;
        _minimizeButton.AccessibleName = CommonTexts.CaptionMinimize;
        _closeButton.AccessibleName = CommonTexts.Close;
    }

    /// <summary>The close button and Esc: the default asks nothing and closes; installers override it.</summary>
    protected virtual void OnCloseRequested() => Close();

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Escape && Cancel.Visible && Cancel.Enabled)
        {
            e.Handled = true;
            Cancel.PerformClick();
        }
        else if (e.KeyCode == Keys.Enter && Next.Visible && Next.Enabled && ActiveControl is not PcButton && ActiveControl is not PcScrollText)
        {
            e.Handled = true;
            Next.PerformClick();
        }
        base.OnKeyDown(e);
    }

    /// <summary>Shows step <paramref name="index"/> (with the slide-and-fade unless headless or animations are off).</summary>
    public void GoTo(int index)
    {
        if (index < 0 || index >= _steps.Count) return;
        var animate = _index >= 0 && !Headless && SystemInformation.UIEffectsEnabled && IsHandleCreated && Visible;
        var direction = index > _index ? 1 : -1;
        Bitmap? before = animate ? Snapshot(_pageHost) : null;

        _index = index;
        RebuildPage();
        Invalidate(); // side panel: steps

        if (before is not null)
        {
            var after = Snapshot(_pageHost);
            _transition.Start(before, after, direction, P.Page);
        }
        CurrentPage.Shown();
        StepChanged?.Invoke(this, EventArgs.Empty);
    }

    public event EventHandler? StepChanged;

    /// <summary>Builds the current page again (language or theme switch, or a page that changed its own state completely).</summary>
    public void RebuildPage()
    {
        var page = CurrentPage;
        _kicker.Text = page.Kicker;
        _title.Text = page.Title;
        _subtitle.Text = page.Subtitle;
        // A page with a long subtitle gets a taller slot and starts lower (fixed per page, see WizardPage.ExtraSubtitleHeight)
        PlaceInContent(_subtitle, 0, 74, ContentWidth, 46 + page.ExtraSubtitleHeight);
        _pageHost.Bounds = new Rectangle(0, Px(PageTop + page.ExtraSubtitleHeight), Px(ContentWidth), _content.Height - Px(PageTop + page.ExtraSubtitleHeight));
        _transition.Bounds = _pageHost.Bounds;

        _pageHost.SuspendLayout();
        foreach (Control old in _pageHost.Controls.Cast<Control>().ToList())
        {
            _pageHost.Controls.Remove(old);
            old.Dispose();
        }
        page.Build(new PageCanvas(_pageHost, S, P));
        _pageHost.ResumeLayout();
        ApplyPalette();
    }

    private static Bitmap Snapshot(Control control)
    {
        // Real stacking order (DrawToBitmap alone paints children in reverse z-order, see ControlSnapshot)
        return ControlSnapshot.Capture(control);
    }

    private void OnThemeChanged()
    {
        P = ThemeMode.Current;
        UpdateChromeNames();
        if (_index >= 0) RebuildPage();
        else ApplyPalette();
        Invalidate(true);
    }

    private void OnLanguageChanged()
    {
        UpdateChromeNames();
        if (_index >= 0) RebuildPage();
        LanguageChanged();
        Invalidate(true);
    }

    /// <summary>For texts the window owns besides the page (buttons): called after a language switch.</summary>
    protected virtual void LanguageChanged() { }

    private void ApplyPalette()
    {
        BackColor = P.Page;
        _content.BackColor = P.Page;
        _pageHost.BackColor = P.Page;
        Apply(this);

        void Apply(Control parent)
        {
            foreach (Control child in parent.Controls)
            {
                if (child is PcControl pc)
                {
                    pc.P = P;
                    if (pc.Surface == Palette.Light.Page || pc.Surface == Palette.Dark.Page || pc.Surface.IsEmpty) pc.Surface = P.Page;
                    if (pc is PcScrollText scroll) scroll.Relayout();
                    pc.Invalidate();
                }
                Apply(child);
            }
        }
    }

    // ---- painting of the brand panel and the frame ------------------------------------------------------------------------------

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        Draw.Smooth(g);
        var side = new Rectangle(0, 0, Px(SideWidth), ClientSize.Height);
        Brand.PaintNight(g, side);

        // The logo as a large, faint mark in the lower right corner (mockup: 300 high, 7 % opacity, partly outside the panel)
        {
            var state = g.Save();
            g.SetClip(side);
            var markHeight = Px(300);
            var markWidth = (int)Math.Round(markHeight * Branding.LogoAspect);
            Branding.DrawLogo(g, new RectangleF(side.Right + Px(92) - markWidth, ClientSize.Height + Px(56) - markHeight, markWidth, markHeight), 0.07f);
            g.Restore(state);
        }

        // Logo and wordmark (the mockup's 40-unit logo and 27-unit wordmark)
        var logoHeight = Px(40);
        var logoWidth = (int)Math.Round(logoHeight * Branding.LogoAspect);
        Branding.DrawLogo(g, new RectangleF(Px(30), Px(30), logoWidth, logoHeight));
        var wordSize = Branding.MeasureWordmark(27f * S);
        Branding.DrawWordmark(g, new Point(Px(30) + logoWidth + Px(12), Px(30) + (logoHeight - wordSize.Height) / 2), 27f * S);
        DrawTracked(g, _sideSubtitle.ToString().ToUpperInvariant(), Fonts.Get(8.6f, S, FontStyle.Bold), Brand.Label, new Point(Px(30), Px(82)));

        PaintSteps(g);

        // Foot: rule, version in the monospace face, "made with" line with the green heart
        var footerTop = WindowHeight - 72;
        using (var pen = new Pen(Color.FromArgb(41, 143, 221, 232), Math.Max(1f, S))) g.DrawLine(pen, Px(30), Px(footerTop), Px(SideWidth - 30), Px(footerTop));
        TextRenderer.DrawText(g, _version, Fonts.GetMono(9f, S), new Rectangle(Px(30), Px(footerTop + 14), Px(SideWidth - 60), Px(18)),
            Brand.Body, TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
        PaintMadeWith(g, new Point(Px(30), Px(footerTop + 38)));

        // Hairline between the action bar and the page
        using (var line = new SolidBrush(P.Border))
        {
            g.FillRectangle(line, Px(SideWidth), Px(WindowHeight - FooterHeight), ClientSize.Width - Px(SideWidth), Math.Max(1, (int)Math.Round(S)));
        }
    }

    private static void DrawTracked(Graphics g, string text, Font font, Color color, Point origin)
    {
        const TextFormatFlags flags = TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine;
        var spacing = font.Size * 0.16f;
        var x = (float)origin.X;
        foreach (var ch in text)
        {
            var s = ch.ToString();
            TextRenderer.DrawText(g, s, font, new Point((int)Math.Round(x), origin.Y), color, flags);
            x += TextRenderer.MeasureText(g, s, font, Size.Empty, flags).Width + spacing;
        }
    }

    private void PaintMadeWith(Graphics g, Point origin)
    {
        var font = Fonts.Get(9f, S);
        var (before, after) = CommonTexts.MadeWithParts;
        var flags = TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine;
        var x = origin.X;
        TextRenderer.DrawText(g, before, font, new Point(x, origin.Y), Brand.Faint, flags);
        x += TextRenderer.MeasureText(g, before, font, Size.Empty, flags).Width;
        var heart = Px(11);
        Branding.DrawHeart(g, new RectangleF(x + Px(1), origin.Y + Px(2), heart, heart * 0.92f), Brand.Heart);
        x += heart + Px(3);
        if (after.Length > 0) TextRenderer.DrawText(g, after, font, new Point(x, origin.Y), Brand.Faint, flags);
    }

    private void PaintSteps(Graphics g)
    {
        var top = 136;
        const int row = 46;
        for (var i = 0; i < _steps.Count; i++)
        {
            var y = top + i * row;
            var circle = new RectangleF(Px(30), Px(y + 11), Px(24), Px(24));
            var done = i < _index;
            var active = i == _index;
            var bad = active && Failed;

            if (i < _steps.Count - 1)
            {
                using var pen = new Pen(done ? Color.FromArgb(140, Brand.Crystal) : Brand.Line, Math.Max(1f, S));
                g.DrawLine(pen, circle.Left + circle.Width / 2, circle.Bottom + Px(1), circle.Left + circle.Width / 2, circle.Bottom + Px(23));
            }

            var ringWidth = Math.Max(1f, S * 1.5f);
            if (active)
            {
                var accent = bad ? Brand.Bad : Brand.Crystal;
                Brand.PaintGlow(g, RectangleF.Inflate(circle, Px(11), Px(11)), accent, 90);
                using (var fill = new SolidBrush(Brand.RingFill)) g.FillEllipse(fill, circle);
                using (var halo = new Pen(Color.FromArgb(36, accent), Px(4) * 2)) g.DrawEllipse(halo, circle);
                using (var ring = new Pen(accent, ringWidth)) g.DrawEllipse(ring, circle);
                DrawNumber(g, i + 1, circle, accent, FontStyle.Bold);
            }
            else if (done)
            {
                using (var fill = new SolidBrush(Brand.Crystal)) g.FillEllipse(fill, circle);
                Draw.Check(g, RectangleF.Inflate(circle, -Px(6.5f), -Px(6.5f)), Brand.OnCrystal, Math.Max(1.5f, S * 2f));
            }
            else
            {
                using (var fill = new SolidBrush(Brand.RingFill)) g.FillEllipse(fill, circle);
                using (var ring = new Pen(Brand.Ring, ringWidth)) g.DrawEllipse(ring, circle);
                DrawNumber(g, i + 1, circle, Brand.Faint, FontStyle.Bold);
            }

            TextRenderer.DrawText(g, _steps[i].StepLabel, Fonts.Get(10.9f, S, active ? FontStyle.Bold : FontStyle.Regular),
                new Rectangle(Px(68), Px(y), Px(SideWidth - 68 - 20), Px(row)),
                active ? Brand.Title : done ? Brand.Body : Brand.Faint,
                TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
        }
    }

    private void DrawNumber(Graphics g, int number, RectangleF circle, Color color, FontStyle style) =>
        TextRenderer.DrawText(g, number.ToString(System.Globalization.CultureInfo.InvariantCulture), Fonts.Get(8.6f, S, style),
            Rectangle.Round(circle), color, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);

    /// <summary>True while the current step shows a failure (its circle in the side panel turns red).</summary>
    protected bool Failed { get; set; }

    // ---- borderless frame: drag by the header, rounded corners and shadow (Windows 11) ------------------------------------------

    /// <summary>
    /// Moved to a monitor with another DPI (a per-monitor aware process would get this message): keep the window's
    /// pixel size. Its layout is fixed in design units at the scale it opened with; Windows' suggested smaller/larger rectangle would cut
    /// off or stretch the fixed controls. A system-aware process (the installer) never gets this message.
    /// </summary>
    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        e.Cancel = true;
        base.OnDpiChanged(e);
    }

    private const int WmNcHitTest = 0x84;
    private const int HtCaption = 2;

    protected override void WndProc(ref Message m)
    {
        base.WndProc(ref m);
        if (m.Msg == WmNcHitTest && (int)m.Result == 1)
        {
            var point = PointToClient(new Point(unchecked((short)(long)m.LParam), unchecked((short)((long)m.LParam >> 16))));
            // The brand panel and the empty title strip move the window
            if (point.Y < Px(HeaderHeight) || point.X < Px(SideWidth) && GetChildAtPoint(point) is null)
            {
                m.Result = HtCaption;
            }
        }
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            // Minimise from the taskbar works without a caption; the drop shadow for Windows 10
            cp.Style |= 0x00020000; // WS_MINIMIZEBOX
            cp.ClassStyle |= 0x00020000; // CS_DROPSHADOW
            return cp;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        try
        {
            var round = 2; // DWMWCP_ROUND
            _ = DwmSetWindowAttribute(Handle, 33, ref round, sizeof(int));
            var dark = 1; // keep the (invisible) frame dark so no light seam shows at the rounded edge
            _ = DwmSetWindowAttribute(Handle, 20, ref dark, sizeof(int));
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException)
        {
            // Older Windows: square corners
        }
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    /// <summary>Renders the whole window (never shown) into a PNG - offscreen screenshots for the layout check.</summary>
    public void SavePicture(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        CreateHandles(this);
        using var bitmap = ControlSnapshot.Capture(this, ClientSize);
        bitmap.Save(path, ImageFormat.Png);

        static void CreateHandles(Control control)
        {
            _ = control.Handle;
            foreach (Control child in control.Controls) CreateHandles(child);
        }
    }

    /// <summary>The cross-fade layer that lies over the page while it changes (old page slides out, new one slides in).</summary>
    private sealed class TransitionLayer : Control
    {
        private readonly System.Windows.Forms.Timer _timer = new() { Interval = 15 };
        private Bitmap? _from;
        private Bitmap? _to;
        private int _direction;
        private DateTime _started;
        private const double DurationMs = 260;

        public TransitionLayer()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
            _timer.Tick += (_, _) =>
            {
                if ((DateTime.UtcNow - _started).TotalMilliseconds >= DurationMs) Stop();
                else Invalidate();
            };
        }

        public void Start(Bitmap from, Bitmap to, int direction, Color back)
        {
            Stop();
            _from = from;
            _to = to;
            _direction = direction;
            BackColor = back;
            _started = DateTime.UtcNow;
            Visible = true;
            BringToFront();
            _timer.Start();
        }

        private void Stop()
        {
            _timer.Stop();
            Visible = false;
            _from?.Dispose();
            _to?.Dispose();
            _from = _to = null;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            if (_from is null || _to is null) return;
            var t = Math.Clamp((DateTime.UtcNow - _started).TotalMilliseconds / DurationMs, 0, 1);
            var eased = (float)(1 - Math.Pow(1 - t, 3));
            var shift = Width * 0.06f * _direction;
            Draw(e.Graphics, _from, -shift * eased, 1 - eased);
            Draw(e.Graphics, _to, shift * (1 - eased), eased);
        }

        private static void Draw(Graphics g, Bitmap image, float dx, float alpha)
        {
            using var attributes = new ImageAttributes();
            attributes.SetColorMatrix(new ColorMatrix { Matrix33 = alpha });
            g.DrawImage(image, new Rectangle((int)dx, 0, image.Width, image.Height), 0, 0, image.Width, image.Height, GraphicsUnit.Pixel, attributes);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _timer.Dispose();
                _from?.Dispose();
                _to?.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
