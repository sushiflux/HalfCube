using System.Text;
using HalfCube.Setup.Localization;
using HalfCube.Setup.Ui;

namespace HalfCube.Setup;

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

        failures += CheckAgreementBox(template, report);
        failures += CheckLicenceText(template, folder, report);

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
                NoticeText = template.NoticeText,
                InstallDir = $@"C:\Users\Name\AppData\Local\{ProductInfo.Name}",
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

    /// <summary>
    /// The text of the licence box (licence plus NOTICE) must read as plain text: no Markdown marks are left over, the headings are lines
    /// of their own and the NOTICE follows under its heading. The converted text is written to <c>licence-plain.txt</c> for a look.
    /// </summary>
    private static int CheckLicenceText(SetupState template, string folder, StringBuilder report)
    {
        if (template.LicenceText is not { } licence) return 0;
        var failures = 0;
        var plain = SetupWindow.LicenceWithNotice(licence, template.NoticeText, SetupTexts.NoticeHeading.En);
        File.WriteAllText(Path.Combine(folder, "licence-plain.txt"), plain, new UTF8Encoding(false));
        void Fail(string text)
        {
            failures++;
            report.AppendLine("FAIL licence text: " + text);
        }
        foreach (var mark in new[] { "#", "**", "`", "](", "[", "<http", "\r" })
        {
            if (plain.Contains(mark, StringComparison.Ordinal)) Fail($"the plain text still contains \"{mark}\"");
        }
        if (System.Text.RegularExpressions.Regex.IsMatch(plain, @"<[^<>\s]+>")) Fail("an angle-bracket link is left");
        if (System.Text.RegularExpressions.Regex.IsMatch(plain, @"^\s*(?:=+|-{3,})\s*$", System.Text.RegularExpressions.RegexOptions.Multiline)) Fail("a heading underline is left");
        if (!plain.Contains("\nAcceptance\n", StringComparison.Ordinal) || !plain.Contains("\nNo Liability\n", StringComparison.Ordinal)) Fail("a heading of the licence is not a line of its own");
        if (!plain.Contains("Required Notice: Copyright", StringComparison.Ordinal)) Fail("the Required Notice line is missing");
        if (template.NoticeText is not null && !plain.Contains(SetupTexts.NoticeHeading.En + "\n\n", StringComparison.Ordinal)) Fail("the NOTICE section has no heading");
        if (plain.Contains("\n\n\n", StringComparison.Ordinal)) Fail("more than one blank line in a row");
        return failures;
    }

    /// <summary>
    /// The licence page's agreement box: it is in the tab order and Space toggles it (the key handler runs as it does for a real key
    /// press), "Next" follows it in both directions and a language switch keeps the choice. Its colours reach the contrast the setup
    /// promises (3:1 for the box and the focus ring, 4.5:1 for texts) against the real page in light and dark.
    /// </summary>
    private static int CheckAgreementBox(SetupState template, StringBuilder report)
    {
        var failures = 0;
        void Fail(string text)
        {
            failures++;
            report.AppendLine("FAIL agreement box: " + text);
        }
        foreach (var palette in new[] { Palette.Light, Palette.Dark })
        {
            var mode = palette.IsDark ? "dark" : "light";
            var box = Draw.Contrast(HcCheck.OutlineColor(palette), palette.Page);
            var boxOnFill = Draw.Contrast(HcCheck.OutlineColor(palette), palette.Surface);
            var ticked = Draw.Contrast(palette.Accent, palette.Page);
            var mark = Draw.Contrast(palette.OnAccent, palette.Accent);
            var label = Draw.Contrast(palette.Text, palette.Page);
            var hint = Draw.Contrast(palette.Muted, palette.Page);
            var focus = Draw.Contrast(palette.Focus, palette.Page);
            report.AppendLine($"Agreement box {mode}: outline {box:0.00}:1 on the page and {boxOnFill:0.00}:1 on its fill, ticked box {ticked:0.00}:1, check mark {mark:0.00}:1, label {label:0.00}:1, hint {hint:0.00}:1, focus ring {focus:0.00}:1");
            if (box < 3 || boxOnFill < 3) Fail($"the outline is below 3:1 in {mode} mode");
            if (ticked < 3 || focus < 3) Fail($"the ticked box or the focus ring is below 3:1 in {mode} mode");
            if (mark < 4.5 || label < 4.5 || hint < 4.5) Fail($"a text or the check mark is below 4.5:1 in {mode} mode");
        }

        UiLang.Current = UiLang.English;
        ThemeMode.Set(false);
        var state = new SetupState { Info = template.Info, LicenceText = template.LicenceText, NoticeText = template.NoticeText, InstallDir = $@"C:\Users\Name\AppData\Local\{ProductInfo.Name}" };
        using var window = new SetupWindow(state, (_, _) => Task.CompletedTask, 1f);
        window.GoTo(1);
        var check = Descendants(window).OfType<HcCheck>().SingleOrDefault();
        if (check is null)
        {
            Fail("the licence page has no agreement box");
            return failures;
        }
        if (!check.TabStop) Fail("the box is not in the tab order");
        if (check.AccessibleRole != AccessibleRole.CheckButton) Fail("the box is not a check box for screen readers");
        if (window.Next.Enabled) Fail("\"Next\" is enabled before the licence is agreed");
        void Press(HcCheck target, Keys key) =>
            typeof(Control).GetMethod("OnKeyDown", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.Invoke(target, [new KeyEventArgs(key)]);
        Press(check, Keys.Space);
        if (!check.Checked || !state.LicenceAgreed || !window.Next.Enabled) Fail("Space did not tick the box and enable \"Next\"");
        Press(check, Keys.Enter);
        if (!check.Checked) Fail("Enter toggled the box (only Space may)");
        Press(check, Keys.Space);
        if (check.Checked || state.LicenceAgreed || window.Next.Enabled) Fail("Space did not untick the box and disable \"Next\" again");
        // A rebuild of the page (language or theme switch) keeps the choice
        Press(check, Keys.Space);
        UiLang.Current = UiLang.German;
        var rebuilt = Descendants(window).OfType<HcCheck>().Single();
        if (!rebuilt.Checked || !window.Next.Enabled) Fail("a language switch lost the agreement");
        UiLang.Current = UiLang.English;
        return failures;
    }

    private static (int Pictures, int Failures, string Report) Capture(WizardWindow window, IEnumerable<(string Name, Action Show)> states, string folder, string tag)
    {
        var report = new StringBuilder();
        var failures = 0;
        var pictures = 0;
        List<(string Name, Rectangle Bounds)>? failedPage = null;
        List<(string Name, Rectangle Bounds)>? licencePage = null;
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
            // Ticking the agreement box (and the hint going away) must not move or resize anything on the licence page, and "Next" follows the box
            if (name.StartsWith("licence", StringComparison.Ordinal) && window.CurrentPage.GetType().Name == "LicencePage")
            {
                var agreed = name.Contains("agreed", StringComparison.Ordinal);
                var hint = Descendants(window).FirstOrDefault(c => c.Name == "lblAgreeHint")?.Text ?? string.Empty;
                if (licencePage is null) licencePage = Descendants(window).Select(c => (c.Name, c.Bounds)).ToList();
                else if (!Descendants(window).Select(c => (c.Name, c.Bounds)).SequenceEqual(licencePage))
                {
                    failures++;
                    report.AppendLine($"FAIL {tag}-{name}: the agreement box moved or resized a control");
                }
                if (window.Next.Enabled != agreed)
                {
                    failures++;
                    report.AppendLine($"FAIL {tag}-{name}: \"Next\" is {(window.Next.Enabled ? "enabled" : "disabled")} but the agreement is {(agreed ? "ticked" : "not ticked")}");
                }
                if (agreed == (hint.Length > 0))
                {
                    failures++;
                    report.AppendLine($"FAIL {tag}-{name}: the hint must show exactly while the agreement is not ticked");
                }
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
            if (control is HcButton button && button.NeededWidth > button.Width)
                yield return $"{button.Name} \"{Shorten(button.Text)}\" needs {button.NeededWidth}px, has {button.Width}px";
            if (control is HcText text && text.Text.Length > 0 && text.NeededHeight > text.Height)
                yield return $"{text.Name} \"{Shorten(text.Text)}\" needs {text.NeededHeight}px, has {text.Height}px";
            if (control is HcFeature feature && feature.NeededHeight > feature.Height)
                yield return $"{feature.Name} \"{Shorten(feature.Text)}\" needs {feature.NeededHeight}px, has {feature.Height}px";
            if (control is HcScrollText scroll && scroll.Name is "txtFolderProblem" && scroll.Overflows && !stateName.Contains("unsafe", StringComparison.Ordinal))
                yield return $"{scroll.Name} scrolls in a normal state";
            // Cards with their own NeededHeight (the uninstall cards and the note row)
            if (control.GetType().GetProperty("NeededHeight") is { PropertyType: var t } property && t == typeof(int)
                && control is not HcText and not HcFeature && (int)property.GetValue(control)! > control.Height)
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
