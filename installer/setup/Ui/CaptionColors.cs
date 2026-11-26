namespace HalfCube.Setup.Ui;

public enum CaptionState
{
    Normal,
    Hover,
    Pressed,
}

/// <summary>
/// Colours of the window commands (light/dark switch, minimise, close). Hover and pressed are tinted squares; close turns Windows' own
/// close red (#c42b1c) with a white cross, the colour every Windows user knows.
/// </summary>
public static class CaptionColors
{
    public static readonly Color CloseHover = Palette.Hex("#c42b1c");
    public static readonly Color ClosePressed = Palette.Hex("#a32317");
    public static readonly Color CloseGlyph = Color.White;

    public static Color ButtonBack(Palette p, Color bar, bool close, CaptionState state) => (close, state) switch
    {
        (_, CaptionState.Normal) => bar,
        (true, CaptionState.Hover) => CloseHover,
        (true, CaptionState.Pressed) => ClosePressed,
        (false, CaptionState.Hover) => p.IsDark ? p.Elevated : Draw.Mix(bar, p.Border, 0.55f),
        _ => p.IsDark ? Draw.Mix(p.Elevated, p.Border, 0.6f) : p.Border,
    };

    public static Color Glyph(Palette p, bool close, CaptionState state, bool active) =>
        close && state != CaptionState.Normal ? CloseGlyph : active || state != CaptionState.Normal ? p.TextSecondary : p.Muted;
}
