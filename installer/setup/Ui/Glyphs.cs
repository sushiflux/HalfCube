using System.Drawing.Drawing2D;

namespace Partcraft.Setup.Ui;

/// <summary>
/// Small line icons for the setup windows (round caps and joins, the look of the Tabler outline set that the mockup uses), drawn as
/// vectors so they stay sharp at every scale. Each takes the box to draw into and the colour. Coordinates are on a 24 x 24 grid.
/// </summary>
public static class Glyphs
{
    private static Pen Stroke(Color c, RectangleF r) =>
        new(c, Math.Max(1.4f, r.Width * 1.8f / 24f)) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };

    private static PointF At(RectangleF r, float x, float y) => new(r.Left + r.Width * x / 24f, r.Top + r.Height * y / 24f);

    private static void Circle(Graphics g, Pen pen, RectangleF r, float cx, float cy, float radius)
    {
        var p = At(r, cx - radius, cy - radius);
        g.DrawEllipse(pen, p.X, p.Y, r.Width * 2 * radius / 24f, r.Height * 2 * radius / 24f);
    }

    private static void Line(Graphics g, Pen pen, RectangleF r, params float[] xy)
    {
        var points = new PointF[xy.Length / 2];
        for (var i = 0; i < points.Length; i++) points[i] = At(r, xy[2 * i], xy[2 * i + 1]);
        g.DrawLines(pen, points);
    }

    /// <summary>Two overlapping sheets (the "copy" icon).</summary>
    public static void Copy(Graphics g, RectangleF r, Color c)
    {
        using var pen = Stroke(c, r);
        Line(g, pen, r, 16, 8, 16, 6, 14, 4, 6, 4, 4, 6, 4, 14, 6, 16, 8, 16);
        var front = new RectangleF(At(r, 8, 8), new SizeF(r.Width * 12 / 24f, r.Height * 12 / 24f));
        using var path = Draw.Rounded(front, r.Width * 2f / 24f);
        g.DrawPath(pen, path);
    }

    public static void Folder(Graphics g, RectangleF r, Color c)
    {
        using var pen = Stroke(c, r);
        Line(g, pen, r, 4, 17, 4, 7, 6, 5, 10, 5, 12, 7, 18, 7, 20, 9, 20, 17, 18, 19, 6, 19, 4, 17);
    }

    /// <summary>A pencil (sketch).</summary>
    public static void Sketch(Graphics g, RectangleF r, Color c)
    {
        using var pen = Stroke(c, r);
        Line(g, pen, r, 4, 20, 8, 20, 18.5f, 9.5f, 19.4f, 7.9f, 18.7f, 6.1f, 17.9f, 5.3f, 16.1f, 4.6f, 14.5f, 5.5f, 4, 16, 4, 20);
        Line(g, pen, r, 13.5f, 6.5f, 17.5f, 10.5f);
    }

    /// <summary>Two nodes on a line with a marker (timeline).</summary>
    public static void Timeline(Graphics g, RectangleF r, Color c)
    {
        using var pen = Stroke(c, r);
        Line(g, pen, r, 4, 12, 5, 12);
        Line(g, pen, r, 9, 12, 11, 12);
        Line(g, pen, r, 15, 12, 20, 12);
        Circle(g, pen, r, 7, 12, 2);
        Circle(g, pen, r, 13, 12, 2);
        Line(g, pen, r, 19, 8, 19, 16);
    }

    /// <summary>A branch with three nodes (free and open).</summary>
    public static void Branch(Graphics g, RectangleF r, Color c)
    {
        using var pen = Stroke(c, r);
        Circle(g, pen, r, 6, 6, 2);
        Circle(g, pen, r, 6, 18, 2);
        Circle(g, pen, r, 18, 8, 2);
        Line(g, pen, r, 6, 8, 6, 16);
        g.DrawBezier(pen, At(r, 18, 10), At(r, 18, 14), At(r, 14, 16), At(r, 8, 16));
    }

    public static void Shield(Graphics g, RectangleF r, Color c)
    {
        using var pen = Stroke(c, r);
        Line(g, pen, r, 12, 3, 19, 6, 19, 12, 18.2f, 15.6f, 16, 18.6f, 12, 21, 8, 18.6f, 5.8f, 15.6f, 5, 12, 5, 6, 12, 3);
        Line(g, pen, r, 9, 12, 11, 14, 15, 10);
    }

    public static void Trash(Graphics g, RectangleF r, Color c)
    {
        using var pen = Stroke(c, r);
        Line(g, pen, r, 4, 7, 20, 7);
        Line(g, pen, r, 10, 11, 10, 17);
        Line(g, pen, r, 14, 11, 14, 17);
        Line(g, pen, r, 5, 7, 6, 19, 7, 20.4f, 8, 21, 16, 21, 17, 20.4f, 18, 19, 19, 7);
        Line(g, pen, r, 9, 7, 9, 4, 15, 4, 15, 7);
    }

    public static void Search(Graphics g, RectangleF r, Color c)
    {
        using var pen = Stroke(c, r);
        Circle(g, pen, r, 10.5f, 10.5f, 6.5f);
        Line(g, pen, r, 15.5f, 15.5f, 20, 20);
    }

    public static void Gear(Graphics g, RectangleF r, Color c)
    {
        using var pen = Stroke(c, r);
        Circle(g, pen, r, 12, 12, 3);
        Circle(g, pen, r, 12, 12, 6.8f);
        for (var i = 0; i < 8; i++)
        {
            var a = Math.PI / 4 * i;
            var (sin, cos) = ((float)Math.Sin(a), (float)Math.Cos(a));
            Line(g, pen, r, 12 + cos * 6.8f, 12 + sin * 6.8f, 12 + cos * 9.4f, 12 + sin * 9.4f);
        }
    }

    public static void Bug(Graphics g, RectangleF r, Color c)
    {
        using var pen = Stroke(c, r);
        var body = new RectangleF(At(r, 7, 9), new SizeF(r.Width * 10 / 24f, r.Height * 11 / 24f));
        using (var path = Draw.Rounded(body, r.Width * 5f / 24f)) g.DrawPath(pen, path);
        Line(g, pen, r, 9, 9, 9, 7, 9.9f, 4.9f, 12, 4, 14.1f, 4.9f, 15, 7, 15, 9);
        Line(g, pen, r, 12, 13, 12, 20);
        Line(g, pen, r, 4, 13, 7, 13);
        Line(g, pen, r, 17, 13, 20, 13);
        Line(g, pen, r, 5, 19, 7.5f, 17);
        Line(g, pen, r, 19, 19, 16.5f, 17);
        Line(g, pen, r, 5, 7, 7.5f, 9.5f);
        Line(g, pen, r, 19, 7, 16.5f, 9.5f);
    }

    public static void Play(Graphics g, RectangleF r, Color c)
    {
        using var pen = Stroke(c, r);
        Line(g, pen, r, 7, 4, 7, 20, 20, 12, 7, 4);
    }

    /// <summary>A circular arrow (try again).</summary>
    public static void Retry(Graphics g, RectangleF r, Color c)
    {
        using var pen = Stroke(c, r);
        var box = new RectangleF(At(r, 4, 4), new SizeF(r.Width * 16 / 24f, r.Height * 16 / 24f));
        g.DrawArc(pen, box, -7f, -308f);
        Line(g, pen, r, 20, 4, 20, 11, 13, 11);
    }
}

