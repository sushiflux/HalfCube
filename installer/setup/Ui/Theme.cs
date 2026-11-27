using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace HalfCube.Setup.Ui;

/// <summary>
/// The colours of the HalfCube installer (the mockup variant B tokens) for native windows, light
/// and dark. Text/background pairs reach WCAG AA (4.5:1) on the surface they are used on, except the accent as text on its own soft
/// tint, which is only used for large or bold labels.
/// </summary>
public sealed record Palette(
    bool IsDark,
    Color Page,
    Color Surface,
    Color Elevated,
    Color Text,
    Color TextSecondary,
    Color Muted,
    Color Border,
    Color BorderStrong,
    Color Accent,
    Color AccentHover,
    Color OnAccent,
    Color AccentSoft,
    Color Emerald,
    Color EmeraldSoft,
    Color Danger,
    Color DangerHover,
    Color DangerSoft,
    Color ToggleOn,
    Color ToggleOff,
    Color Knob,
    Color Focus)
{
    public static readonly Palette Light = new(
        IsDark: false,
        Page: Hex("#f5f7f9"), Surface: Hex("#ffffff"), Elevated: Hex("#edf1f5"),
        Text: Hex("#0f1d2a"), TextSecondary: Hex("#2c3a47"), Muted: Hex("#526170"),
        Border: Hex("#dde3e9"), BorderStrong: Hex("#8794a1"),
        Accent: Hex("#1f75ae"), AccentHover: Hex("#185f90"), OnAccent: Color.White, AccentSoft: Hex("#e3eff8"),
        Emerald: Hex("#16803c"), EmeraldSoft: Hex("#ddf0e4"),
        Danger: Hex("#c42b2b"), DangerHover: Hex("#a42222"), DangerSoft: Hex("#fbeaea"),
        ToggleOn: Hex("#16803c"), ToggleOff: Hex("#c42b2b"), Knob: Color.White, Focus: Hex("#1f75ae"));

    public static readonly Palette Dark = new(
        IsDark: true,
        Page: Hex("#0e1317"), Surface: Hex("#151b20"), Elevated: Hex("#1d252c"),
        Text: Hex("#e7edf2"), TextSecondary: Hex("#c5d0d9"), Muted: Hex("#9babb8"),
        Border: Hex("#29333c"), BorderStrong: Hex("#6b7a87"),
        Accent: Hex("#4cd1e0"), AccentHover: Hex("#7be0ec"), OnAccent: Hex("#05252c"), AccentSoft: Hex("#123139"),
        Emerald: Hex("#3fcf74"), EmeraldSoft: Hex("#14301f"),
        Danger: Hex("#f06a62"), DangerHover: Hex("#f58c85"), DangerSoft: Hex("#2a1414"),
        ToggleOn: Hex("#3fcf74"), ToggleOff: Hex("#f06a62"), Knob: Hex("#0b1220"), Focus: Hex("#4cd1e0"));

    public static Color Hex(string value) => ColorTranslator.FromHtml(value);
}

/// <summary>
/// The brand side panel of the setup (mockup ".night": deep blue gradient, two soft glows, a fading grid). It is fixed dark in both
/// themes, so the white texts on it always reach 4.5:1.
/// </summary>
public static class Brand
{
    public static readonly Color NightTop = Palette.Hex("#10222f");
    public static readonly Color NightMid = Palette.Hex("#0a1620");
    public static readonly Color NightBottom = Palette.Hex("#070f16");
    public static readonly Color Crystal = Palette.Hex("#4cd1e0");
    public static readonly Color DeepBlue = Palette.Hex("#1f75ae");
    public static readonly Color Title = Color.White;
    public static readonly Color Label = Palette.Hex("#8fdde8");
    public static readonly Color Body = Palette.Hex("#d5e2ea");
    public static readonly Color Faint = Palette.Hex("#9fb3c2");
    public static readonly Color Ring = Palette.Hex("#66859a");
    public static readonly Color RingFill = Palette.Hex("#0b1822");
    public static readonly Color Line = Palette.Hex("#2c4354");
    public static readonly Color Heart = Palette.Hex("#4ade80");
    public static readonly Color OnCrystal = Palette.Hex("#05252c");
    public static readonly Color Bad = Palette.Hex("#f06a62");

