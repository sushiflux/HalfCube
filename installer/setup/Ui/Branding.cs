using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace HalfCube.Setup.Ui;

/// <summary>
/// The HalfCube brand marks of the setup: the logo (the real logo file of the repository's branding folder, scaled only - never
/// redrawn, recoloured or altered; transparent margins are left out of the drawn area), the window icon and the wordmark in Geist.
/// </summary>
public static class Branding
{
    private static readonly Bitmap LogoImage = LoadLogo();
    private static readonly Rectangle LogoBounds = OpaqueBounds(LogoImage);

    /// <summary>Width divided by height of the logo's visible area.</summary>
    public static float LogoAspect => LogoBounds.Width / (float)LogoBounds.Height;

    /// <summary>Draws the logo into <paramref name="target"/> (the whole visible area, scaled to fit, centred).</summary>
    public static void DrawLogo(Graphics g, RectangleF target, float opacity = 1f)
    {
        var scale = Math.Min(target.Width / LogoBounds.Width, target.Height / LogoBounds.Height);
        var width = LogoBounds.Width * scale;
        var height = LogoBounds.Height * scale;
        var dest = new RectangleF(target.Left + (target.Width - width) / 2f, target.Top + (target.Height - height) / 2f, width, height);
        var state = g.Save();
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        using var attributes = new ImageAttributes();
        attributes.SetWrapMode(WrapMode.TileFlipXY);
        if (opacity < 1f) attributes.SetColorMatrix(new ColorMatrix { Matrix33 = opacity });
        g.DrawImage(LogoImage, Rectangle.Round(dest), LogoBounds.X, LogoBounds.Y, LogoBounds.Width, LogoBounds.Height, GraphicsUnit.Pixel, attributes);
        g.Restore(state);
    }

    /// <summary>The window and taskbar icon (the multi-size .ico of the branding folder).</summary>
    public static Icon GetIcon(int size)
    {
        using var stream = typeof(Branding).Assembly.GetManifestResourceStream("halfcube.ico")
                           ?? throw new InvalidOperationException("The app icon is missing from the setup.");
        return new Icon(stream, new Size(size, size));
    }

    /// <summary>
    /// "Half" + "Cube" in Geist SemiBold with the fixed brand colours of the dark panel (wordmark option "Klar"; weight 640 of the
    /// mockup is drawn as the nearest shipped weight, 600). <paramref name="height"/> is the font size in pixels.
    /// </summary>
    public static Size MeasureWordmark(float fontPixels)
    {
        var font = Fonts.Get(fontPixels * 72f / 96f, 1f, FontStyle.Bold);
        var flags = TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine;
        var a = TextRenderer.MeasureText("Half", font, Size.Empty, flags);
        var b = TextRenderer.MeasureText("Cube", font, Size.Empty, flags);
        return new Size(a.Width + b.Width, Math.Max(a.Height, b.Height));
    }

    public static void DrawWordmark(Graphics g, Point origin, float fontPixels)
    {
        var font = Fonts.Get(fontPixels * 72f / 96f, 1f, FontStyle.Bold);
        var flags = TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine;
        var half = TextRenderer.MeasureText(g, "Half", font, Size.Empty, flags);
        TextRenderer.DrawText(g, "Half", font, origin, Brand.WordHalf, flags);
        TextRenderer.DrawText(g, "Cube", font, new Point(origin.X + half.Width, origin.Y), Brand.WordCube, flags);
    }

    /// <summary>A small filled heart (the "made with" line); drawn as a shape so it does not depend on a font glyph.</summary>
    public static void DrawHeart(Graphics g, RectangleF box, Color color)
    {
        using var path = new GraphicsPath();
        var x = box.Left;
        var y = box.Top;
        var w = box.Width;
        var h = box.Height;
        path.AddBezier(x + w * 0.5f, y + h * 0.95f, x - w * 0.15f, y + h * 0.48f, x + w * 0.12f, y - h * 0.05f, x + w * 0.5f, y + h * 0.28f);
        path.AddBezier(x + w * 0.5f, y + h * 0.28f, x + w * 0.88f, y - h * 0.05f, x + w * 1.15f, y + h * 0.48f, x + w * 0.5f, y + h * 0.95f);
        path.CloseFigure();
        using var brush = new SolidBrush(color);
        g.FillPath(brush, path);
    }

    private static Bitmap LoadLogo()
    {
        using var stream = typeof(Branding).Assembly.GetManifestResourceStream("logo.png")
                           ?? throw new InvalidOperationException("The logo is missing from the setup.");
        using var decoded = new Bitmap(stream);
        return new Bitmap(decoded);
    }

    /// <summary>The bounds of the pixels that are not (almost) transparent.</summary>
    private static Rectangle OpaqueBounds(Bitmap bitmap)
    {
        var data = bitmap.LockBits(new Rectangle(Point.Empty, bitmap.Size), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            int minX = bitmap.Width, minY = bitmap.Height, maxX = -1, maxY = -1;
            var row = new byte[data.Stride];
            for (var y = 0; y < bitmap.Height; y++)
            {
                System.Runtime.InteropServices.Marshal.Copy(data.Scan0 + y * data.Stride, row, 0, data.Stride);
                for (var x = 0; x < bitmap.Width; x++)
                {
                    if (row[x * 4 + 3] <= 12) continue;
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
            return maxX < 0 ? new Rectangle(Point.Empty, bitmap.Size) : Rectangle.FromLTRB(minX, minY, maxX + 1, maxY + 1);
        }
        finally
        {
            bitmap.UnlockBits(data);
        }
    }
}
