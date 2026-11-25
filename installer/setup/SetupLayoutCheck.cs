using System.Text;
using Partcraft.Setup.Localization;
using Partcraft.Setup.Ui;

namespace Partcraft.Setup;

/// <summary>
/// <c>--test-layout &lt;folder&gt;</c>: renders every page of the setup - new installation and update - and of the uninstaller in German and
/// English, light and dark, at 100, 150 and 200 % into PNG files (never shown, nothing installed) and checks that every owner-drawn text
/// fits its fixed box, every control lies inside its parent and the frame (primary button, content area, close button) never moves
/// between states.
/// </summary>
internal static class SetupLayoutCheck
{
    public static int Run(SetupState template, string folder)
    {
        Directory.CreateDirectory(folder);
        var report = new StringBuilder();
        var failures = 0;
        var pictures = 0;
        report.AppendLine($"Fonts: {(Fonts.HasGeist ? "Geist" : "system fallback (Geist could not be registered: " + (Fonts.FailureReason ?? "families not found in the font collection") + ")")}");
        if (!Fonts.HasGeist) failures++;

        foreach (var update in new[] { false, true })
        foreach (var language in new[] { UiLang.German, UiLang.English })
        foreach (var dark in new[] { false, true })
        foreach (var scale in new[] { 1f, 1.5f, 2f })
        {
            UiLang.Current = language;
            ThemeMode.Set(dark);
            var tag = $"{(update ? "update" : "install")}-{language}-{(dark ? "dark" : "light")}-{scale * 100:0}";
            var state = new SetupState
            {
                Info = template.Info,
                InstalledVersion = update ? "2026.11.4" : null,
                LicenceText = template.LicenceText,
                InstallDir = @"C:\Users\Name\AppData\Local\Partcraft",
            };
            using (var window = new SetupWindow(state, (_, _) => Task.CompletedTask, scale))
            {
                var results = Capture(window, window.TestStates(), folder, tag);
                pictures += results.Pictures;
                failures += results.Failures;
                report.Append(results.Report);
            }
            if (update) continue;
            var uninstall = new UninstallState { DisplayVersion = template.Info.DisplayVersion, SizeText = "480 MB" };
            using (var window = new UninstallWindow(uninstall, _ => Task.CompletedTask, scale))
            {
                var results = Capture(window, window.TestStates(), folder, $"uninstall-{language}-{(dark ? "dark" : "light")}-{scale * 100:0}");
                pictures += results.Pictures;
                failures += results.Failures;
                report.Append(results.Report);
            }
        }

        var summary = $"Layout check (installer): {pictures} pictures, {failures} failure(s). Folder: {folder}";
        report.AppendLine(summary);
        File.WriteAllText(Path.Combine(folder, "layout-report.txt"), report.ToString(), new UTF8Encoding(false));
        Console.Out.WriteLine(summary);
        return failures == 0 ? 0 : 1;
    }

    private static (int Pictures, int Failures, string Report) Capture(WizardWindow window, IEnumerable<(string Name, Action Show)> states, string folder, string tag)
    {
        var report = new StringBuilder();
        var failures = 0;
        var pictures = 0;
        List<(string Name, Rectangle Bounds)>? failedPage = null;
        List<Rectangle>? frame = null;
        foreach (var (name, show) in states)
        {
            show();
            window.SavePicture(Path.Combine(folder, $"{tag}-{name}.png"));
            pictures++;
            // "Copied" / "Copy not possible" appearing under the error text must not move or resize anything on the page
            if (name == "failed")
            {
                failedPage = Descendants(window).Select(c => (c.Name, c.Bounds)).ToList();
            }
            else if (name.StartsWith("failed-copy", StringComparison.Ordinal) && failedPage is not null
                     && !Descendants(window).Select(c => (c.Name, c.Bounds)).SequenceEqual(failedPage))
            {
                failures++;
                report.AppendLine($"FAIL {tag}-{name}: the copy status moved or resized a control");
            }
            foreach (var finding in Measure(window, name))
            {
                failures++;
                report.AppendLine($"FAIL {tag}-{name}: {finding}");
            }
            var fixedParts = window.Controls.Cast<Control>().Where(c => c.Name is "btnNext" or "content" or "btnClose" or "btnTheme" or "btnMinimize").Select(c => c.Bounds).ToList();
            frame ??= fixedParts;
            if (!fixedParts.SequenceEqual(frame))
            {
                failures++;
                report.AppendLine($"FAIL {tag}-{name}: frame moved");
            }
        }
        return (pictures, failures, report.ToString());
    }

    private static IEnumerable<string> Measure(Control root, string stateName)
    {
        foreach (var control in Descendants(root))
        {
            if (control.Parent is { } parent && parent is not Form && !parent.ClientRectangle.Contains(control.Bounds))
                yield return $"{control.Name} sticks out of {parent.Name}";
            if (control is PcButton button && button.NeededWidth > button.Width)
                yield return $"{button.Name} \"{Shorten(button.Text)}\" needs {button.NeededWidth}px, has {button.Width}px";
            if (control is PcText text && text.Text.Length > 0 && text.NeededHeight > text.Height)
                yield return $"{text.Name} \"{Shorten(text.Text)}\" needs {text.NeededHeight}px, has {text.Height}px";
            if (control is PcFeature feature && feature.NeededHeight > feature.Height)
                yield return $"{feature.Name} \"{Shorten(feature.Text)}\" needs {feature.NeededHeight}px, has {feature.Height}px";
            if (control is PcScrollText scroll && scroll.Name is "txtFolderProblem" && scroll.Overflows && !stateName.Contains("unsafe", StringComparison.Ordinal))
                yield return $"{scroll.Name} scrolls in a normal state";
            // Cards with their own NeededHeight (the uninstall cards and the note row)
            if (control.GetType().GetProperty("NeededHeight") is { PropertyType: var t } property && t == typeof(int)
                && control is not PcText and not PcFeature && (int)property.GetValue(control)! > control.Height)
                yield return $"{control.Name} \"{Shorten(control.Text)}\" needs {(int)property.GetValue(control)!}px, has {control.Height}px";
        }
    }

    private static string Shorten(string text) => text.Length <= 60 ? text : text[..59] + "…";

    private static IEnumerable<Control> Descendants(Control root)
    {
        foreach (Control child in root.Controls)
        {
            yield return child;
            foreach (var grandChild in Descendants(child)) yield return grandChild;
        }
    }
}