    /// <summary>Paints the panel into <paramref name="bounds"/>: gradient, two glows and the grid fading out towards the middle.</summary>
    public static void PaintNight(Graphics g, Rectangle bounds)
    {
        var state = g.Save();
        g.SetClip(bounds);
        using (var back = new LinearGradientBrush(bounds, NightTop, NightBottom, 75f))
        {
            back.InterpolationColors = new ColorBlend
            {
                Colors = [NightTop, NightMid, NightBottom],
                Positions = [0f, 0.55f, 1f],
            };
            g.FillRectangle(back, bounds);
        }
        PaintGlow(g, new RectangleF(bounds.Right - bounds.Width * 0.55f, bounds.Top - bounds.Height * 0.4f, bounds.Width * 1.6f, bounds.Height * 0.8f), Crystal, 78);
        PaintGlow(g, new RectangleF(bounds.Left - bounds.Width * 0.9f, bounds.Bottom - bounds.Height * 0.4f, bounds.Width * 1.7f, bounds.Height * 0.9f), DeepBlue, 98);
        PaintGrid(g, bounds);
        g.Restore(state);
    }

    /// <summary>A soft round glow: full colour in the middle, fading to nothing at the edge (no visible rim).</summary>
    public static void PaintGlow(Graphics g, RectangleF ellipse, Color color, int alpha)
    {
        using var path = new GraphicsPath();
        path.AddEllipse(ellipse);
        using var brush = new PathGradientBrush(path)
        {
            CenterColor = Color.FromArgb(alpha, color),
            SurroundColors = [Color.FromArgb(0, color)],
        };
        // Pull the colour towards the centre so the fade is long and smooth
        brush.Blend = new Blend
        {
            Factors = [0f, 0.18f, 0.55f, 1f],
            Positions = [0f, 0.35f, 0.7f, 1f],
        };
        g.FillPath(brush, path);
    }

    /// <summary>
    /// The mockup's grid: a 48-unit grid with a 12-unit fine grid, masked so it is fully visible at the top, a third visible at 38 % of the
    /// height and gone at 62 %. The lines are one device pixel wide.
    /// </summary>
    private static void PaintGrid(Graphics g, Rectangle bounds)
    {
        var scale = bounds.Width / 300f;
        var major = 48f * scale;
        var minor = 12f * scale;
        var height = bounds.Height;
        static float Mask(float t) => t <= 0.38f ? 1f - 0.65f * (t / 0.38f) : t >= 0.62f ? 0f : 0.35f * (1f - (t - 0.38f) / 0.24f);
        void Lines(float step, int alpha, bool skipMajor)
        {
            for (var x = 0f; x <= bounds.Width + 0.5f; x += step)
            {
                if (skipMajor && Math.Abs(x % major) < 0.5f) continue;
                var px = bounds.Left + (float)Math.Floor(x) + 0.5f;
                using var brush = new LinearGradientBrush(new PointF(px, bounds.Top), new PointF(px, bounds.Bottom), Color.Empty, Color.Empty)
                {
                    InterpolationColors = new ColorBlend
                    {
                        Positions = [0f, 0.38f, 0.62f, 1f],
                        Colors =
                        [
                            Color.FromArgb((int)(alpha * Mask(0f)), 143, 221, 232),
                            Color.FromArgb((int)(alpha * Mask(0.38f)), 143, 221, 232),
                            Color.FromArgb(0, 143, 221, 232),
                            Color.FromArgb(0, 143, 221, 232),
                        ],
                    },
                };
                using var pen = new Pen(brush, 1f);
                g.DrawLine(pen, px, bounds.Top, px, bounds.Bottom);
            }
            for (var y = 0f; y <= height; y += step)
            {
                if (skipMajor && Math.Abs(y % major) < 0.5f) continue;
                var a = (int)(alpha * Mask(y / height));
                if (a <= 0) continue;
                using var pen = new Pen(Color.FromArgb(a, 143, 221, 232), 1f);
                var py = bounds.Top + (float)Math.Floor(y) + 0.5f;
                g.DrawLine(pen, bounds.Left, py, bounds.Right, py);
            }
        }
        var saved = g.PixelOffsetMode;
        g.PixelOffsetMode = PixelOffsetMode.Half;
        g.SmoothingMode = SmoothingMode.None;
        Lines(minor, 9, skipMajor: true);
        Lines(major, 18, skipMajor: false);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.PixelOffsetMode = saved;
    }
}

/// <summary>
/// Light/dark choice of the setup windows. The start value is Windows' own app mode (Settings > Personalisation > Colours,
/// <c>AppsUseLightTheme</c>); the sun/moon button in the title bar overrides it for this run.
/// </summary>
public static class ThemeMode
{
    private static Palette? _override;

    public static event Action? Changed;

    public static Palette Current => _override ?? (SystemPrefersDark() ? Palette.Dark : Palette.Light);

    public static void Set(bool dark)
    {
        _override = dark ? Palette.Dark : Palette.Light;
        Changed?.Invoke();
    }

    /// <summary>Windows' "app mode": AppsUseLightTheme = 0 means dark.</summary>
    public static bool SystemPrefersDark()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("AppsUseLightTheme") is int value && value == 0;
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            return false;
        }
    }
}