/// <summary>A feature line: icon in a soft tinted square, bold title, muted explanation (wraps inside its fixed box).</summary>
public sealed class PcFeature : PcControl
{
    public Action<Graphics, RectangleF, Color>? Icon { get; set; }

    public string Description { get; set; } = string.Empty;

    /// <summary>Tint of the icon square: accent (default) or a palette pair such as the green of "stays".</summary>
    public Func<Palette, (Color Back, Color Fore)> Tint { get; set; } = p => (p.AccentSoft, p.Accent);

    /// <summary>A short single-line row (the welcome page's feature list) instead of a title with an explanation.</summary>
    public bool Compact { get; set; }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        Draw.Smooth(g);
        var (back, fore) = Tint(P);
        var size = U(Compact ? 28 : 36);
        var square = new RectangleF(U(0.5f), U(Compact ? 0 : 2), size, size);
        Draw.FillRounded(g, square, U(4), back);
        Icon?.Invoke(g, RectangleF.Inflate(square, -size * 0.22f, -size * 0.22f), fore);
        var left = (int)(square.Right + U(12));
        var width = Width - left;
        if (Compact)
        {
            Draw.Text(g, Text, Fonts.Get(10f, S), P.Text, new Rectangle(left, 0, width, (int)size), TextFormatFlags.VerticalCenter);
            return;
        }
        var title = Fonts.Get(10.5f, S, FontStyle.Bold);
        var titleH = TextRenderer.MeasureText(g, "Ag", title, Size.Empty, TextFormatFlags.NoPadding).Height;
        Draw.Text(g, Text, title, P.Text, new Rectangle(left, (int)U(1), width, titleH + 2));
        Draw.Text(g, Description, Fonts.Get(9.5f, S), P.Muted, new Rectangle(left, (int)U(1) + titleH + (int)U(3), width, Height - titleH - (int)U(4)));
    }

    /// <summary>Height the texts need at the control's width (layout check).</summary>
    public int NeededHeight
    {
        get
        {
            var left = (int)(U(Compact ? 28 : 36) + U(12));
            if (Compact) return (int)U(28);
            var title = Fonts.Get(10.5f, S, FontStyle.Bold);
            var titleH = TextRenderer.MeasureText("Ag", title, Size.Empty, TextFormatFlags.NoPadding).Height;
            return (int)U(1) + titleH + (int)U(3) + Draw.Measure(Description, Fonts.Get(9.5f, S), Width - left).Height;
        }
    }
}
