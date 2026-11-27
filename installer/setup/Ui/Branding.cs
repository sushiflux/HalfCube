using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace HalfCube.Setup.Ui;

/// <summary>
/// The HalfCube brand marks of the setup: the logo (the real logo file of the repository's branding folder, scaled only - never
/// redrawn, recoloured or altered; transparent margins are left out of the drawn area), the window icon and the wordmark (letter outlines).
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
        using var stream = typeof(Branding).Assembly.GetManifestResourceStream(ProductInfo.Slug + ".ico")
                           ?? throw new InvalidOperationException("The app icon is missing from the setup.");
        return new Icon(stream, new Size(size, size));
    }

    /// <summary>
    /// Size of the wordmark at a font size of <paramref name="fontPixels"/> pixels: the width of the text including the letter
    /// spacing and a line box of one em in height (the same box the program and the manuals use).
    /// </summary>
    public static Size MeasureWordmark(float fontPixels)
    {
        var scale = fontPixels / WordmarkOutline.UnitsPerEm;
        var advance = fontPixels < WordmarkOutline.SmallBelow ? WordmarkOutline.SmallAdvance : WordmarkOutline.LargeAdvance;
        return new Size((int)Math.Ceiling(advance * scale), (int)Math.Round(fontPixels));
    }

    /// <summary>
    /// Draws the wordmark as the letter outlines of the repository's branding/wordmark (generated into WordmarkOutline.generated.cs
    /// by scripts/make-wordmark.mjs; the same drawing as in the program, the manuals and the README) with the fixed brand colours
    /// of the background it sits on (<paramref name="onDark"/>, the dark panel by default). <paramref name="origin"/> is the top
    /// left corner of the one-em line box, <paramref name="fontPixels"/> the font size in pixels; below 28 px the small setting is used.
    /// </summary>
    public static void DrawWordmark(Graphics g, Point origin, float fontPixels, bool onDark = true)
    {
        var small = fontPixels < WordmarkOutline.SmallBelow;
        var scale = fontPixels / WordmarkOutline.UnitsPerEm;
        var half = onDark ? DarkHalf : LightHalf;
        var cube = onDark ? DarkCube : LightCube;
        var state = g.Save();
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TranslateTransform(origin.X, origin.Y + WordmarkOutline.Baseline * scale);
        g.ScaleTransform(scale, scale);
        using (var path = BuildPath(small ? WordmarkOutline.SmallHalfOps : WordmarkOutline.LargeHalfOps, small ? WordmarkOutline.SmallHalfPoints : WordmarkOutline.LargeHalfPoints))
        using (var brush = new SolidBrush(half))
        {
            g.FillPath(brush, path);
        }
        using (var path = BuildPath(small ? WordmarkOutline.SmallCubeOps : WordmarkOutline.LargeCubeOps, small ? WordmarkOutline.SmallCubePoints : WordmarkOutline.LargeCubePoints))
        using (var brush = new SolidBrush(cube))
        {
            g.FillPath(brush, path);
        }
        g.Restore(state);
    }

    private static readonly Color LightHalf = Palette.Hex(WordmarkOutline.LightHalf);
    private static readonly Color LightCube = Palette.Hex(WordmarkOutline.LightCube);
    private static readonly Color DarkHalf = Palette.Hex(WordmarkOutline.DarkHalf);
    private static readonly Color DarkCube = Palette.Hex(WordmarkOutline.DarkCube);

    /// <summary>Builds a path from the generated operation and point arrays (font outlines fill with the non-zero winding rule).</summary>
    private static GraphicsPath BuildPath(byte[] ops, float[] points)
    {
        var path = new GraphicsPath(FillMode.Winding);
        var cx = 0f;
        var cy = 0f;
        var p = 0;
        foreach (var op in ops)
        {
            switch (op)
            {
                case 0:
                    path.StartFigure();
                    cx = points[p];
                    cy = points[p + 1];
                    p += 2;
                    break;
                case 1:
                    path.AddLine(cx, cy, points[p], points[p + 1]);
                    cx = points[p];
                    cy = points[p + 1];
                    p += 2;
                    break;
                case 2:
                    path.AddBezier(cx, cy, points[p], points[p + 1], points[p + 2], points[p + 3], points[p + 4], points[p + 5]);
                    cx = points[p + 4];
                    cy = points[p + 5];
                    p += 6;
                    break;
                default:
                    path.CloseFigure();
                    break;
            }
        }
        return path;
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