/// <summary>
/// Fonts in pixels for a given scale (design units are 96-dpi pixels), so a window looks the same at any DPI and offscreen. The UI
/// font is Geist (SIL OFL 1.1, shipped inside the setup and registered for this process only, never installed), with Segoe UI as the
/// fallback; numbers and the version use Geist Mono. The files are registered twice: in a GDI+ font collection (for the Font objects,
/// read from a temporary folder that is removed at exit) and with GDI (<c>AddFontMemResourceEx</c>, because TextRenderer asks GDI for the
/// font by name).
/// </summary>
public static class Fonts
{
    private static readonly Dictionary<(float, FontStyle, FontRole), Font> Cache = [];
    private static readonly PrivateFontCollection Collection = new();
    private static readonly bool GeistLoaded = RegisterGeist();
    private static readonly FontFamily? GeistText = GeistLoaded ? FindFamily("Geist") : null;
    private static readonly FontFamily? GeistSemiBold = GeistLoaded ? FindFamily("Geist SemiBold") : null;
    private static readonly FontFamily? GeistMono = GeistLoaded ? FindFamily("Geist Mono") : null;
    private static readonly string FallbackText = Installed("Segoe UI Variable Text") ? "Segoe UI Variable Text" : "Segoe UI";

    /// <summary>Why registering failed (null when it worked or was not tried); for the layout check and diagnostics.</summary>
    public static string? FailureReason { get; private set; }

    /// <summary>True when the Geist fonts could be registered for this process (false: the system fallback is used).</summary>
    public static bool HasGeist => GeistText is not null && GeistSemiBold is not null && GeistMono is not null;

    private enum FontRole { Text, Mono }

    /// <summary>
    /// A font of <paramref name="points"/> at 100 % scaled by <paramref name="scale"/>. <see cref="FontStyle.Bold"/> means Geist
    /// SemiBold (weight 600, the weight of the mockup titles and labels); <paramref name="display"/> is kept for the titles.
    /// </summary>
    public static Font Get(float points, float scale, FontStyle style = FontStyle.Regular, bool display = false) =>
        Make(points, scale, style, FontRole.Text);

    /// <summary>The monospace font (version line, sizes, error codes).</summary>
    public static Font GetMono(float points, float scale) => Make(points, scale, FontStyle.Regular, FontRole.Mono);

    private static Font Make(float points, float scale, FontStyle style, FontRole role)
    {
        var pixels = (float)Math.Round(points * 96f / 72f * scale, 2);
        var key = (pixels, style, role);
        lock (Cache)
        {
            if (!Cache.TryGetValue(key, out var font))
            {
                if (HasGeist)
                {
                    var bold = style.HasFlag(FontStyle.Bold);
                    var family = role == FontRole.Mono ? GeistMono! : bold ? GeistSemiBold! : GeistText!;
                    // Geist SemiBold is its own regular-style family
                    font = new Font(family, pixels, style & ~FontStyle.Bold, GraphicsUnit.Pixel);
                }
                else
                {
                    font = new Font(role == FontRole.Mono ? "Consolas" : FallbackText, pixels, style, GraphicsUnit.Pixel);
                }
                Cache[key] = font;
            }
            return font;
        }
    }

    private static FontFamily? FindFamily(string name) =>
        Collection.Families.FirstOrDefault(f => string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase));

    private static bool Installed(string name)
    {
        try
        {
            using var family = new FontFamily(name);
            return string.Equals(family.Name, name, StringComparison.OrdinalIgnoreCase);
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    /// <summary>
    /// Registers the embedded Geist TTF files for this process only; the fonts vanish when the setup ends. The memory stays allocated
    /// for the life of the process, as the API requires.
    /// </summary>
    private static bool RegisterGeist()
    {
        try
        {
            var assembly = typeof(Fonts).Assembly;
            var files = new List<(string Name, byte[] Data)>();
            foreach (var name in assembly.GetManifestResourceNames().Where(n => n.EndsWith(".ttf", StringComparison.OrdinalIgnoreCase)).Order(StringComparer.Ordinal))
            {
                using var stream = assembly.GetManifestResourceStream(name)!;
                var data = new byte[stream.Length];
                stream.ReadExactly(data);
                files.Add((name, data));
            }
            // GDI+ reads the files from a temporary folder (the in-memory variant of the same API left a font out of the collection in
            // about one run in ten); the folder is removed when the process ends
            var folder = Path.Combine(Path.GetTempPath(), $"{ProductInfo.Name}-Setup-fonts-" + Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture));
            Directory.CreateDirectory(folder);
            AppDomain.CurrentDomain.ProcessExit += (_, _) =>
            {
                try { Collection.Dispose(); Directory.Delete(folder, recursive: true); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* a leftover in the temp folder is harmless */ }
            };
            foreach (var (name, data) in files)
            {
                var path = Path.Combine(folder, name[5..]);
                File.WriteAllBytes(path, data);
                Collection.AddFontFile(path);
            }
            foreach (var (name, data) in files)
            {
                var memory = Marshal.AllocCoTaskMem(data.Length);
                Marshal.Copy(data, 0, memory, data.Length);
                uint count = 0;
                if (AddFontMemResourceEx(memory, (uint)data.Length, IntPtr.Zero, ref count) == IntPtr.Zero)
                {
                    FailureReason = $"AddFontMemResourceEx failed for {name} (error {Marshal.GetLastWin32Error()})";
                    return false;
                }
            }
            return true;
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException or ArgumentException or IOException or ExternalException)
        {
            FailureReason = ex.GetType().Name + ": " + ex.Message;
            return false;
        }
    }

    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern IntPtr AddFontMemResourceEx(IntPtr font, uint size, IntPtr reserved, ref uint count);
}

/// <summary>Small drawing helpers shared by all owner-drawn controls.</summary>
public static class Draw
{
    public static GraphicsPath Rounded(RectangleF r, float radius)
    {
        var path = new GraphicsPath();
        var d = Math.Max(0.1f, Math.Min(radius * 2, Math.Min(r.Width, r.Height)));
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    public static void Smooth(Graphics g)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
    }

    public static void FillRounded(Graphics g, RectangleF r, float radius, Color color)
    {
        using var path = Rounded(r, radius);
        using var brush = new SolidBrush(color);
        g.FillPath(brush, path);
    }

    public static void FillRoundedBrush(Graphics g, RectangleF r, float radius, Brush brush)
    {
        using var path = Rounded(r, radius);
        g.FillPath(brush, path);
    }

    public static void StrokeRounded(Graphics g, RectangleF r, float radius, Color color, float width)
    {
        using var path = Rounded(r, radius);
        using var pen = new Pen(color, width);
        g.DrawPath(pen, path);
    }

    public static Color Mix(Color a, Color b, float t) => Color.FromArgb(
        (int)Math.Round(a.A + (b.A - a.A) * t),
        (int)Math.Round(a.R + (b.R - a.R) * t),
        (int)Math.Round(a.G + (b.G - a.G) * t),
        (int)Math.Round(a.B + (b.B - a.B) * t));

    /// <summary>WCAG 2.x contrast ratio (1..21) of two opaque colours.</summary>
    public static double Contrast(Color a, Color b)
    {
        static double Channel(byte value)
        {
            var c = value / 255.0;
            return c <= 0.03928 ? c / 12.92 : Math.Pow((c + 0.055) / 1.055, 2.4);
        }
        static double Luminance(Color c) => 0.2126 * Channel(c.R) + 0.7152 * Channel(c.G) + 0.0722 * Channel(c.B);
        var (hi, lo) = (Luminance(a), Luminance(b));
        if (hi < lo) (hi, lo) = (lo, hi);
        return (hi + 0.05) / (lo + 0.05);
    }

    /// <summary>Wrapped text, top-left aligned, never with an ellipsis (a text that does not fit is a layout bug the layout check reports).</summary>
    public static void Text(Graphics g, string text, Font font, Color color, Rectangle bounds, TextFormatFlags extra = 0) =>
        TextRenderer.DrawText(g, text, font, bounds, color,
            TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix | TextFormatFlags.TextBoxControl | TextFormatFlags.NoPadding | extra);

    public static Size Measure(string text, Font font, int width) =>
        TextRenderer.MeasureText(text, font, new Size(width, int.MaxValue),
            TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix | TextFormatFlags.TextBoxControl | TextFormatFlags.NoPadding);

    /// <summary>A check mark inside <paramref name="box"/>.</summary>
    public static void Check(Graphics g, RectangleF box, Color color, float width)
    {
        using var pen = new Pen(color, width) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
        g.DrawLines(pen, [
            new PointF(box.Left + box.Width * 0.18f, box.Top + box.Height * 0.53f),
            new PointF(box.Left + box.Width * 0.42f, box.Top + box.Height * 0.76f),
            new PointF(box.Left + box.Width * 0.84f, box.Top + box.Height * 0.26f),
        ]);
    }

    /// <summary>A cross (x) inside <paramref name="box"/>.</summary>
    public static void Cross(Graphics g, RectangleF box, Color color, float width)
    {
        using var pen = new Pen(color, width) { StartCap = LineCap.Round, EndCap = LineCap.Round };
        g.DrawLine(pen, box.Left + box.Width * 0.25f, box.Top + box.Height * 0.25f, box.Right - box.Width * 0.25f, box.Bottom - box.Height * 0.25f);
        g.DrawLine(pen, box.Right - box.Width * 0.25f, box.Top + box.Height * 0.25f, box.Left + box.Width * 0.25f, box.Bottom - box.Height * 0.25f);
    }
}
